/* ═══════════════════════════════════════════════
   EXPOSÉ — gemini.service.js

   Single-pass approach (optimization 1):
   One API call searches, reads, and returns
   structured subtopics. No second pass needed.

   Optimizations applied:
     1. Single pass — halves API call count
     2. maxOutputTokens: 2600 (flash-lite needs ~2400 for 3 subtopics).
      thinkingConfig.thinkingBudget: 0 disables chain-of-thought.
      Do not set both thinkingBudget and thinkingLevel — 400 error.
     3. Tighter, directive prompt language
     4. Fixed at exactly 3 subtopics per refresh
     5. 6 total sources per subtopic max (hard trim)
        with rotation across user-defined sources

   Broad web search remains a separate optional call,
   only triggered when topic.allSourcesEnabled = true.

   Source rotation (suggestion 5):
   Each refresh increments topic.sourceRotationOffset
   by 1 (persisted via TopicService.updateTopic).
   _getRotatedSources() uses this offset to slice a
   window of up to 6 sources across all source types,
   distributing proportionally. Over N refreshes every
   user-defined source gets included in rotation.

   30-minute cache guard (suggestion 7, Option A):
   fetchSubtopics() checks topic.updatedAt before
   calling Gemini. If data is less than 30 minutes
   old it returns the cached subtopics immediately,
   consuming zero tokens.

   DEPLOYMENT NOTES:
   1. MODEL: gemini-2.5-flash-lite — budget/speed tier of
      the 2.5 family. No thinking tokens, high RPD, designed
      for high-volume low-latency tasks. Do NOT use:
      - gemini-2.0-flash (shuts down June 1 2026)
      - gemini-1.5-flash (shut down, returns 404)
      - gemini-2.5-flash (thinking model, ~2200 tokens/call)
   2. API KEY: localStorage expose_settings_v1.
      Move server-side for multi-user production.
   3. CORS: Direct browser fetch allowed by Google.
   4. HTTPS: Required. file:// blocked by Gemini.
   5. FREE TIER: 15 RPM, 1M tokens/day, 500 grounded
      requests/day. Single-pass + cache guard makes
      this viable for 4-6 topics at hourly refresh.
   6. MIGRATION: Replace _callGemini() fetch() with
      proxy endpoint. Nothing else changes.
   7. SUGGESTION 6 (skipped, revisit if needed):
      Only refresh topics viewed in last 24h.
      Track topic.lastViewedAt in topic.service.js.
   ═══════════════════════════════════════════════ */

