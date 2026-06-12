/* ═══════════════════════════════════════════════
   EXPOSÉ — gemini.service.js  (v3: feed-first pipeline)

   ARCHITECTURE CHANGE FROM v2:
   v2 asked Gemini (with Google Search grounding) to both FIND
   sources and ORGANIZE them. That coupling caused hallucinated
   URLs and wrong-article links, and burned grounded-request quota.

   v3 splits the jobs:
     1. FETCH  — real items come from the Exposé Cloudflare Worker
                 (Google News RSS per source + Reddit best-effort).
                 Every URL originates from a live feed.
     2. CLUSTER — Gemini (NO tools, NO grounding) only groups the
                 fetched items by ID. It never sees or emits URLs.
                 Returned IDs are validated against the fetched set,
                 so hallucinated/mismatched links are impossible.

   Kept from v2 (same public contract — kanban.js unchanged):
     - fetchSubtopics(topic) → { success, subtopics, fromCache }
     - subtopic shape: { id, name, summary, score, sourceCount,
       sources: { x, reddit, web }, broadSources, groundingChunks }
       (x is always [] — X support removed. groundingChunks is
       always [] — kanban renders nothing for both. No UI edits.)
     - 30-minute cache guard, source rotation, MAX_SUBTOPICS = 3,
       MAX_SOURCES = 6, query logging via TopicService.appendLog.

   LINK FORMAT NOTE (why urlResolved is usually false):
   Google fully migrated News links to a locked format that can
   only be resolved via their internal batchexecute endpoint,
   which heavily rate-limits (429) server-side callers. We keep
   Google's redirect links — they open the correct article — and
   display the clean publisher name from the feed's <source> tag.

   DEPLOYMENT NOTES:
   1. WORKER: PROXY below must match your deployed Worker URL.
   2. MODEL: gemini-2.5-flash-lite, text-only. No grounded-request
      quota consumed at all now; token use per refresh is small
      (one call, ~1200 max output tokens, no URLs in output).
   3. API KEY: unchanged — localStorage expose_settings_v1.
   4. MIGRATION: _fetchItems() moves server-side as-is later;
      _callGemini() swaps to a proxy endpoint. Contract stable.
   ═══════════════════════════════════════════════ */

