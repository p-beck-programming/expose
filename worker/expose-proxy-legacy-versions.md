---- START V3 ----

/**
 * Exposé proxy — Worker v3 (dual-backend)
 * Paste over the existing Worker code in the Cloudflare editor and Deploy.
 *
 * WHY v3: Google News began returning HTTP 503 to this Worker — anti-bot
 * treatment of Cloudflare's shared egress IPs, which is unpredictable
 * (worked one week, blocked the next). v3 makes no single backend a
 * point of failure:
 *
 *   ?type=news  → try Google News RSS (browser-like headers),
 *                 on ANY failure fall back to the GDELT DOC 2.0 API
 *                 (free, keyless, built for programmatic access,
 *                 returns DIRECT publisher URLs — urlResolved: true).
 *   ?type=reddit → unchanged from v2.
 *
 * Every news response now includes "backend": "google" | "gdelt" so you
 * can see who served it. If Google stays blocked long-term, flipping
 * PRIMARY below to "gdelt" skips the doomed attempt and saves latency.
 *
 * GDELT specifics encoded here:
 *   - REQUIRES a User-Agent header or it rate-limits/rejects.
 *   - site:domain.com in the query is translated to domainis:domain.com.
 *   - timespan format: <n>min|h|d|w|m  (our `when` param maps directly).
 *   - ~15 min indexing lag, no snippets, officially covers last 3 months.
 *   - May return a plain-text error with HTTP 200 — guarded below.
 *
 * Interface is identical to v2 — the app (gemini.service.js v3) needs
 * NO changes for this upgrade.
 */

const PRIMARY = "google"; // "google" | "gdelt" — which news backend to try first

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Full browser headers — both Google and GDELT treat bot-ish UAs worse.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "news";

    try {
      if (type === "news") return await handleNews(url);
      if (type === "reddit") return await handleReddit(url);
      return json({ ok: false, type, error: "unknown_type" }, 400);
    } catch (err) {
      return json({ ok: false, type, error: "proxy_failure", detail: String(err) }, 502);
    }
  },
};

/* ================= news: dual backend ================= */

async function handleNews(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, type: "news", error: "missing_q" }, 400);

  const when = (url.searchParams.get("when") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  const backends = PRIMARY === "gdelt"
    ? [fetchGdelt, fetchGoogleNews]
    : [fetchGoogleNews, fetchGdelt];

  const failures = [];
  for (const backend of backends) {
    const result = await backend(q, when, limit);
    if (result.ok) return json(result);
    failures.push(`${result.backend}: ${result.detail}`);
  }

  return json({
    ok: false,
    type: "news",
    query: q,
    error: "upstream_error",
    detail: failures.join(" | "),
  });
}

/* ---------------- backend 1: Google News RSS ---------------- */

async function fetchGoogleNews(q, when, limit) {
  const fullQuery = /^\d+[hdm]$/.test(when) ? `${q} when:${when}` : q;
  const feedUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}` +
    `&hl=en-US&gl=US&ceid=US:en`;

  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "google", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "google", detail: `HTTP ${res.status}` };

  const xml = await res.text();
  const items = parseRss(xml).slice(0, limit).map((raw) => {
    const decoded = decodeGoogleLink(raw.link);
    let title = raw.title;
    if (raw.source && title.endsWith(` - ${raw.source}`)) {
      title = title.slice(0, -(raw.source.length + 3));
    }
    let snippet = stripTags(raw.description);
    if (!snippet || snippet.startsWith(title.slice(0, 40))) snippet = "";

    return {
      id: hashId(raw.link || raw.title),
      title,
      url: decoded || raw.link,
      urlResolved: Boolean(decoded),
      source: raw.source || "",
      sourceDomain: raw.sourceUrl ? hostOf(raw.sourceUrl) : "",
      publishedAt: toIso(raw.pubDate),
      snippet,
    };
  });

  return {
    ok: true, type: "news", backend: "google", query: fullQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

/* ---------------- backend 2: GDELT DOC 2.0 ---------------- */

async function fetchGdelt(q, when, limit) {
  // Translate Google-style query syntax to GDELT's:
  //   site:domain.com → domainis:domain.com ; strip any stray when: tokens.
  const tokens = q.split(/\s+/).filter(Boolean);
  const parts = [];
  for (const t of tokens) {
    const site = t.match(/^site:(.+)$/i);
    if (site) { parts.push(`domainis:${site[1].replace(/^www\./, "")}`); continue; }
    if (/^when:/i.test(t)) continue;
    parts.push(t);
  }
  const gdeltQuery = parts.join(" ");

  // timespan: <n>min|h|d|w|m. Default 3d to mirror the app's window.
  const timespan = /^\d+(min|h|d|w|m)$/.test(when) ? when : "3d";

  const apiUrl =
    `https://api.gdeltproject.org/api/v2/doc/doc` +
    `?query=${encodeURIComponent(gdeltQuery)}` +
    `&mode=ArtList&format=json&sort=DateDesc` +
    `&timespan=${timespan}&maxrecords=${limit}`;

  let res;
  try {
    // GDELT rejects/rate-limits requests without a User-Agent.
    res = await fetch(apiUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "gdelt", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "gdelt", detail: `HTTP ${res.status}` };

  // GDELT sometimes returns plain-text errors with HTTP 200 — guard the parse.
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, backend: "gdelt", detail: `non-JSON: ${text.slice(0, 120)}` };
  }

  const items = (data.articles || [])
    .filter((a) => a.title && a.url)
    .slice(0, limit)
    .map((a) => ({
      id: hashId(a.url),
      title: a.title,
      url: a.url,            // direct publisher URL — no redirect wrapper
      urlResolved: true,
      source: a.domain || "",
      sourceDomain: a.domain || "",
      publishedAt: gdeltDate(a.seendate),
      snippet: "",           // GDELT ArtList has no snippets — titles carry clustering
      language: a.language || "",
    }));

  return {
    ok: true, type: "news", backend: "gdelt", query: gdeltQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

function gdeltDate(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

/* ================= reddit (unchanged from v2) ================= */

async function handleReddit(url) {
  let sub = (url.searchParams.get("sub") || "").trim();
  sub = sub.replace(/^\/+/, "").replace(/^r\//i, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_]+$/.test(sub)) {
    return json({ ok: false, type: "reddit", error: "bad_sub" }, 400);
  }

  const limit = clampInt(url.searchParams.get("limit"), 15, 1, 50);

  const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=${limit}`, {
    headers: { ...BROWSER_HEADERS, "Accept": "application/json" },
  });

  if (!res.ok) {
    return json({ ok: false, type: "reddit", query: `r/${sub}`, error: "reddit_blocked", detail: `HTTP ${res.status}` });
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ ok: false, type: "reddit", query: `r/${sub}`, error: "reddit_bad_json" });
  }

  const children = data?.data?.children || [];
  const items = children.map(({ data: p }) => ({
    id: hashId(p.permalink || p.id),
    title: p.title || "",
    url: `https://www.reddit.com${p.permalink}`,
    urlResolved: true,
    source: `r/${sub}`,
    sourceDomain: "reddit.com",
    publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : "",
    snippet: (p.selftext || "").replace(/\s+/g, " ").slice(0, 300),
    score: p.score,
    numComments: p.num_comments,
    externalUrl: p.url && !p.url.includes(p.permalink) ? p.url : "",
  }));

  return json({ ok: true, type: "reddit", query: `r/${sub}`, fetchedAt: new Date().toISOString(), items });
}