const GeminiService = (() => {

  const MODEL         = 'gemini-2.5-flash-lite'; // budget/speed model: no thinking tokens, high RPD, not deprecated
  const API_URL       = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const MAX_SOURCES   = 6;  // hard cap on total sources per subtopic
  const MAX_SUBTOPICS = 3;  // fixed subtopic count per refresh
  const CACHE_MINUTES = 30; // skip fetch if data is fresher than this

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

  /* ── Core Gemini call ── */
  async function _callGemini(prompt, useSearch) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     1.0,  // required for grounding per Google docs
        maxOutputTokens: 2600, // raised from 1200 — flash-lite needs ~2400 for 3 full subtopics
        thinkingConfig:  { thinkingBudget: 0 }, // disable thinking tokens — saves ~2200 tokens/call
      },
    };
    if (useSearch) body.tools = [{ google_search: {} }];

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

    // Take only the first non-empty text part.
    // Gemini sometimes emits duplicate parts with identical content — concatenating
    // them produces doubled JSON that breaks _extractJSON. Taking the first part
    // that contains a JSON block is the safest approach.
    const parts    = candidate.content?.parts || [];
    const firstJSON = parts.find(p => p.text && (p.text.includes('{') || p.text.includes('[')));
    const text      = firstJSON?.text || parts.find(p => p.text)?.text || '';
    const grounding = candidate.groundingMetadata || {};
    return { text, grounding };
  }

  /* ── Match grounding chunk URLs to source objects ────────────
     Compares source domain names against grounding chunk titles.
     When a match is found, attaches the redirect URL to the
     source object. Displayed as clean domain label + redirect href.

     OPTION 2 NOTE (future upgrade):
     Replace the redirect URL with a resolved permanent URL by
     calling a proxy endpoint: GET /api/resolve?url=<redirect>
     The proxy follows the redirect server-side and returns the
     final article URL. Requires one serverless function
     (Cloudflare Worker / Netlify Function). No Gemini tokens used.
  ─────────────────────────────────────────────────────────────── */
  function _matchGroundingUrls(subtopics, groundingChunks) {
    if (!groundingChunks?.length) return subtopics;

    // Build a lookup: normalised domain → redirect URL
    const chunkMap = {};
    groundingChunks.forEach(chunk => {
      if (!chunk.web?.uri) return;
      const title = (chunk.web.title || '').toLowerCase().replace(/^www\./, '');
      const uri   = chunk.web.uri;
      if (title) chunkMap[title] = uri;
    });

    function normaliseDomain(s) {
      return (s || '').toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '')
        .trim();
    }

    return subtopics.map(sub => {
      const updatedSources = {};
      ['x', 'reddit', 'web'].forEach(type => {
        updatedSources[type] = (sub.sources?.[type] || []).map(article => {
          if (article.url) return article; // already has a URL, keep it
          const domain = normaliseDomain(article.source);
          // Try exact match first, then partial match
          const matchedUrl = chunkMap[domain]
            || Object.entries(chunkMap).find(([k]) => k.includes(domain) || domain.includes(k))?.[1]
            || '';
          return { ...article, url: matchedUrl };
        });
      });
      return { ...sub, sources: updatedSources };
    });
  }

  /* ── Strip markdown fences and parse JSON ── */
  function _extractJSON(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
    const raw = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (raw)   { try { return JSON.parse(raw[1]); } catch {} }
    try { return JSON.parse(text.trim()); } catch {}
    return null;
  }

  /* ── Source rotation ──────────────────────────
     Distributes MAX_SOURCES slots across source
     types based on user config. Uses offset to
     rotate the window each refresh so all sources
     get coverage over time.

     Example: 4 web + 2 reddit + 1 X = 7 total.
     MAX_SOURCES = 6, so one is skipped per refresh.
     Offset increments each call, rotating which
     source is excluded. After 7 refreshes, all
     sources have been included.
  ─────────────────────────────────────────────── */
  function _getRotatedSources(sources, offset) {
    const x      = sources.x      || [];
    const reddit = sources.reddit || [];
    const web    = sources.web    || [];
    const total  = x.length + reddit.length + web.length;

    // No rotation needed if within budget
    if (total <= MAX_SOURCES) return { x, reddit, web };

    // Flat ordered list of all sources
    const all = [
      ...x.map(v      => ({ type: 'x',      value: v })),
      ...reddit.map(v => ({ type: 'reddit', value: v })),
      ...web.map(v    => ({ type: 'web',    value: v })),
    ];

    // Rotating window
    const start  = offset % total;
    const window = [];
    for (let i = 0; i < MAX_SOURCES; i++) {
      window.push(all[(start + i) % total]);
    }

    return {
      x:      window.filter(s => s.type === 'x').map(s => s.value),
      reddit: window.filter(s => s.type === 'reddit').map(s => s.value),
      web:    window.filter(s => s.type === 'web').map(s => s.value),
    };
  }

  /* ── Build terse search scope string ── */
  function _buildScope(rotated, expandTopics) {
    const parts = [];
    if (rotated.web.length)    parts.push(rotated.web.map(s => `site:${s}`).join(' OR '));
    if (rotated.reddit.length) parts.push(rotated.reddit.map(s => `site:reddit.com ${s}`).join(' OR '));
    if (rotated.x.length)      parts.push(rotated.x.map(s =>
      s.startsWith('@') ? `site:x.com ${s.slice(1)}` : `site:x.com "${s}"`
    ).join(' OR '));
    const scope  = parts.length ? parts.join(' OR ') : 'any relevant source';
    const expand = expandTopics ? ' Include related angles and emerging subtopics.' : '';
    return scope + expand;
  }

  /* ── Hard trim sources after parsing ─────────
     Enforces MAX_SOURCES cap regardless of what
     Gemini returned. Distributes evenly across
     types with any remainder going to web.
  ─────────────────────────────────────────────── */
  function _trimSources(subtopic) {
    const s        = subtopic.sources || { x: [], reddit: [], web: [] };
    const perType  = Math.floor(MAX_SOURCES / 3); // 2 each
    const remainder = MAX_SOURCES - (perType * 3); // leftover to web
    return {
      ...subtopic,
      sources: {
        x:      (s.x      || []).slice(0, perType),
        reddit: (s.reddit || []).slice(0, perType),
        web:    (s.web    || []).slice(0, perType + remainder),
      },
    };
  }

  /* ════════════════════════════════════════════
     MAIN EXPORT: fetchSubtopics
     Called by kanban.js on each topic refresh.
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

    /* ── Rotate sources, increment offset ── */
    const offset         = topic.sourceRotationOffset || 0;
    const rotatedSources = _getRotatedSources(topic.sources || {}, offset);

    // Persist incremented offset — fire and forget
    TopicService.updateTopic(topic.id, { sourceRotationOffset: offset + 1 });

    const settings    = _getSettings();
    const expandTopics = settings.expandTopics !== false;
    const scope        = _buildScope(rotatedSources, expandTopics);

    /* ── Single-pass prompt ── */
    const prompt =