const GeminiService = (() => {

  const PROXY         = 'https://expose-proxy.pbeckman731.workers.dev';
  const MODEL         = 'gemini-2.5-flash-lite';
  const API_URL       = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const MAX_SOURCES   = 6;    // hard cap on total sources per subtopic
  const MAX_SUBTOPICS = 3;    // fixed subtopic count per refresh
  const CACHE_MINUTES = 30;   // skip fetch if data is fresher than this
  const RECENCY       = '3d'; // feed window — matches v2's "last 72h"
  const PER_QUERY     = 8;    // items requested per source query
  const MAX_ITEMS     = 30;   // total item pool sent to clustering

  /* ── Get API key ── */
  function getApiKey() {
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      return s.geminiApiKey || '';
    } catch { return ''; }
  }

  /* ── Get settings ── */
  function _getSettings() {
    try { return JSON.parse(localStorage.getItem('expose_settings_v1')) || {}; } catch { return {}; }
  }

  /* ════════════════════════════════════════════
     STAGE 1 — FETCH real items via the Worker
  ════════════════════════════════════════════ */

  function _newsUrl(q) {
    return `${PROXY}/?type=news&q=${encodeURIComponent(q)}&when=${RECENCY}&limit=${PER_QUERY}`;
  }

  /* Build one Worker request per rotated source.
     web domains → Google News site: query
     reddit subs → Worker's reddit endpoint
     x handles   → skipped (X support removed)            */
  function _buildPlans(topicName, rotated, includeBroad) {
    const plans = [];
    (rotated.web || []).forEach(domain => {
      const d = String(domain).trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (d) plans.push({ label: d, kind: 'news', query: `${topicName} site:${d}`,
                          url: _newsUrl(`${topicName} site:${d}`) });
    });
    (rotated.reddit || []).forEach(sub => {
      const s = String(sub).trim().replace(/^\/+/, '').replace(/^r\//i, '').replace(/\/+$/, '');
      if (s) plans.push({ label: `r/${s}`, kind: 'reddit', query: `r/${s}`,
                          url: `${PROXY}/?type=reddit&sub=${encodeURIComponent(s)}&limit=${PER_QUERY}` });
    });
    if (includeBroad || plans.length === 0) {
      plans.push({ label: '(broad search)', kind: 'news', query: topicName,
                   url: _newsUrl(topicName) });
    }
    return plans;
  }

  async function _fetchItems(topicName, rotated, includeBroad) {
    const plans = _buildPlans(topicName, rotated, includeBroad);

    const results = await Promise.allSettled(
      plans.map(p => fetch(p.url).then(r => r.json()))
    );

    const sourceReport = [];
    const queriesUsed  = [];
    let   all          = [];
    let   redditFellBack = false;

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const body = results[i].status === 'fulfilled' ? results[i].value : null;
      queriesUsed.push(plan.query);

      if (body && body.ok) {
        sourceReport.push({ source: plan.label, status: 'ok', count: body.items.length });
        all = all.concat(body.items);
        continue;
      }

      const reason = body ? body.error : 'network_error';
      sourceReport.push({ source: plan.label, status: reason, count: 0 });

      // Reddit blocked → one thin fallback through Google's index.
      if (plan.kind === 'reddit' && !redditFellBack) {
        redditFellBack = true;
        try {
          const fb = await fetch(_newsUrl(`${topicName} site:reddit.com`)).then(r => r.json());
          if (fb.ok && fb.items.length) {
            fb.items.forEach(it => { if (!it.source) it.source = 'reddit (via Google)'; });
            all = all.concat(fb.items);
            sourceReport.push({ source: 'reddit (via Google)', status: 'fallback', count: fb.items.length });
          }
        } catch { /* fallback is best-effort by definition */ }
      }
    }

    // Dedupe (same story arrives via multiple queries), newest first, cap.
    const seen  = new Set();
    const items = [];
    all.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    for (const it of all) {
      const key = it.urlResolved && it.url
        ? it.url
        : String(it.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
      if (items.length >= MAX_ITEMS) break;
    }
    items.forEach((it, idx) => { it.poolId = 'n' + (idx + 1); });

    return { items, sourceReport, queriesUsed };
  }

  /* ════════════════════════════════════════════
     STAGE 2 — CLUSTER items with Gemini (text-only)
  ════════════════════════════════════════════ */

  async function _callGemini(prompt) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:      0.2,  // no grounding requirement anymore — low temp = stable JSON
        maxOutputTokens:  1200, // small now: no URLs in the output (was 2600)
        thinkingConfig:   { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
      // NOTE: no `tools` — grounding removed on purpose. The model
      // must never search; it only organizes what we fetched.
    };

    const res = await fetch(`${API_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;
      if (res.status === 429) throw new Error('QUOTA_EXCEEDED');
      if (res.status === 400) throw new Error(`BAD_REQUEST: ${msg}`);
      if (res.status === 403) throw new Error('INVALID_API_KEY');
      throw new Error(msg);
    }

    const data      = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No response from Gemini');

    // Keep the duplicate-parts guard from v2: take the first part
    // containing a JSON block rather than concatenating all parts.
    const parts     = candidate.content?.parts || [];
    const firstJSON = parts.find(p => p.text && (p.text.includes('{') || p.text.includes('[')));
    return firstJSON?.text || parts.find(p => p.text)?.text || '';
  }

  /* ── Strip markdown fences and parse JSON (kept from v2;
        responseMimeType makes fences rare but not impossible) ── */
  function _extractJSON(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
    const raw = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (raw)   { try { return JSON.parse(raw[1]); } catch {} }
    try { return JSON.parse(text.trim()); } catch {}
    return null;
  }

  function _clusterPrompt(topicName, items) {
    const lines = items.map(it => {
      const date = (it.publishedAt || '').slice(0, 10);
      const snip = it.snippet ? ` | ${it.snippet.slice(0, 150)}` : '';
      return `${it.poolId} | ${it.source || it.sourceDomain || 'web'} | ${date} | ${it.title}${snip}`;
    }).join('\n');

    return `You are organizing OSINT monitoring results for the topic: "${topicName}".
Below is a numbered list of real items fetched from live feeds.
Each line: ID | source | date | title | optional snippet.

${lines}

Group these into at most ${MAX_SUBTOPICS} emerging subtopics (distinct stories or developments).

Rules:
- Respond with ONLY valid JSON. No markdown, no commentary, no code fences.
- Schema: {"subtopics":[{"name":"max 8 word title","summary":"1-2 factual sentences","score":85,"itemIds":["n1","n3"]}]}
- score: 0-100 significance/urgency of the subtopic for this monitoring topic.
- itemIds MUST be IDs from the list above. Never invent IDs. Never include URLs anywhere.
- Prefer subtopics supported by 2 or more items. Ignore items that fit nowhere.`;
  }

  /* ── Bucket validated items into the kanban source shape ──
     reddit items → sources.reddit, everything else → sources.web,
     sources.x stays [] (kanban skips empty groups). Caps at
     MAX_SOURCES total: up to 2 reddit, remainder web.            */
  function _toSourceBuckets(linkedItems) {
    const isReddit = it => it.sourceDomain === 'reddit.com' || /^r\//i.test(it.source || '');
    const art = it => ({
      title:       it.title,
      source:      it.source || it.sourceDomain || 'web',
      url:         it.url || '',
      publishedAt: it.publishedAt || '',
    });
    const reddit = linkedItems.filter(isReddit).slice(0, 2).map(art);
    const web    = linkedItems.filter(it => !isReddit(it)).slice(0, MAX_SOURCES - reddit.length).map(art);
    return { x: [], reddit, web };
  }

  /* ════════════════════════════════════════════
     MAIN EXPORT: fetchSubtopics
     Called by kanban.js on each topic refresh.
     Contract identical to v2.
  ════════════════════════════════════════════ */
  async function fetchSubtopics(topic) {
    if (!getApiKey()) {
      return {
        success: false,
        error:   'NO_API_KEY',
        message: 'Add your Gemini API key in Settings → Intelligence.',
      };
    }

    /* ── 30-minute cache guard ── */
    const lastUpdated = topic.updatedAt ? new Date(topic.updatedAt).getTime() : 0;
    const ageMinutes  = (Date.now() - lastUpdated) / 60000;
    if (ageMinutes < CACHE_MINUTES && (topic.subtopics || []).length > 0) {
      return { success: true, subtopics: topic.subtopics, fromCache: true };
    }

    /* ── Rotate sources, increment offset (X sources dropped) ── */
    const offset  = topic.sourceRotationOffset || 0;
    const rotated = _getRotatedSources(topic.sources || {}, offset);
    TopicService.updateTopic(topic.id, { sourceRotationOffset: offset + 1 });

    const settings     = _getSettings();
    const expandTopics = settings.expandTopics !== false;

    /* ── STAGE 1: fetch real items ── */
    let fetched;
    try {
      fetched = await _fetchItems(topic.name, rotated, expandTopics);
    } catch (err) {
      return { success: false, error: 'PROXY_ERROR', message: _friendlyError('PROXY_ERROR') };
    }
    const { items, sourceReport, queriesUsed } = fetched;
    console.debug('[Exposé] source report:', sourceReport);

    if (items.length === 0) {
      const dead = sourceReport.filter(r => r.count === 0).map(r => `${r.source} (${r.status})`).join(', ');
      return {
        success: false,
        error:   'NO_RESULTS',
        message: `No items found in the last 72h. Per source: ${dead || 'no sources configured'}.`,
      };
    }

    /* ── STAGE 2: cluster by ID ── */
    let text;
    try {
      text = await _callGemini(_clusterPrompt(topic.name, items));
    } catch (err) {
      return { success: false, error: err.message, message: _friendlyError(err.message) };
    }

    const parsed = _extractJSON(text || '');
    if (!parsed?.subtopics?.length) {
      return {
        success: false,
        error:   'PARSE_ERROR',
        message: 'Could not parse Gemini response. Try refreshing.',
      };
    }

    /* ── Validate IDs against the fetched pool (the hallucination wall),
          bucket into kanban shape, sort, cap. ── */
    const byId  = new Map(items.map(it => [it.poolId, it]));
    const stamp = Date.now().toString(36);

    const subtopics = parsed.subtopics
      .map((st, i) => {
        const linked = (st.itemIds || []).map(id => byId.get(id)).filter(Boolean);
        if (!st.name || linked.length === 0) return null;
        const sources = _toSourceBuckets(linked);
        return {
          id:              `s_${stamp}_${i + 1}`, // unique per refresh — avoids DOM id collisions across topics
          name:            String(st.name),
          summary:         String(st.summary || ''),
          score:           Number.isFinite(st.score) ? st.score : 50,
          sources,
          sourceCount:     sources.reddit.length + sources.web.length,
          broadSources:    [],
          groundingChunks: [], // grounding removed — kanban renders nothing for []
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, MAX_SUBTOPICS);

    if (subtopics.length === 0) {
      return {
        success: false,
        error:   'PARSE_ERROR',
        message: 'Gemini returned no valid subtopics. Try refreshing.',
      };
    }

    /* ── Optional broad panel (allSourcesEnabled) — items beyond the
          subtopics' own sources, from the broad query, top 4. ── */
    if (topic.allSourcesEnabled) {
      const usedTitles = new Set(
        subtopics.flatMap(s => [...s.sources.reddit, ...s.sources.web]).map(a => a.title)
      );
      subtopics[0].broadSources = items
        .filter(it => !usedTitles.has(it.title))
        .slice(0, 4)
        .map(it => ({ title: it.title, source: it.source || it.sourceDomain || 'web', url: it.url || '' }));
    }

    /* ── Log queries (cap at 3 per refresh, matching v2) ── */
    for (const q of queriesUsed.slice(0, 3)) {
      await TopicService.appendLog({
        query:        q,
        topicId:      topic.id,
        topicName:    topic.name,
        resultsCount: subtopics.length,
      });
    }

    return {
      success:   true,
      subtopics,
      fromCache: false,
    };
  }

  /* ── Source rotation (kept from v2, X filtered out) ──
     Distributes MAX_SOURCES query slots across the user's
     reddit + web sources, rotating the window each refresh
     so every source gets coverage over time.              */
  function _getRotatedSources(sources, offset) {
    const reddit = sources.reddit || [];
    const web    = sources.web    || [];
    const total  = reddit.length + web.length;

    if (total <= MAX_SOURCES) return { reddit, web };

    const all = [
      ...reddit.map(v => ({ type: 'reddit', value: v })),
      ...web.map(v    => ({ type: 'web',    value: v })),
    ];

    const start  = offset % total;
    const window = [];
    for (let i = 0; i < MAX_SOURCES; i++) {
      window.push(all[(start + i) % total]);
    }

    return {
      reddit: window.filter(s => s.type === 'reddit').map(s => s.value),
      web:    window.filter(s => s.type === 'web').map(s => s.value),
    };
  }

  /* ── Human-readable error messages ── */
  function _friendlyError(code) {
    const map = {
      NO_API_KEY:     'Add your Gemini API key in Settings → Intelligence.',
      QUOTA_EXCEEDED: 'Daily quota reached. Check usage at aistudio.google.com.',
      INVALID_API_KEY:'API key rejected. Check Settings → Intelligence.',
      EMPTY_RESPONSE: 'Gemini returned no results — try again.',
      PARSE_ERROR:    'Could not parse response. Try refreshing.',
      PROXY_ERROR:    'Could not reach the Exposé proxy. Check the Worker is deployed.',
      NO_RESULTS:     'No recent items found from the configured sources.',
    };
    return map[code] || `Gemini error: ${code}`;
  }

  return { fetchSubtopics, getApiKey };
})();

window.GeminiService = GeminiService;