/* ================= RSS parsing (unchanged) ================= */

function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const sourceMatch = block.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    items.push({
      title: pick(block, "title"),
      link: pick(block, "link"),
      pubDate: pick(block, "pubDate"),
      description: pick(block, "description"),
      sourceUrl: sourceMatch ? sourceMatch[1] : "",
      source: sourceMatch ? clean(sourceMatch[2]) : "",
    });
  }
  return items;
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/* ================= Google link decoding (unchanged) =================
   Works only on the old link format; Google has fully migrated to a
   locked format resolvable only via their 429-prone batchexecute
   endpoint, which we deliberately avoid. Redirect links still open
   the correct article. GDELT items don't need this at all. */

function decodeGoogleLink(link) {
  try {
    const m = (link || "").match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    if (bin.includes("AU_yqL")) return null;
    const urlMatch = bin.match(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
    if (!urlMatch) return null;
    const u = urlMatch[0];
    return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(u) ? u : null;
  } catch {
    return null;
  }
}

/* ================= small helpers ================= */

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function toIso(d) {
  const t = new Date(d);
  return isNaN(t.getTime()) ? "" : t.toISOString();
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

---- END V3 ----
##########################################################################################
##########################################################################################
---- START V4 ----

/**
 * Exposé proxy — Worker v4 (RSS + YouTube sources, Reddit removed)
 * Paste over the existing Worker code in the Cloudflare editor and Deploy.
 *
 * WHY v4: Reddit was dropped (unauthenticated JSON is 403-blocked and the dev API
 * signup is a dead end for this use case). It is replaced by two keyless sources that
 * work cleanly from a Worker:
 *
 *   ?type=news    → Google News RSS, fall back to GDELT DOC 2.0  (unchanged from v3)
 *   ?type=rss     → fetch + parse ANY user-supplied RSS 2.0 or Atom feed
 *   ?type=youtube → resolve a channel (UC id / @handle / channel URL) to its Atom
 *                   feed (youtube.com/feeds/videos.xml?channel_id=…) and parse it
 *
 * All feed types share one parser (parseFeed) that understands both RSS <item> and
 * Atom <entry>. Every response uses the same item shape the app already consumes, so
 * gemini.service.js only needs new plan builders — no shape changes.
 */

const PRIMARY = "google"; // "google" | "gdelt" — which news backend to try first

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Full browser headers — Google, GDELT, and YouTube all treat bot-ish UAs worse.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "news";

    try {
      if (type === "news") return await handleNews(url);
      if (type === "rss") return await handleRss(url);
      if (type === "youtube") return await handleYouTube(url);
      return json({ ok: false, type, error: "unknown_type" }, 400);
    } catch (err) {
      return json({ ok: false, type, error: "proxy_failure", detail: String(err) }, 502);
    }
  },
};

/* ================= news: dual backend ================= */

async function handleNews(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, type: "news", error: "missing_q" }, 400);

  const when = (url.searchParams.get("when") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  const backends = PRIMARY === "gdelt"
    ? [fetchGdelt, fetchGoogleNews]
    : [fetchGoogleNews, fetchGdelt];

  const failures = [];
  for (const backend of backends) {
    const result = await backend(q, when, limit);
    if (result.ok) return json(result);
    failures.push(`${result.backend}: ${result.detail}`);
  }

  return json({
    ok: false,
    type: "news",
    query: q,
    error: "upstream_error",
    detail: failures.join(" | "),
  });
}

/* ---------------- backend 1: Google News RSS ---------------- */

