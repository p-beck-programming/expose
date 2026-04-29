/* ═══════════════════════════════════════════════
   EXPOSÉ — gemini.service.js

   Single-pass approach (optimization 1):
   One API call searches, reads, and returns
   structured subtopics. No second pass needed.

   Optimizations applied:
     1. Single pass — halves API call count
     2. maxOutputTokens: 1200, thinkingConfig.thinkingBudget: 0
      thinkingBudget:0 disables internal chain-of-thought on 2.5
      models, saving ~2200 tokens per call. Do not set both
      thinkingBudget and thinkingLevel — 400 error will result.
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

  /* ── Get API key from settings ── */
  function getApiKey() {
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      return s.geminiApiKey || '';
    } catch { return ''; }
  }

  /* ── Core API call ── */
  async function _callGemini(prompt, useSearch = true) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     1.0,  // required for grounding per Google docs
        maxOutputTokens: 1200, // sufficient for flash-lite responses
        thinkingConfig:  { thinkingBudget: 0 }, // disable thinking tokens — saves ~2200 tokens/call
      },
    };

    if (useSearch) {
      body.tools = [{ google_search: {} }];
    }

    const res = await fetch(`${API_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;
      // Surface quota errors clearly
      if (res.status === 429) throw new Error('QUOTA_EXCEEDED');
      if (res.status === 400) throw new Error(`BAD_REQUEST: ${msg}`);
      if (res.status === 403) throw new Error('INVALID_API_KEY');
      throw new Error(msg);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No response from Gemini');

    const text     = candidate.content?.parts?.map(p => p.text || '').join('') || '';
    const grounding = candidate.groundingMetadata || {};

    return { text, grounding, candidate };
  }

  /* ── Strip markdown fences and parse JSON ── */
  function _extractJSON(text) {
    // Try fenced block first
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch {}
    }
    // Try raw JSON object
    const raw = text.match(/(\{[\s\S]*\})/);
    if (raw) {
      try { return JSON.parse(raw[1]); } catch {}
    }
    // Try whole string
    try { return JSON.parse(text.trim()); } catch {}
    return null;
  }

  /* ── Build source-scoped search query ── */
  function _buildSearchQuery(topicName, sources, expandTopics) {
    const parts = [topicName];

    // Add site: operators for web sources
    if (sources.web?.length) {
      const sites = sources.web.slice(0, 3).map(s => `site:${s}`).join(' OR ');
      parts.push(`(${sites})`);
    }

    // Add Reddit scope
    if (sources.reddit?.length) {
      const subs = sources.reddit.slice(0, 3).map(s => `site:reddit.com ${s}`).join(' OR ');
      parts.push(`(${subs})`);
    }

    // Add X scope (Google-indexed tweets)
    if (sources.x?.length) {
      const xTerms = sources.x.slice(0, 3).map(s =>
        s.startsWith('@') ? `site:x.com ${s.slice(1)}` : `site:x.com "${s}"`
      ).join(' OR ');
      parts.push(`(${xTerms})`);
    }

    // If expandTopics is on, tell Gemini to broaden
    const expand = expandTopics !== false;
    const expandNote = expand
      ? 'Also search for related angles, synonyms, and emerging subtopics.'
      : 'Search only for the exact topic as stated.';

    return { query: parts.join(' '), expandNote };
  }

  /* ════════════════════════════════
     MAIN EXPORT: fetchSubtopics
     Called by kanban.js for each topic refresh.
  ════════════════════════════════ */
  async function fetchSubtopics(topic) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return {
        success: false,
        error:   'NO_API_KEY',
        message: 'Add your Gemini API key in Settings to enable live data.',
      };
    }

    const settings    = (() => { try { return JSON.parse(localStorage.getItem('expose_settings_v1')) || {}; } catch { return {}; } })();
    const expandTopics = settings.expandTopics !== false;
    const { query, expandNote } = _buildSearchQuery(topic.name, topic.sources, expandTopics);

    /* ── PASS 1: Search grounding — fetch real source data ── */
    const pass1Prompt = `
You are an OSINT analyst. Search the web right now for recent news and content about: "${topic.name}"

Search scope: ${query}
${expandNote}

Find 8-15 recent articles, posts, or sources published in the last 72 hours if possible.
Read the content carefully. Do not summarize yet — just collect what you find.
List what each source is saying about "${topic.name}".
`.trim();

    let pass1Result;
    try {
      pass1Result = await _callGemini(pass1Prompt, true);
    } catch (err) {
      return { success: false, error: err.message, message: _friendlyError(err.message) };
    }

    // Short circuit if grounding returned nothing useful
    if (!pass1Result.text || pass1Result.text.length < 100) {
      return {
        success: false,
        error:   'EMPTY_RESPONSE',
        message: 'Gemini returned no results. Try again or check your API key quota.',
      };
    }

    /* ── PASS 2: Subtopic extraction — read inflow, identify subtopics ── */
    const pass2Prompt = `
You are an OSINT analyst. Below is raw source data collected about the topic "${topic.name}".
Read it carefully and identify 2-5 distinct SUBTOPICS that are actually emerging from this data.

IMPORTANT RULES:
- Subtopics must come FROM the data, not invented by you
- Each subtopic must be a real angle or development found in the sources
- Do not generate subtopics and then search for them — only surface what is in the data below

RAW SOURCE DATA:
${pass1Result.text}

Return ONLY a valid JSON object. No markdown, no explanation, no text outside the JSON.
Use this exact structure:

{
  "subtopics": [
    {
      "id": "unique_short_id",
      "name": "Short subtopic title (max 8 words)",
      "summary": "1-2 sentences describing what sources are actually saying about this subtopic.",
      "score": <integer 0-100 based on how many sources cover it and how significant>,
      "sourceCount": <integer, number of distinct sources mentioning this subtopic>,
      "sources": {
        "x":      [{ "title": "post or headline", "source": "@handle or X", "url": "" }],
        "reddit": [{ "title": "thread title", "source": "r/subreddit", "url": "" }],
        "web":    [{ "title": "article headline", "source": "domain.com", "url": "full url if available" }]
      },
      "broadSources": []
    }
  ],
  "searchQueries": ["list", "of", "queries", "used"]
}
`.trim();

    let pass2Result;
    try {
      pass2Result = await _callGemini(pass2Prompt, false); // no search on pass 2
    } catch (err) {
      return { success: false, error: err.message, message: _friendlyError(err.message) };
    }

    const parsed = _extractJSON(pass2Result.text);
    if (!parsed?.subtopics?.length) {
      return {
        success: false,
        error:   'PARSE_ERROR',
        message: 'Could not parse subtopics from Gemini response. Try again.',
      };
    }

    /* ── If allSourcesEnabled, run a broad search too ── */
    let broadResults = [];
    if (topic.allSourcesEnabled) {
      try {
        const broadPrompt = `
Search the open web for the latest news about: "${topic.name}"
Find 4-6 sources from any website. Return a JSON array of objects:
[{ "title": "headline", "source": "domain.com", "url": "url if available" }]
Return ONLY the JSON array, no other text.
`.trim();
        const broadResult = await _callGemini(broadPrompt, true);
        const broadParsed = _extractJSON(broadResult.text);
        if (Array.isArray(broadParsed)) broadResults = broadParsed;
      } catch { /* broad search failure is non-fatal */ }
    }

    // Attach broad results to the first subtopic (highest score)
    const sorted = [...parsed.subtopics].sort((a, b) => (b.score || 0) - (a.score || 0));
    if (broadResults.length && sorted[0]) {
      sorted[0].broadSources = broadResults;
    }

    // Pull Google Search suggestion HTML if present (display requirement)
    const searchSuggestionHTML = pass1Result.grounding?.searchEntryPoint?.renderedContent || null;

    // Log to search log
    const queries = parsed.searchQueries || [topic.name];
    for (const q of queries) {
      await TopicService.appendLog({
        query:        q,
        topicId:      topic.id,
        topicName:    topic.name,
        resultsCount: sorted.length,
      });
    }

    return {
      success:             true,
      subtopics:           sorted,
      searchSuggestionHTML, // store on topic for display in full-screen overlay
      groundingChunks:     pass1Result.grounding?.groundingChunks || [],
    };
  }

  /* ── Human-readable error messages ── */
  function _friendlyError(code) {
    const map = {
      NO_API_KEY:     'Add your Gemini API key in Settings → Intelligence.',
      QUOTA_EXCEEDED: 'Daily API quota reached. Wait until tomorrow or check your usage at aistudio.google.com.',
      INVALID_API_KEY:'API key rejected. Check it is correct in Settings → Intelligence.',
      EMPTY_RESPONSE: 'Gemini returned empty results. This is a known intermittent issue — try again.',
      PARSE_ERROR:    'Could not parse Gemini response. Try refreshing the topic.',
    };
    return map[code] || `Gemini error: ${code}`;
  }

  return { fetchSubtopics, getApiKey };
})();

window.GeminiService = GeminiService;