`OSINT task. Search for recent news about: "${topic.name}"
Scope: ${scope}
Find content from last 72h. Identify exactly ${MAX_SUBTOPICS} distinct subtopics from what you find.
Subtopics must emerge from real source data — not invented. Each is a genuine angle or development.
Return ONLY valid JSON, no other text:
{"subtopics":[{"id":"s1","name":"max 8 word title","summary":"1-2 sentence summary of what sources say","score":85,"sourceCount":4,"sources":{"x":[{"title":"headline","source":"@handle","url":""}],"reddit":[{"title":"thread","source":"r/sub","url":""}],"web":[{"title":"headline","source":"domain.com","url":"https://..."}]},"broadSources":[]}],"searchQueries":["query used"]}`;

    let result;
    try {
      result = await _callGemini(prompt, true);
    } catch (err) {
      return { success: false, error: err.message, message: _friendlyError(err.message) };
    }

    if (!result.text || result.text.length < 50) {
      return {
        success: false,
        error:   'EMPTY_RESPONSE',
        message: 'Gemini returned no results — try again.',
      };
    }

    const parsed = _extractJSON(result.text);
    if (!parsed?.subtopics?.length) {
      return {
        success: false,
        error:   'PARSE_ERROR',
        message: 'Could not parse Gemini response. Try refreshing.',
      };
    }

    // Sort, cap at MAX_SUBTOPICS, hard trim sources, match grounding URLs
    const groundingChunks = result.grounding?.groundingChunks || [];
    const subtopics = parsed.subtopics
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, MAX_SUBTOPICS)
      .map(_trimSources);

    // Attach redirect URLs from grounding chunks to source objects
    const linkedSubtopics = _matchGroundingUrls(subtopics, groundingChunks);

    // Store grounding chunks on each subtopic so the fullscreen overlay
    // can render a verified sources panel as a fallback
    linkedSubtopics.forEach(sub => {
      sub.groundingChunks = groundingChunks;
    });

    /* ── Optional broad search (separate call) ── */
    if (topic.allSourcesEnabled) {
      try {
        const broadPrompt =
`Search for latest news: "${topic.name}". Return ONLY a JSON array, no other text:
[{"title":"headline","source":"domain.com","url":"https://..."}]
Max 4 results.`;
        const broadResult = await _callGemini(broadPrompt, true);
        const broadParsed = _extractJSON(broadResult.text);
        if (Array.isArray(broadParsed) && linkedSubtopics[0]) {
          // Match grounding chunks from the broad search call too
          const broadChunks = broadResult.grounding?.groundingChunks || [];
          const matchedBroad = _matchGroundingUrls(
            [{ sources: { web: broadParsed.slice(0, 4) } }],
            broadChunks
          );
          linkedSubtopics[0].broadSources = matchedBroad[0]?.sources?.web || broadParsed.slice(0, 4);
        }
      } catch { /* non-fatal */ }
    }

    // Log search queries (cap at 3 per refresh)
    const queries = (parsed.searchQueries || [topic.name]).slice(0, 3);
    for (const q of queries) {
      await TopicService.appendLog({
        query:        q,
        topicId:      topic.id,
        topicName:    topic.name,
        resultsCount: linkedSubtopics.length,
      });
    }

    return {
      success:   true,
      subtopics: linkedSubtopics,
      fromCache: false,
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
    };
    return map[code] || `Gemini error: ${code}`;
  }

  return { fetchSubtopics, getApiKey };
})();

window.GeminiService = GeminiService;