async function fetchGoogleNews(q, when, limit) {
  const fullQuery = /^\d+[hdm]$/.test(when) ? `${q} when:${when}` : q;
  const feedUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}` +
    `&hl=en-US&gl=US&ceid=US:en`;

  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "google", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "google", detail: `HTTP ${res.status}` };

  const xml = await res.text();
  const items = parseFeed(xml).slice(0, limit).map((raw) => {
    const decoded = decodeGoogleLink(raw.link);
    let title = raw.title;
    if (raw.source && title.endsWith(` - ${raw.source}`)) {
      title = title.slice(0, -(raw.source.length + 3));
    }
    let snippet = stripTags(raw.description);
    if (!snippet || snippet.startsWith(title.slice(0, 40))) snippet = "";

    return {
      id: hashId(raw.link || raw.title),
      title,
      url: decoded || raw.link,
      urlResolved: Boolean(decoded),
      source: raw.source || "",
      sourceDomain: raw.sourceUrl ? hostOf(raw.sourceUrl) : "",
      publishedAt: toIso(raw.pubDate),
      snippet,
    };
  });

  return {
    ok: true, type: "news", backend: "google", query: fullQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

/* ---------------- backend 2: GDELT DOC 2.0 ---------------- */

async function fetchGdelt(q, when, limit) {
  // Translate Google-style query syntax to GDELT's:
  //   site:domain.com → domainis:domain.com ; strip any stray when: tokens.
  const tokens = q.split(/\s+/).filter(Boolean);
  const parts = [];
  for (const t of tokens) {
    const site = t.match(/^site:(.+)$/i);
    if (site) { parts.push(`domainis:${site[1].replace(/^www\./, "")}`); continue; }
    if (/^when:/i.test(t)) continue;
    parts.push(t);
  }
  const gdeltQuery = parts.join(" ");

  // timespan: <n>min|h|d|w|m. Default 3d to mirror the app's window.
  const timespan = /^\d+(min|h|d|w|m)$/.test(when) ? when : "3d";

  const apiUrl =
    `https://api.gdeltproject.org/api/v2/doc/doc` +
    `?query=${encodeURIComponent(gdeltQuery)}` +
    `&mode=ArtList&format=json&sort=DateDesc` +
    `&timespan=${timespan}&maxrecords=${limit}`;

  let res;
  try {
    // GDELT rejects/rate-limits requests without a User-Agent.
    res = await fetch(apiUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "gdelt", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "gdelt", detail: `HTTP ${res.status}` };

  // GDELT sometimes returns plain-text errors with HTTP 200 — guard the parse.
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, backend: "gdelt", detail: `non-JSON: ${text.slice(0, 120)}` };
  }

  const items = (data.articles || [])
    .filter((a) => a.title && a.url)
    .slice(0, limit)
    .map((a) => ({
      id: hashId(a.url),
      title: a.title,
      url: a.url,            // direct publisher URL — no redirect wrapper
      urlResolved: true,
      source: a.domain || "",
      sourceDomain: a.domain || "",
      publishedAt: gdeltDate(a.seendate),
      snippet: "",           // GDELT ArtList has no snippets — titles carry clustering
      language: a.language || "",
    }));

  return {
    ok: true, type: "news", backend: "gdelt", query: gdeltQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

function gdeltDate(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

/* ================= rss: any user-supplied feed ================= */

async function handleRss(url) {
  const feedUrl = (url.searchParams.get("url") || "").trim();
  if (!feedUrl) return json({ ok: false, type: "rss", error: "missing_url" }, 400);
  if (!/^https?:\/\//i.test(feedUrl)) {
    return json({ ok: false, type: "rss", error: "bad_url", detail: "must be http(s)" }, 400);
  }
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  if (!/<(item|entry)[\s>]/i.test(xml)) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "not_a_feed", detail: xml.slice(0, 120) });
  }

  const feedTitle = feedDocTitle(xml);
  const host = hostOf(feedUrl);
  const items = parseFeed(xml).slice(0, limit).map((raw) => ({
    id: hashId(raw.link || raw.title),
    title: raw.title,
    url: raw.link,
    urlResolved: true,
    source: raw.source || feedTitle || host,
    sourceDomain: raw.link ? hostOf(raw.link) : host,
    publishedAt: toIso(raw.pubDate),
    snippet: stripTags(raw.description).slice(0, 300),
  }));

  return json({ ok: true, type: "rss", query: feedUrl, fetchedAt: new Date().toISOString(), items });
}

/* ================= youtube: per-channel Atom feed ================= */

