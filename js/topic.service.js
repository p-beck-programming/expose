/* ═══════════════════════════════════════════════
   EXPOSÉ — topic.service.js
   All topic, subtopic, and search log operations.

   Deployment note:
   - Imported by kanban.js and dashboard.js
   - All methods are async to mirror real API calls
   - To migrate to a real backend, replace the
     localStorage logic inside each method with
     a fetch() call to your API endpoint.
     No calling code needs to change.

   Migration map:
     getTopics()           → GET  /api/topics
     createTopic(data)     → POST /api/topics
     updateTopic(id, data) → PATCH /api/topics/:id
     deleteTopic(id)       → DELETE /api/topics/:id
     getSubtopics(topicId) → GET /api/topics/:id/subtopics
     markViewed(id)        → PATCH /api/subtopics/:id/viewed
     pinSubtopic(id)       → PATCH /api/subtopics/:id/pin
     getSearchLog()        → GET /api/search-log
     appendLog(entry)      → POST /api/search-log
   ═══════════════════════════════════════════════ */

const TopicService = (() => {
  const TOPICS_KEY = 'expose_topics_v1';
  const LOG_KEY    = 'expose_search_log_v1';

  /* ── Internal helpers ── */
  function readTopics() {
    try { return JSON.parse(localStorage.getItem(TOPICS_KEY)) || []; } catch { return []; }
  }
  function writeTopics(topics) {
    localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
  }
  function readLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { return []; }
  }
  function writeLog(log) {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function uid() { return '_' + Math.random().toString(36).slice(2, 10); }

  /* ════════════════════════════════
     TOPICS
  ════════════════════════════════ */

  async function getTopics() {
    // → GET /api/topics
    return readTopics();
  }

  async function createTopic(data) {
    // → POST /api/topics
    // data: { name, sources, allSourcesEnabled }
    await delay(300);
    const topics = readTopics();
    const topic = {
      id:               uid(),
      name:             data.name,
      sources:          data.sources || { x: [], reddit: [], web: [] },
      allSourcesEnabled:!!data.allSourcesEnabled,
      pinned:           false,
      createdAt:        new Date().toISOString(),
      updatedAt:        new Date().toISOString(),
      heatScore:        0,
      subtopics:        [],
      status:           'idle', // idle | fetching | error
    };
    topics.unshift(topic);
    writeTopics(topics);
    return { success: true, topic };
  }

  async function updateTopic(id, data) {
    // → PATCH /api/topics/:id
    // data: partial topic fields to update
    const topics = readTopics();
    const idx = topics.findIndex(t => t.id === id);
    if (idx === -1) return { success: false, error: 'Topic not found' };
    topics[idx] = { ...topics[idx], ...data, updatedAt: new Date().toISOString() };
    writeTopics(topics);
    return { success: true, topic: topics[idx] };
  }

  async function deleteTopic(id) {
    // → DELETE /api/topics/:id
    const topics = readTopics().filter(t => t.id !== id);
    writeTopics(topics);
    return { success: true };
  }

  async function pinTopic(id, pinned) {
    return updateTopic(id, { pinned });
  }

  async function reorderTopics(orderedIds) {
    // Called after drag-and-drop reorder
    // → PATCH /api/topics/reorder  { ids: [...] }
    const topics = readTopics();
    const map = Object.fromEntries(topics.map(t => [t.id, t]));
    const reordered = orderedIds.map(id => map[id]).filter(Boolean);
    // Append any topics not in orderedIds (safety)
    topics.forEach(t => { if (!orderedIds.includes(t.id)) reordered.push(t); });
    writeTopics(reordered);
    return { success: true };
  }

  /* ════════════════════════════════
     SUBTOPICS
  ════════════════════════════════ */

  async function setSubtopics(topicId, subtopics) {
    // Called after Gemini returns data for a topic
    // → PUT /api/topics/:id/subtopics
    const topics = readTopics();
    const idx = topics.findIndex(t => t.id === topicId);
    if (idx === -1) return { success: false };
    const now = new Date().toISOString();

    // Merge with existing — preserve user renames and pinned state
    const existing = Object.fromEntries((topics[idx].subtopics || []).map(s => [s.id, s]));
    const merged = subtopics.map(s => {
      const prev = existing[s.id] || {};
      return {
        id:          s.id || uid(),
        topicId,
        name:        prev.userRenamed ? prev.name : s.name, // keep user renames
        userRenamed: prev.userRenamed || false,
        summary:     s.summary,
        score:       s.score,
        sourceCount: s.sourceCount,
        sources:     s.sources || { x: [], reddit: [], web: [] },
        broadSources:s.broadSources || [],
        viewed:      prev.viewed || false,
        pinned:      prev.pinned || false,
        expired:     false,
        createdAt:   prev.createdAt || now,
        updatedAt:   now,
      };
    });

    // Expire subtopics not seen for 7 days
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const expiredOld = (topics[idx].subtopics || []).filter(s => {
      const notInNew = !merged.find(m => m.id === s.id);
      const old = new Date(s.updatedAt).getTime() < weekAgo;
      return notInNew && old;
    }).map(s => ({ ...s, expired: true }));

    topics[idx].subtopics  = [...merged, ...expiredOld];
    topics[idx].updatedAt  = now;
    topics[idx].status     = 'idle';
    topics[idx].heatScore  = calcHeatScore(merged);

    writeTopics(topics);
    return { success: true, topic: topics[idx] };
  }

  async function renameSubtopic(topicId, subtopicId, name) {
    // → PATCH /api/subtopics/:id  { name }
    const topics = readTopics();
    const topic  = topics.find(t => t.id === topicId);
    if (!topic) return { success: false };
    const sub = topic.subtopics.find(s => s.id === subtopicId);
    if (!sub) return { success: false };
    sub.name        = name;
    sub.userRenamed = true;
    sub.updatedAt   = new Date().toISOString();
    writeTopics(topics);
    return { success: true };
  }

  async function deleteSubtopic(topicId, subtopicId) {
    // → DELETE /api/subtopics/:id
    const topics = readTopics();
    const topic  = topics.find(t => t.id === topicId);
    if (!topic) return { success: false };
    topic.subtopics = topic.subtopics.filter(s => s.id !== subtopicId);
    writeTopics(topics);
    return { success: true };
  }

  async function markViewed(topicId, subtopicId) {
    // → PATCH /api/subtopics/:id/viewed
    const topics = readTopics();
    const topic  = topics.find(t => t.id === topicId);
    if (!topic) return;
    const sub = topic.subtopics.find(s => s.id === subtopicId);
    if (sub) { sub.viewed = true; sub.updatedAt = new Date().toISOString(); }
    writeTopics(topics);
  }

  async function pinSubtopic(topicId, subtopicId, pinned) {
    // → PATCH /api/subtopics/:id/pin
    const topics = readTopics();
    const topic  = topics.find(t => t.id === topicId);
    if (!topic) return { success: false };
    const sub = topic.subtopics.find(s => s.id === subtopicId);
    if (!sub) return { success: false };
    sub.pinned    = pinned;
    sub.updatedAt = new Date().toISOString();
    writeTopics(topics);
    return { success: true };
  }

  async function dismissTombstone(topicId, subtopicId) {
    return deleteSubtopic(topicId, subtopicId);
  }

  /* ════════════════════════════════
     SEARCH LOG
  ════════════════════════════════ */

  async function getSearchLog() {
    // → GET /api/search-log
    return readLog();
  }

  async function appendLog(entry) {
    // → POST /api/search-log
    // entry: { query, topicId, topicName, resultsCount }
    const log = readLog();
    const record = {
      id:        uid(),
      query:     entry.query,
      topicId:   entry.topicId,
      topicName: entry.topicName,
      results:   entry.resultsCount || 0,
      createdAt: new Date().toISOString(),
    };
    log.unshift(record); // newest first
    if (log.length > 100) log.splice(100); // cap at 100 entries
    writeLog(log);
    return { success: true, entry: record };
  }

  async function clearLog() {
    // → DELETE /api/search-log
    writeLog([]);
    return { success: true };
  }

  /* ════════════════════════════════
     HELPERS
  ════════════════════════════════ */

  // Heat score: new subtopics per day, scaled 0–5 dots
  function calcHeatScore(subtopics) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = subtopics.filter(s => new Date(s.createdAt).getTime() > dayAgo).length;
    return Math.min(5, recent);
  }

  function getUnviewedCount(topic) {
    return (topic.subtopics || []).filter(s => !s.viewed && !s.expired && !s.pinned).length;
  }

  function getPinnedSubtopics(topics) {
    const pinned = [];
    topics.forEach(topic => {
      (topic.subtopics || []).forEach(s => {
        if (s.pinned) pinned.push({ ...s, _topicName: topic.name, _topicId: topic.id });
      });
    });
    return pinned;
  }

  /* ── Public API ── */
  return {
    getTopics,
    createTopic,
    updateTopic,
    deleteTopic,
    pinTopic,
    reorderTopics,
    setSubtopics,
    renameSubtopic,
    deleteSubtopic,
    markViewed,
    pinSubtopic,
    dismissTombstone,
    getSearchLog,
    appendLog,
    clearLog,
    getUnviewedCount,
    getPinnedSubtopics,
    calcHeatScore,
  };
})();

window.TopicService = TopicService;
