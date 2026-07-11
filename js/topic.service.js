/* ═══════════════════════════════════════════════
   EXPOSÉ — topic.service.js  (v2: Supabase Postgres)
   All topic, subtopic, and search log operations.

   v2: localStorage replaced with the Supabase `topics` and
   `search_log` tables (see supabase/schema.sql). Same public API
   as v1 — kanban.js, topic-overlay.js, and dashboard.js are
   untouched. Row Level Security scopes every query to the
   signed-in user, so no user_id handling is needed here.

   Shape notes:
   - Subtopics stay embedded as JSONB on the topic row (they are
     regenerated wholesale every refresh; a child table buys races,
     not value, at this scale).
   - `status` / `errorMessage` are TRANSIENT UI state: never written
     to the database, merged onto returned topics in-memory.
   - Board order: `position` ascending. New topics get -Date.now()
     so they sort first without an extra round-trip.
   - The search log keeps a 30-entry device cache in localStorage so
     SidebarLog can keep rendering synchronously.
   ═══════════════════════════════════════════════ */

const TopicService = (() => {
  const LOG_CACHE_KEY = 'expose_search_log_v1';

  /* ── Helpers ── */
  function uid() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : '_' + Math.random().toString(36).slice(2, 10);
  }
  // Subtopic cap: default 3, clamped to 2–6
  function clampSubs(n) {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.max(2, Math.min(6, v)) : 3;
  }
  // Normalize a subtopic name for the dismissal blocklist (ids regenerate each
  // refresh, so dismissal must key on the stable name instead).
  function normName(s) { return String(s || '').trim().toLowerCase(); }

  const EMPTY_SOURCES = () => ({ web: [], rss: [], youtube: [], reddit: [] });

  /* ── Row ↔ client shape mapping ── */
  function rowToTopic(r) {
    return {
      id:                  r.id,
      name:                r.name,
      sources:             r.sources || EMPTY_SOURCES(),
      strictMode:          !!r.strict_mode,
      maxSubtopics:        r.max_subtopics,
      allSourcesEnabled:   !!r.all_sources_enabled,
      dismissedSubtopics:  r.dismissed_subtopics || [],
      pinned:              !!r.pinned,
      paused:              !!r.paused,
      sourceRotationOffset:r.source_rotation_offset || 0,
      createdAt:           r.created_at,
      updatedAt:           r.updated_at,
      refreshedAt:         r.refreshed_at,
      heatScore:           r.heat_score || 0,
      subtopics:           r.subtopics || [],
      status:              'idle', // transient — never trust a stale value
    };
  }

  // Client field → column. status/errorMessage are deliberately absent.
  const FIELD_TO_COL = {
    name:                 'name',
    sources:              'sources',
    strictMode:           'strict_mode',
    maxSubtopics:         'max_subtopics',
    allSourcesEnabled:    'all_sources_enabled',
    dismissedSubtopics:   'dismissed_subtopics',
    pinned:               'pinned',
    paused:               'paused',
    position:             'position',
    sourceRotationOffset: 'source_rotation_offset',
    heatScore:            'heat_score',
    subtopics:            'subtopics',
  };

  function dataToPatch(data) {
    const patch = {};
    for (const [key, col] of Object.entries(FIELD_TO_COL)) {
      if (key in data) patch[col] = key === 'maxSubtopics' ? clampSubs(data[key]) : data[key];
    }
    return patch;
  }

  async function fetchRow(id) {
    const { data, error } = await sb.from('topics').select('*').eq('id', id).single();
    return error ? null : data;
  }

  /* ════════════════════════════════
     TOPICS
  ════════════════════════════════ */

  async function getTopics() {
    const { data, error } = await sb.from('topics')
      .select('*')
      .order('position', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) { console.warn('[Exposé] getTopics failed:', error.message); return []; }
    return (data || []).map(rowToTopic);
  }

  async function createTopic(data) {
    // data: { name, sources, strictMode, maxSubtopics, allSourcesEnabled }
    const row = {
      name:                String(data.name || '').trim(),
      sources:             data.sources || EMPTY_SOURCES(),
      strict_mode:         !!data.strictMode,
      max_subtopics:       clampSubs(data.maxSubtopics),
      all_sources_enabled: !!data.allSourcesEnabled,
      dismissed_subtopics: [],
      pinned:              false,
      paused:              false,
      position:            -Date.now(), // most negative = newest = first on the board
      heat_score:          0,
      subtopics:           [],
    };
    const { data: inserted, error } = await sb.from('topics').insert(row).select().single();
    if (error) return { success: false, error: error.message };
    return { success: true, topic: rowToTopic(inserted) };
  }

  async function updateTopic(id, data) {
    // data: partial topic fields to update (transient fields are kept in-memory only)
    const patch = dataToPatch(data);

    let row;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { data: updated, error } = await sb.from('topics')
        .update(patch).eq('id', id).select().single();
      if (error) return { success: false, error: error.message };
      row = updated;
    } else {
      // Transient-only update (e.g. { status: 'fetching' }) — nothing to persist.
      row = await fetchRow(id);
      if (!row) return { success: false, error: 'Topic not found' };
    }

    const topic = rowToTopic(row);
    if ('status' in data)       topic.status = data.status;
    if ('errorMessage' in data) topic.errorMessage = data.errorMessage;
    return { success: true, topic };
  }

  async function deleteTopic(id) {
    const { error } = await sb.from('topics').delete().eq('id', id);
    if (error) return { success: false, error: error.message };
    return { success: true };
  }

  async function pinTopic(id, pinned) {
    return updateTopic(id, { pinned });
  }

  async function reorderTopics(orderedIds) {
    // Called after drag-and-drop reorder — rewrite positions 0..n-1.
    const now = new Date().toISOString();
    const results = await Promise.all(orderedIds.map((id, i) =>
      sb.from('topics').update({ position: i, updated_at: now }).eq('id', id)
    ));
    const failed = results.find(r => r.error);
    if (failed) return { success: false, error: failed.error.message };
    return { success: true };
  }

  /* ════════════════════════════════
     SUBTOPICS
     (read-modify-write on the topic row's JSONB)
  ════════════════════════════════ */

  async function setSubtopics(topicId, subtopics) {
    // Called after Gemini returns data for a topic
    const row = await fetchRow(topicId);
    if (!row) return { success: false };
    const now = new Date().toISOString();

    // Merge with existing — preserve user renames and pinned state
    const existing = Object.fromEntries((row.subtopics || []).map(s => [s.id, s]));
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
        sources:     s.sources || EMPTY_SOURCES(),
        broadSources:s.broadSources || [],
        viewed:      prev.viewed || false,
        pinned:      prev.pinned || false,
        expired:     false,
        createdAt:   prev.createdAt || now,
        updatedAt:   now,
      };
    });

    // Drop user-dismissed subtopics so they never come back on regeneration.
    const dismissed = new Set((row.dismissed_subtopics || []).map(normName));
    const kept = dismissed.size
      ? merged.filter(s => !dismissed.has(normName(s.name)))
      : merged;

    // Expire subtopics not seen for 7 days
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const expiredOld = (row.subtopics || []).filter(s => {
      const notInNew = !kept.find(m => m.id === s.id);
      const old = new Date(s.updatedAt).getTime() < weekAgo;
      return notInNew && old;
    }).map(s => ({ ...s, expired: true }));

    const patch = {
      subtopics:  [...kept, ...expiredOld],
      updated_at: now,
      heat_score: calcHeatScore(kept),
    };
    const { data: updated, error } = await sb.from('topics')
      .update(patch).eq('id', topicId).select().single();
    if (error) return { success: false, error: error.message };
    return { success: true, topic: rowToTopic(updated) };
  }

  async function patchSubtopics(topicId, mutate) {
    // Shared read-modify-write for the small per-subtopic operations below.
    const row = await fetchRow(topicId);
    if (!row) return { success: false };
    const result = mutate(row) || {};
    const { data: updated, error } = await sb.from('topics')
      .update({
        subtopics: row.subtopics,
        ...(result.extraPatch || {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', topicId).select().single();
    if (error) return { success: false, error: error.message };
    return { success: true, topic: rowToTopic(updated), ...result.extra };
  }

  async function renameSubtopic(topicId, subtopicId, name) {
    return patchSubtopics(topicId, row => {
      const sub = (row.subtopics || []).find(s => s.id === subtopicId);
      if (!sub) return;
      sub.name        = name;
      sub.userRenamed = true;
      sub.updatedAt   = new Date().toISOString();
    });
  }

  async function deleteSubtopic(topicId, subtopicId) {
    return patchSubtopics(topicId, row => {
      row.subtopics = (row.subtopics || []).filter(s => s.id !== subtopicId);
    });
  }

  // Permanently remove a single subtopic: drop it now AND blocklist its name so
  // regeneration (setSubtopics) won't bring it back. Topic + other subtopics stay.
  async function dismissSubtopic(topicId, subtopicId) {
    return patchSubtopics(topicId, row => {
      const sub = (row.subtopics || []).find(s => s.id === subtopicId);
      const key = normName(sub?.name);
      const list = row.dismissed_subtopics || [];
      if (key && !list.map(normName).includes(key)) list.push(key);
      row.dismissed_subtopics = list;
      row.subtopics = (row.subtopics || []).filter(s => s.id !== subtopicId);
      return { extraPatch: { dismissed_subtopics: list } };
    });
  }

  async function markViewed(topicId, subtopicId) {
    return patchSubtopics(topicId, row => {
      const sub = (row.subtopics || []).find(s => s.id === subtopicId);
      if (sub) { sub.viewed = true; sub.updatedAt = new Date().toISOString(); }
    });
  }

  async function pinSubtopic(topicId, subtopicId, pinned) {
    return patchSubtopics(topicId, row => {
      const sub = (row.subtopics || []).find(s => s.id === subtopicId);
      if (!sub) return;
      sub.pinned    = pinned;
      sub.updatedAt = new Date().toISOString();
    });
  }

  async function dismissTombstone(topicId, subtopicId) {
    return deleteSubtopic(topicId, subtopicId);
  }

  /* ════════════════════════════════
     SEARCH LOG
  ════════════════════════════════ */

  function cacheLog(entries) {
    try { localStorage.setItem(LOG_CACHE_KEY, JSON.stringify(entries.slice(0, 30))); } catch {}
  }
  function readLogCache() {
    try { return JSON.parse(localStorage.getItem(LOG_CACHE_KEY)) || []; } catch { return []; }
  }

  function logRowToEntry(r) {
    return {
      id:        r.id,
      query:     r.query,
      topicId:   r.topic_id,
      topicName: r.topic_name,
      results:   r.results || 0,
      createdAt: r.created_at,
    };
  }

  async function getSearchLog() {
    const { data, error } = await sb.from('search_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) { console.warn('[Exposé] getSearchLog failed:', error.message); return readLogCache(); }
    const entries = (data || []).map(logRowToEntry);
    cacheLog(entries);
    return entries;
  }

  async function appendLog(entry) {
    // entry: { query, topicId, topicName, resultsCount }
    const row = {
      query:      entry.query,
      topic_id:   entry.topicId || '',
      topic_name: entry.topicName || '',
      results:    entry.resultsCount || 0,
    };
    const { data, error } = await sb.from('search_log').insert(row).select().single();
    const record = error
      ? { id: uid(), query: row.query, topicId: row.topic_id, topicName: row.topic_name, results: row.results, createdAt: new Date().toISOString() }
      : logRowToEntry(data);
    cacheLog([record, ...readLogCache()]);
    return { success: !error, entry: record };
  }

  async function clearLog() {
    cacheLog([]);
    const user = AuthService.getUser();
    if (user) {
      const { error } = await sb.from('search_log').delete().eq('user_id', user.id);
      if (error) return { success: false, error: error.message };
    }
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
    dismissSubtopic,
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