async function handleYouTube(url) {
  const raw = (url.searchParams.get("channel") || "").trim();
  if (!raw) return json({ ok: false, type: "youtube", error: "missing_channel" }, 400);
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  let channelId;
  try {
    channelId = await resolveYouTubeChannelId(raw);
  } catch (err) {
    return json({ ok: false, type: "youtube", query: raw, error: "youtube_resolve_failed", detail: String(err) });
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "youtube", query: raw, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    return json({ ok: false, type: "youtube", query: raw, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  const channelTitle = feedDocTitle(xml) || raw;
  const items = parseFeed(xml).slice(0, limit).map((raw2) => {
    const vid = raw2.ytVideoId ||
      (raw2.link.match(/[?&]v=([\w-]+)/) || [])[1] || "";
    return {
      id: hashId(vid || raw2.link || raw2.title),
      title: raw2.title,
      url: vid ? `https://www.youtube.com/watch?v=${vid}` : raw2.link,
      urlResolved: true,
      source: channelTitle,
      sourceDomain: "youtube.com",
      publishedAt: toIso(raw2.pubDate),
      snippet: stripTags(raw2.description).slice(0, 300),
    };
  });

  return json({ ok: true, type: "youtube", query: raw, channelId, fetchedAt: new Date().toISOString(), items });
}

// Resolve UC id / @handle / channel URL / feed URL → "UC…" channel id.
async function resolveYouTubeChannelId(input) {
  // 1. Already a bare channel id.
  if (/^UC[\w-]{20,}$/.test(input)) return input;

  // 2. A feed or channel URL that already carries the id.
  const idInUrl = input.match(/channel_id=(UC[\w-]+)/) || input.match(/\/channel\/(UC[\w-]+)/);
  if (idInUrl) return idInUrl[1];

  // 3. @handle or channel URL → fetch the page and scrape the id.
  let pageUrl;
  if (/^https?:\/\//i.test(input)) {
    pageUrl = input;
  } else if (input.startsWith("@")) {
    pageUrl = `https://www.youtube.com/${input}`;
  } else {
    pageUrl = `https://www.youtube.com/@${input.replace(/^\/+/, "")}`;
  }

  const res = await fetch(pageUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`channel page HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/"channelId":"(UC[\w-]+)"/) ||
            html.match(/\/channel\/(UC[\w-]+)/) ||
            html.match(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]+)"/);
  if (!m) throw new Error("channelId not found on page");
  return m[1];
}

/* ================= feed parsing (RSS <item> + Atom <entry>) ================= */

function parseFeed(xml) {
  const items = [];
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const isAtom = m[1].toLowerCase() === "entry";
    const block = m[2];
    items.push(isAtom ? parseAtomEntry(block) : parseRssItem(block));
  }
  return items;
}

function parseRssItem(block) {
  const sourceMatch = block.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
  return {
    title: pick(block, "title"),
    link: pick(block, "link"),
    pubDate: pick(block, "pubDate") || pick(block, "dc:date"),
    description: pick(block, "description") || pick(block, "content:encoded"),
    sourceUrl: sourceMatch ? sourceMatch[1] : "",
    source: sourceMatch ? clean(sourceMatch[2]) : "",
    ytVideoId: "",
  };
}

function parseAtomEntry(block) {
  // Atom <link href="…"> — prefer rel="alternate"/no rel; skip rel="self".
  let link = "";
  const linkRe = /<link\b([^>]*)\/?>/g;
  let lm;
  while ((lm = linkRe.exec(block)) !== null) {
    const attrs = lm[1];
    if (/rel="self"/.test(attrs)) continue;
    const href = attrs.match(/href="([^"]*)"/);
    if (href) { link = clean(href[1]); if (!/rel=/.test(attrs) || /rel="alternate"/.test(attrs)) break; }
  }
  return {
    title: pick(block, "title"),
    link,
    pubDate: pick(block, "published") || pick(block, "updated"),
    description: pick(block, "media:description") || pick(block, "summary") || pick(block, "content"),
    sourceUrl: "",
    source: "",
    ytVideoId: pick(block, "yt:videoId"),
  };
}

function feedDocTitle(xml) {
  // Title of the feed/channel itself (first <title> before any item/entry).
  const head = xml.split(/<(?:item|entry)\b/i)[0];
  return pick(head, "title");
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/* ================= Google link decoding (unchanged) =================
   Works only on the old link format; Google has fully migrated to a
   locked format resolvable only via their 429-prone batchexecute
   endpoint, which we deliberately avoid. Redirect links still open
   the correct article. GDELT items don't need this at all. */

function decodeGoogleLink(link) {
  try {
    const m = (link || "").match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    if (bin.includes("AU_yqL")) return null;
    const urlMatch = bin.match(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
    if (!urlMatch) return null;
    const u = urlMatch[0];
    return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(u) ? u : null;
  } catch {
    return null;
  }
}

/* ================= small helpers ================= */

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function toIso(d) {
  const t = new Date(d);
  return isNaN(t.getTime()) ? "" : t.toISOString();
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

---- END V4 ----
##########################################################################################
##########################################################################################
---- START V5 ----

/**
 * Exposé proxy — Worker v4 (RSS + YouTube sources, Reddit removed)
 * Paste over the existing Worker code in the Cloudflare editor and Deploy.
 *
 * WHY v4: Reddit was dropped (unauthenticated JSON is 403-blocked and the dev API
 * signup is a dead end for this use case). It is replaced by two keyless sources that
 * work cleanly from a Worker:
 *
 *   ?type=news    → Google News RSS, fall back to GDELT DOC 2.0  (unchanged from v3)
 *   ?type=rss     → fetch + parse ANY user-supplied RSS 2.0 or Atom feed
 *   ?type=youtube → resolve a channel (UC id / @handle / channel URL) to its Atom
 *                   feed (youtube.com/feeds/videos.xml?channel_id=…) and parse it
 *
 * All feed types share one parser (parseFeed) that understands both RSS <item> and
 * Atom <entry>. Every response uses the same item shape the app already consumes, so
 * gemini.service.js only needs new plan builders — no shape changes.
 */

const PRIMARY = "google"; // "google" | "gdelt" — which news backend to try first

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Full browser headers — Google, GDELT, and YouTube all treat bot-ish UAs worse.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "news";

    try {
      if (type === "news") return await handleNews(url);
      if (type === "rss") return await handleRss(url);
      if (type === "youtube") return await handleYouTube(url);
      return json({ ok: false, type, error: "unknown_type" }, 400);
    } catch (err) {
      return json({ ok: false, type, error: "proxy_failure", detail: String(err) }, 502);
    }
  },
};

/* ================= news: dual backend ================= */

async function handleNews(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, type: "news", error: "missing_q" }, 400);

  const when = (url.searchParams.get("when") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);
  const merge = url.searchParams.get("merge") === "1";

  // MERGE MODE (broad search): query both backends in parallel and union the
  // results, so broad search is a deep, source-diverse discovery tool that
  // survives one backend being rate-limited. Each backend pulls the full limit;
  // we dedupe and re-cap after merging.
  if (merge) {
    const [g, d] = await Promise.allSettled([
      fetchGoogleNews(q, when, limit),
      fetchGdelt(q, when, limit),
    ]);
    const ok = [g, d].filter(r => r.status === "fulfilled" && r.value.ok).map(r => r.value);
    if (ok.length) {
      const merged = dedupeItems(ok.flatMap(r => r.items))
        .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
        .slice(0, limit);
      return json({
        ok: true, type: "news", backend: ok.map(r => r.backend).join("+"),
        query: q, fetchedAt: new Date().toISOString(), items: merged,
      });
    }
    const failures = [g, d].map(r =>
      r.status === "fulfilled" ? `${r.value.backend}: ${r.value.detail}` : `news: ${String(r.reason)}`
    );
    return json({ ok: false, type: "news", query: q, error: "upstream_error", detail: failures.join(" | ") });
  }

  const backends = PRIMARY === "gdelt"
    ? [fetchGdelt, fetchGoogleNews]
    : [fetchGoogleNews, fetchGdelt];

  const failures = [];
  for (const backend of backends) {
    const result = await backend(q, when, limit);
    if (result.ok) return json(result);
    failures.push(`${result.backend}: ${result.detail}`);
  }

  return json({
    ok: false,
    type: "news",
    query: q,
    error: "upstream_error",
    detail: failures.join(" | "),
  });
}

// Dedupe items by resolved URL (host+path) when available, else by normalized title.
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.url || "")
      ? (hostOf(it.url) + "|" + (it.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim())
      : (it.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/* ---------------- backend 1: Google News RSS ---------------- */

async function fetchGoogleNews(q, when, limit) {
  const fullQuery = /^\d+[hdm]$/.test(when) ? `${q} when:${when}` : q;
  const feedUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}` +
    `&hl=en-US&gl=US&ceid=US:en`;

  let res;
  try {
    res = await fetchWithRetry(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "google", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "google", detail: `HTTP ${res.status}` };

  const xml = await res.text();
  const items = parseFeed(xml).slice(0, limit).map((raw) => {
    const decoded = decodeGoogleLink(raw.link);
    let title = raw.title;
    if (raw.source && title.endsWith(` - ${raw.source}`)) {
      title = title.slice(0, -(raw.source.length + 3));
    }
    let snippet = stripTags(raw.description);
    if (!snippet || snippet.startsWith(title.slice(0, 40))) snippet = "";

    return {
      id: hashId(raw.link || raw.title),
      title,
      url: decoded || raw.link,
      urlResolved: Boolean(decoded),
      source: raw.source || "",
      sourceDomain: raw.sourceUrl ? hostOf(raw.sourceUrl) : "",
      publishedAt: toIso(raw.pubDate),
      snippet,
    };
  });

  return {
    ok: true, type: "news", backend: "google", query: fullQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

/* ---------------- backend 2: GDELT DOC 2.0 ---------------- */

async function fetchGdelt(q, when, limit) {
  // Translate Google-style query syntax to GDELT's:
  //   site:domain.com → domainis:domain.com ; strip any stray when: tokens.
  const tokens = q.split(/\s+/).filter(Boolean);
  const parts = [];
  for (const t of tokens) {
    const site = t.match(/^site:(.+)$/i);
    if (site) { parts.push(`domainis:${site[1].replace(/^www\./, "")}`); continue; }
    if (/^when:/i.test(t)) continue;
    parts.push(t);
  }
  const gdeltQuery = parts.join(" ");

  // timespan: <n>min|h|d|w|m. Default 3d to mirror the app's window.
  const timespan = /^\d+(min|h|d|w|m)$/.test(when) ? when : "3d";

  const apiUrl =
    `https://api.gdeltproject.org/api/v2/doc/doc` +
    `?query=${encodeURIComponent(gdeltQuery)}` +
    `&mode=ArtList&format=json&sort=DateDesc` +
    `&timespan=${timespan}&maxrecords=${limit}`;

  let res;
  try {
    // GDELT rejects/rate-limits requests without a User-Agent.
    res = await fetchWithRetry(apiUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "gdelt", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "gdelt", detail: `HTTP ${res.status}` };

  // GDELT sometimes returns plain-text errors with HTTP 200 — guard the parse.
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, backend: "gdelt", detail: `non-JSON: ${text.slice(0, 120)}` };
  }

  const items = (data.articles || [])
    .filter((a) => a.title && a.url)
    .slice(0, limit)
    .map((a) => ({
      id: hashId(a.url),
      title: a.title,
      url: a.url,            // direct publisher URL — no redirect wrapper
      urlResolved: true,
      source: a.domain || "",
      sourceDomain: a.domain || "",
      publishedAt: gdeltDate(a.seendate),
      snippet: "",           // GDELT ArtList has no snippets — titles carry clustering
      language: a.language || "",
    }));

  return {
    ok: true, type: "news", backend: "gdelt", query: gdeltQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

function gdeltDate(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

/* ================= rss: any user-supplied feed ================= */

async function handleRss(url) {
  const feedUrl = (url.searchParams.get("url") || "").trim();
  if (!feedUrl) return json({ ok: false, type: "rss", error: "missing_url" }, 400);
  if (!/^https?:\/\//i.test(feedUrl)) {
    return json({ ok: false, type: "rss", error: "bad_url", detail: "must be http(s)" }, 400);
  }
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  if (!/<(item|entry)[\s>]/i.test(xml)) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "not_a_feed", detail: xml.slice(0, 120) });
  }

  const feedTitle = feedDocTitle(xml);
  const host = hostOf(feedUrl);
  const items = parseFeed(xml).slice(0, limit).map((raw) => ({
    id: hashId(raw.link || raw.title),
    title: raw.title,
    url: raw.link,
    urlResolved: true,
    source: raw.source || feedTitle || host,
    sourceDomain: raw.link ? hostOf(raw.link) : host,
    publishedAt: toIso(raw.pubDate),
    snippet: stripTags(raw.description).slice(0, 300),
  }));

  return json({ ok: true, type: "rss", query: feedUrl, fetchedAt: new Date().toISOString(), items });
}

/* ================= youtube: per-channel Atom feed ================= */

async function handleYouTube(url) {
  const raw = (url.searchParams.get("channel") || "").trim();
  if (!raw) return json({ ok: false, type: "youtube", error: "missing_channel" }, 400);
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  let channelId;
  try {
    channelId = await resolveYouTubeChannelId(raw);
  } catch (err) {
    return json({ ok: false, type: "youtube", query: raw, error: "youtube_resolve_failed", detail: String(err) });
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "youtube", query: raw, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    return json({ ok: false, type: "youtube", query: raw, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  const channelTitle = feedDocTitle(xml) || raw;
  const items = parseFeed(xml).slice(0, limit).map((raw2) => {
    const vid = raw2.ytVideoId ||
      (raw2.link.match(/[?&]v=([\w-]+)/) || [])[1] || "";
    return {
      id: hashId(vid || raw2.link || raw2.title),
      title: raw2.title,
      url: vid ? `https://www.youtube.com/watch?v=${vid}` : raw2.link,
      urlResolved: true,
      source: channelTitle,
      sourceDomain: "youtube.com",
      publishedAt: toIso(raw2.pubDate),
      snippet: stripTags(raw2.description).slice(0, 300),
    };
  });

  return json({ ok: true, type: "youtube", query: raw, channelId, fetchedAt: new Date().toISOString(), items });
}

// Resolve UC id / @handle / channel URL / feed URL → "UC…" channel id.
async function resolveYouTubeChannelId(input) {
  // 1. Already a bare channel id.
  if (/^UC[\w-]{20,}$/.test(input)) return input;

  // 2. A feed or channel URL that already carries the id.
  const idInUrl = input.match(/channel_id=(UC[\w-]+)/) || input.match(/\/channel\/(UC[\w-]+)/);
  if (idInUrl) return idInUrl[1];

  // 3. @handle or channel URL → fetch the page and scrape the id.
  let pageUrl;
  if (/^https?:\/\//i.test(input)) {
    pageUrl = input;
  } else if (input.startsWith("@")) {
    pageUrl = `https://www.youtube.com/${input}`;
  } else {
    pageUrl = `https://www.youtube.com/@${input.replace(/^\/+/, "")}`;
  }

  const res = await fetch(pageUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`channel page HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/"channelId":"(UC[\w-]+)"/) ||
            html.match(/\/channel\/(UC[\w-]+)/) ||
            html.match(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]+)"/);
  if (!m) throw new Error("channelId not found on page");
  return m[1];
}

/* ================= feed parsing (RSS <item> + Atom <entry>) ================= */

function parseFeed(xml) {
  const items = [];
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const isAtom = m[1].toLowerCase() === "entry";
    const block = m[2];
    items.push(isAtom ? parseAtomEntry(block) : parseRssItem(block));
  }
  return items;
}

function parseRssItem(block) {
  const sourceMatch = block.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
  return {
    title: pick(block, "title"),
    link: pick(block, "link"),
    pubDate: pick(block, "pubDate") || pick(block, "dc:date"),
    description: pick(block, "description") || pick(block, "content:encoded"),
    sourceUrl: sourceMatch ? sourceMatch[1] : "",
    source: sourceMatch ? clean(sourceMatch[2]) : "",
    ytVideoId: "",
  };
}

function parseAtomEntry(block) {
  // Atom <link href="…"> — prefer rel="alternate"/no rel; skip rel="self".
  let link = "";
  const linkRe = /<link\b([^>]*)\/?>/g;
  let lm;
  while ((lm = linkRe.exec(block)) !== null) {
    const attrs = lm[1];
    if (/rel="self"/.test(attrs)) continue;
    const href = attrs.match(/href="([^"]*)"/);
    if (href) { link = clean(href[1]); if (!/rel=/.test(attrs) || /rel="alternate"/.test(attrs)) break; }
  }
  return {
    title: pick(block, "title"),
    link,
    pubDate: pick(block, "published") || pick(block, "updated"),
    description: pick(block, "media:description") || pick(block, "summary") || pick(block, "content"),
    sourceUrl: "",
    source: "",
    ytVideoId: pick(block, "yt:videoId"),
  };
}

function feedDocTitle(xml) {
  // Title of the feed/channel itself (first <title> before any item/entry).
  const head = xml.split(/<(?:item|entry)\b/i)[0];
  return pick(head, "title");
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/* ================= Google link decoding (unchanged) =================
   Works only on the old link format; Google has fully migrated to a
   locked format resolvable only via their 429-prone batchexecute
   endpoint, which we deliberately avoid. Redirect links still open
   the correct article. GDELT items don't need this at all. */

function decodeGoogleLink(link) {
  try {
    const m = (link || "").match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    if (bin.includes("AU_yqL")) return null;
    const urlMatch = bin.match(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
    if (!urlMatch) return null;
    const u = urlMatch[0];
    return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(u) ? u : null;
  } catch {
    return null;
  }
}

/* ================= small helpers ================= */

// Transient upstream statuses (429/502/503/504) and network errors are retried
// with jittered backoff. Both news backends rate-limit intermittently, which
// otherwise sinks broad-only topics that depend on a single news query.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
async function fetchWithRetry(url, opts, { retries = 2, baseMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, baseMs * attempt + Math.floor(Math.random() * 250)));
    }
    try {
      const res = await fetch(url, opts);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === retries) return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
    }
  }
  if (lastErr) throw lastErr;
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function toIso(d) {
  const t = new Date(d);
  return isNaN(t.getTime()) ? "" : t.toISOString();
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}


---- END V5 ----

##########################################################################################
##########################################################################################

---- START CORRECTED V5 ----
/**
 * Exposé proxy — Worker v5 (broad-search rate-limit hardening)
 * Paste over the existing Worker code in the Cloudflare editor and Deploy.
 *
 * Endpoints (unchanged shape — gemini.service.js consumes the same item shape):
 *   ?type=news    → Google News RSS, fall back to GDELT DOC 2.0
 *   ?type=rss     → fetch + parse ANY user-supplied RSS 2.0 or Atom feed
 *   ?type=youtube → resolve a channel (UC id / @handle / channel URL) to its Atom
 *                   feed (youtube.com/feeds/videos.xml?channel_id=…) and parse it
 * All feed types share one parser (parseFeed) for RSS <item> and Atom <entry>.
 *
 * WHY v5: v4's broad-search "merge" mode called BOTH news backends on every broad
 * query, which slammed GDELT (it rate-limits hard per-IP, and Workers share egress
 * IPs) → near-constant 429, so broad-only topics consistently errored. v5 fixes the
 * reliability without losing depth/diversity:
 *
 *   • ?type=news&merge=1 (BROAD mode) is now Google-FIRST: Google News RSS is itself
 *     a multi-publisher aggregator, so it usually returns a deep, diverse pool alone.
 *     GDELT is only called when Google is down or returns < BROAD_MIN items, then the
 *     two are merged + deduped. GDELT is back to a rare, as-needed call.
 *   • Retry (fetchWithRetry) now retries ONLY 502/503/504 + network errors — never
 *     429 (its window is seconds, so sub-second retries just guarantee another 429).
 *   • Response caching (caches.default, NEWS_TTL): successful payloads are cached by
 *     request URL so repeated refreshes hit cache instead of upstream. Errors are
 *     never cached, so a genuine failure still retries on the next refresh.
 *
 * v4 (RSS + YouTube sources, Reddit removed): replaced Reddit (403-blocked unauth
 * JSON) with the keyless ?type=rss and ?type=youtube endpoints above.
 */

const PRIMARY = "google"; // "google" | "gdelt" — which news backend to try first
const BROAD_MIN = 10;     // broad mode: only reach for GDELT if Google returns fewer than this
const NEWS_TTL = 600;     // seconds to cache successful feed responses (caches.default)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Full browser headers — Google, GDELT, and YouTube all treat bot-ish UAs worse.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "news";

    // Serve a cached success if one is still fresh — cuts repeated-refresh load on
    // the upstreams (the dominant cause of rate-limiting while testing). Cache is
    // keyed by the full request URL, which is stable for a given broad query.
    const cache    = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit      = await cache.match(cacheKey);
    if (hit) return hit;

    let res;
    try {
      if (type === "news") res = await handleNews(url);
      else if (type === "rss") res = await handleRss(url);
      else if (type === "youtube") res = await handleYouTube(url);
      else res = json({ ok: false, type, error: "unknown_type" }, 400);
    } catch (err) {
      return json({ ok: false, type, error: "proxy_failure", detail: String(err) }, 502);
    }

    // Cache only successful payloads. json() returns HTTP 200 even for ok:false,
    // so gate on the parsed body — never cache an error (it must retry next time).
    try {
      const data = await res.clone().json();
      if (data && data.ok) {
        const cached = new Response(JSON.stringify(data), {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/json; charset=utf-8",
                     "Cache-Control": `public, max-age=${NEWS_TTL}` },
        });
        const put = cache.put(cacheKey, cached);
        if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
      }
    } catch { /* non-JSON / unreadable — skip caching */ }

    return res;
  },
};

/* ================= news: dual backend ================= */

async function handleNews(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, type: "news", error: "missing_q" }, 400);

  const when = (url.searchParams.get("when") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);
  const merge = url.searchParams.get("merge") === "1";

  // BROAD MODE (merge=1): Google-first, GDELT only when needed. Google News RSS
  // is itself a multi-publisher aggregator, so it usually returns a deep, diverse
  // pool on its own. We only call GDELT (which rate-limits aggressively per-IP)
  // when Google is down or thin — keeping it a rare, as-needed call rather than a
  // per-request 429 magnet.
  if (merge) {
    const g = await fetchGoogleNews(q, when, limit);
    let items   = g.ok ? g.items : [];
    const used  = g.ok ? ["google"] : [];
    const fails = g.ok ? [] : [`google: ${g.detail}`];

    if (items.length < BROAD_MIN) {
      const d = await fetchGdelt(q, when, limit);
      if (d.ok) { items = dedupeItems(items.concat(d.items)); used.push("gdelt"); }
      else fails.push(`gdelt: ${d.detail}`);
    }

    if (items.length) {
      const out = items
        .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
        .slice(0, limit);
      return json({
        ok: true, type: "news", backend: used.join("+"),
        query: q, fetchedAt: new Date().toISOString(), items: out,
      });
    }
    return json({ ok: false, type: "news", query: q, error: "upstream_error", detail: fails.join(" | ") });
  }

  const backends = PRIMARY === "gdelt"
    ? [fetchGdelt, fetchGoogleNews]
    : [fetchGoogleNews, fetchGdelt];

  const failures = [];
  for (const backend of backends) {
    const result = await backend(q, when, limit);
    if (result.ok) return json(result);
    failures.push(`${result.backend}: ${result.detail}`);
  }

  return json({
    ok: false,
    type: "news",
    query: q,
    error: "upstream_error",
    detail: failures.join(" | "),
  });
}

// Dedupe items by resolved URL (host+path) when available, else by normalized title.
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.url || "")
      ? (hostOf(it.url) + "|" + (it.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim())
      : (it.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/* ---------------- backend 1: Google News RSS ---------------- */

async function fetchGoogleNews(q, when, limit) {
  const fullQuery = /^\d+[hdm]$/.test(when) ? `${q} when:${when}` : q;
  const feedUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}` +
    `&hl=en-US&gl=US&ceid=US:en`;

  let res;
  try {
    res = await fetchWithRetry(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "google", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "google", detail: `HTTP ${res.status}` };

  const xml = await res.text();
  const items = parseFeed(xml).slice(0, limit).map((raw) => {
    const decoded = decodeGoogleLink(raw.link);
    let title = raw.title;
    if (raw.source && title.endsWith(` - ${raw.source}`)) {
      title = title.slice(0, -(raw.source.length + 3));
    }
    let snippet = stripTags(raw.description);
    if (!snippet || snippet.startsWith(title.slice(0, 40))) snippet = "";

    return {
      id: hashId(raw.link || raw.title),
      title,
      url: decoded || raw.link,
      urlResolved: Boolean(decoded),
      source: raw.source || "",
      sourceDomain: raw.sourceUrl ? hostOf(raw.sourceUrl) : "",
      publishedAt: toIso(raw.pubDate),
      snippet,
    };
  });

  return {
    ok: true, type: "news", backend: "google", query: fullQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

/* ---------------- backend 2: GDELT DOC 2.0 ---------------- */

async function fetchGdelt(q, when, limit) {
  // Translate Google-style query syntax to GDELT's:
  //   site:domain.com → domainis:domain.com ; strip any stray when: tokens.
  const tokens = q.split(/\s+/).filter(Boolean);
  const parts = [];
  for (const t of tokens) {
    const site = t.match(/^site:(.+)$/i);
    if (site) { parts.push(`domainis:${site[1].replace(/^www\./, "")}`); continue; }
    if (/^when:/i.test(t)) continue;
    parts.push(t);
  }
  const gdeltQuery = parts.join(" ");

  // timespan: <n>min|h|d|w|m. Default 3d to mirror the app's window.
  const timespan = /^\d+(min|h|d|w|m)$/.test(when) ? when : "3d";

  const apiUrl =
    `https://api.gdeltproject.org/api/v2/doc/doc` +
    `?query=${encodeURIComponent(gdeltQuery)}` +
    `&mode=ArtList&format=json&sort=DateDesc` +
    `&timespan=${timespan}&maxrecords=${limit}`;

  let res;
  try {
    // GDELT rejects/rate-limits requests without a User-Agent.
    res = await fetchWithRetry(apiUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return { ok: false, backend: "gdelt", detail: String(err) };
  }
  if (!res.ok) return { ok: false, backend: "gdelt", detail: `HTTP ${res.status}` };

  // GDELT sometimes returns plain-text errors with HTTP 200 — guard the parse.
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, backend: "gdelt", detail: `non-JSON: ${text.slice(0, 120)}` };
  }

  const items = (data.articles || [])
    .filter((a) => a.title && a.url)
    .slice(0, limit)
    .map((a) => ({
      id: hashId(a.url),
      title: a.title,
      url: a.url,            // direct publisher URL — no redirect wrapper
      urlResolved: true,
      source: a.domain || "",
      sourceDomain: a.domain || "",
      publishedAt: gdeltDate(a.seendate),
      snippet: "",           // GDELT ArtList has no snippets — titles carry clustering
      language: a.language || "",
    }));

  return {
    ok: true, type: "news", backend: "gdelt", query: gdeltQuery,
    fetchedAt: new Date().toISOString(), items,
  };
}

function gdeltDate(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

/* ================= rss: any user-supplied feed ================= */

async function handleRss(url) {
  const feedUrl = (url.searchParams.get("url") || "").trim();
  if (!feedUrl) return json({ ok: false, type: "rss", error: "missing_url" }, 400);
  if (!/^https?:\/\//i.test(feedUrl)) {
    return json({ ok: false, type: "rss", error: "bad_url", detail: "must be http(s)" }, 400);
  }
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  if (!/<(item|entry)[\s>]/i.test(xml)) {
    return json({ ok: false, type: "rss", query: feedUrl, error: "not_a_feed", detail: xml.slice(0, 120) });
  }

  const feedTitle = feedDocTitle(xml);
  const host = hostOf(feedUrl);
  const items = parseFeed(xml).slice(0, limit).map((raw) => ({
    id: hashId(raw.link || raw.title),
    title: raw.title,
    url: raw.link,
    urlResolved: true,
    source: raw.source || feedTitle || host,
    sourceDomain: raw.link ? hostOf(raw.link) : host,
    publishedAt: toIso(raw.pubDate),
    snippet: stripTags(raw.description).slice(0, 300),
  }));

  return json({ ok: true, type: "rss", query: feedUrl, fetchedAt: new Date().toISOString(), items });
}

/* ================= youtube: per-channel Atom feed ================= */

async function handleYouTube(url) {
  const raw = (url.searchParams.get("channel") || "").trim();
  if (!raw) return json({ ok: false, type: "youtube", error: "missing_channel" }, 400);
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  let channelId;
  try {
    channelId = await resolveYouTubeChannelId(raw);
  } catch (err) {
    return json({ ok: false, type: "youtube", query: raw, error: "youtube_resolve_failed", detail: String(err) });
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let res;
  try {
    res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "youtube", query: raw, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    return json({ ok: false, type: "youtube", query: raw, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  const channelTitle = feedDocTitle(xml) || raw;
  const items = parseFeed(xml).slice(0, limit).map((raw2) => {
    const vid = raw2.ytVideoId ||
      (raw2.link.match(/[?&]v=([\w-]+)/) || [])[1] || "";
    return {
      id: hashId(vid || raw2.link || raw2.title),
      title: raw2.title,
      url: vid ? `https://www.youtube.com/watch?v=${vid}` : raw2.link,
      urlResolved: true,
      source: channelTitle,
      sourceDomain: "youtube.com",
      publishedAt: toIso(raw2.pubDate),
      snippet: stripTags(raw2.description).slice(0, 300),
    };
  });

  return json({ ok: true, type: "youtube", query: raw, channelId, fetchedAt: new Date().toISOString(), items });
}

// Resolve UC id / @handle / channel URL / feed URL → "UC…" channel id.
async function resolveYouTubeChannelId(input) {
  // 1. Already a bare channel id.
  if (/^UC[\w-]{20,}$/.test(input)) return input;

  // 2. A feed or channel URL that already carries the id.
  const idInUrl = input.match(/channel_id=(UC[\w-]+)/) || input.match(/\/channel\/(UC[\w-]+)/);
  if (idInUrl) return idInUrl[1];

  // 3. @handle or channel URL → fetch the page and scrape the id.
  let pageUrl;
  if (/^https?:\/\//i.test(input)) {
    pageUrl = input;
  } else if (input.startsWith("@")) {
    pageUrl = `https://www.youtube.com/${input}`;
  } else {
    pageUrl = `https://www.youtube.com/@${input.replace(/^\/+/, "")}`;
  }

  const res = await fetch(pageUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`channel page HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/"channelId":"(UC[\w-]+)"/) ||
            html.match(/\/channel\/(UC[\w-]+)/) ||
            html.match(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]+)"/);
  if (!m) throw new Error("channelId not found on page");
  return m[1];
}

/* ================= feed parsing (RSS <item> + Atom <entry>) ================= */

function parseFeed(xml) {
  const items = [];
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const isAtom = m[1].toLowerCase() === "entry";
    const block = m[2];
    items.push(isAtom ? parseAtomEntry(block) : parseRssItem(block));
  }
  return items;
}

function parseRssItem(block) {
  const sourceMatch = block.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
  return {
    title: pick(block, "title"),
    link: pick(block, "link"),
    pubDate: pick(block, "pubDate") || pick(block, "dc:date"),
    description: pick(block, "description") || pick(block, "content:encoded"),
    sourceUrl: sourceMatch ? sourceMatch[1] : "",
    source: sourceMatch ? clean(sourceMatch[2]) : "",
    ytVideoId: "",
  };
}

function parseAtomEntry(block) {
  // Atom <link href="…"> — prefer rel="alternate"/no rel; skip rel="self".
  let link = "";
  const linkRe = /<link\b([^>]*)\/?>/g;
  let lm;
  while ((lm = linkRe.exec(block)) !== null) {
    const attrs = lm[1];
    if (/rel="self"/.test(attrs)) continue;
    const href = attrs.match(/href="([^"]*)"/);
    if (href) { link = clean(href[1]); if (!/rel=/.test(attrs) || /rel="alternate"/.test(attrs)) break; }
  }
  return {
    title: pick(block, "title"),
    link,
    pubDate: pick(block, "published") || pick(block, "updated"),
    description: pick(block, "media:description") || pick(block, "summary") || pick(block, "content"),
    sourceUrl: "",
    source: "",
    ytVideoId: pick(block, "yt:videoId"),
  };
}

function feedDocTitle(xml) {
  // Title of the feed/channel itself (first <title> before any item/entry).
  const head = xml.split(/<(?:item|entry)\b/i)[0];
  return pick(head, "title");
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/* ================= Google link decoding (unchanged) =================
   Works only on the old link format; Google has fully migrated to a
   locked format resolvable only via their 429-prone batchexecute
   endpoint, which we deliberately avoid. Redirect links still open
   the correct article. GDELT items don't need this at all. */

function decodeGoogleLink(link) {
  try {
    const m = (link || "").match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    if (bin.includes("AU_yqL")) return null;
    const urlMatch = bin.match(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
    if (!urlMatch) return null;
    const u = urlMatch[0];
    return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(u) ? u : null;
  } catch {
    return null;
  }
}

/* ================= small helpers ================= */

// Retry only server-transient statuses (502/503/504) and network errors.
// We deliberately do NOT retry 429: its rate-limit window is seconds, so a
// sub-second retry just guarantees another 429 and hammers the upstream. On 429
// we return immediately and let the other backend / response cache cover it.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
async function fetchWithRetry(url, opts, { retries = 2, baseMs = 700 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, baseMs * attempt + Math.floor(Math.random() * 300)));
    }
    try {
      const res = await fetch(url, opts);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === retries) return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
    }
  }
  if (lastErr) throw lastErr;
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function toIso(d) {
  const t = new Date(d);
  return isNaN(t.getTime()) ? "" : t.toISOString();
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

----END CORRECTED1 V5----