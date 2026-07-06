/**
 * Exposé proxy — Worker v7 (Reddit sources: per-subreddit topic search via .rss)
 * Paste over the existing Worker code in the Cloudflare editor and Deploy.
 *
 * Endpoints (unchanged shape — gemini.service.js consumes the same item shape):
 *   ?type=news    → Google News RSS, fall back to GDELT DOC 2.0
 *   ?type=rss     → fetch + parse ANY user-supplied RSS 2.0 or Atom feed
 *   ?type=youtube → resolve a channel (UC id / @handle / channel URL) to its Atom
 *                   feed (youtube.com/feeds/videos.xml?channel_id=…) and parse it
 *   ?type=reddit  → subreddit posts matching a topic. &sub= accepts "worldnews",
 *                   "r/worldnews", or a full subreddit URL. With &q= it hits
 *                   reddit.com/r/<sub>/search.rss?q=…&restrict_sr=on&sort=new
 *                   (topic-relevant posts only); without q, the sub's plain .rss.
 *                   Link posts resolve to the OUTBOUND article URL; self posts
 *                   keep the reddit permalink. The "submitted by /u/…" boilerplate
 *                   is stripped from snippets so it never reaches clustering.
 * All feed types share one parser (parseFeed) for RSS <item> and Atom <entry>.
 *
 * WHY v7: Reddit was dropped in v4 because its unauthenticated JSON API 403-blocks
 * datacenter IPs — but its .rss endpoints serve Cloudflare egress fine (verified),
 * and per-sub search.rss gives topic relevance for free. Rate-limit protections
 * from v6 (success cache, stale fallback, spaced 429 retry) all apply to Reddit
 * requests automatically since they run through the same fetch path.
 *
 * v6: users hitting "news providers are limiting rates" saw most sources fail
 * with no recourse — retrying immediately just re-triggered the same 429s. v6:
 *
 *   • 429 IS now retried — exactly once, after a 1.5–2.2s pause (the rate window is
 *     seconds; one properly-spaced retry usually clears it, while v5's policy of
 *     never retrying guaranteed a failed sweep). 502/503/504 keep the fast retries.
 *   • STALE FALLBACK: every successful payload is also cached in a long-lived
 *     "stale" slot (STALE_TTL, 6h). When an upstream fails after retries, the
 *     Worker serves the last good payload for that exact query (marked
 *     `stale:true`, backend suffixed "(stale)") instead of an error. A spammed
 *     retry now degrades to slightly-old news instead of a dead column.
 *   • Default GDELT window widened 3d → 7d to match the app's new 7-day recency
 *     (client sends when=7d; this covers requests that omit it).
 *
 * v5: broad merge mode made Google-first, GDELT on-demand; success caching (NEWS_TTL).
 * v4: RSS + YouTube source endpoints, Reddit removed.
 */

const PRIMARY = "google"; // "google" | "gdelt" — which news backend to try first
const BROAD_MIN = 10;     // broad mode: only reach for GDELT if Google returns fewer than this
const NEWS_TTL = 600;     // seconds to cache successful feed responses (caches.default)
const STALE_TTL = 21600;  // seconds to keep the long-lived stale copy used when upstreams fail (6h)

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
    // Second, long-lived slot for the same query — only consulted when upstreams fail.
    const staleKey = new Request(url.toString() + "&__stale=1", { method: "GET" });
    const hit      = await cache.match(cacheKey);
    if (hit) return hit;

    let res;
    try {
      if (type === "news") res = await handleNews(url);
      else if (type === "rss") res = await handleRss(url);
      else if (type === "youtube") res = await handleYouTube(url);
      else if (type === "reddit") res = await handleReddit(url);
      else res = json({ ok: false, type, error: "unknown_type" }, 400);
    } catch (err) {
      res = json({ ok: false, type, error: "proxy_failure", detail: String(err) }, 502);
    }

    // Cache only successful payloads. json() returns HTTP 200 even for ok:false,
    // so gate on the parsed body — never cache an error (it must retry next time).
    try {
      const data = await res.clone().json();
      if (data && data.ok) {
        const put = Promise.all([
          cache.put(cacheKey, cacheable(data, NEWS_TTL)),
          cache.put(staleKey, cacheable(data, STALE_TTL)),
        ]);
        if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
      } else {
        // Upstream failed even after retries — fall back to the last good payload
        // for this exact query, if we have one. Slightly-old news beats no news.
        const stale = await cache.match(staleKey);
        if (stale) {
          const old = await stale.json();
          old.stale = true;
          old.backend = (old.backend || "cache") + "(stale)";
          return json(old);
        }
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

  // timespan: <n>min|h|d|w|m. Default 7d to mirror the app's window.
  const timespan = /^\d+(min|h|d|w|m)$/.test(when) ? when : "7d";

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

/* ================= reddit: per-subreddit topic search ================= */

async function handleReddit(url) {
  const rawSub = (url.searchParams.get("sub") || "").trim();
  if (!rawSub) return json({ ok: false, type: "reddit", error: "missing_sub" }, 400);
  const sub = normalizeSubreddit(rawSub);
  if (!sub) return json({ ok: false, type: "reddit", error: "bad_sub", detail: rawSub }, 400);

  const q     = (url.searchParams.get("q") || "").trim();
  const when  = (url.searchParams.get("when") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 30);

  // Map the app's rolling window (e.g. 7d, 24h) onto Reddit's t buckets.
  const days = /^(\d+)h$/.test(when) ? parseInt(when, 10) / 24
             : /^(\d+)d$/.test(when) ? parseInt(when, 10) : 7;
  const t = days <= 1 ? "day" : days <= 7 ? "week" : "month";

  // With a topic query, use subreddit-restricted search — only relevant posts.
  // Without one, fall back to the sub's plain feed (hot posts).
  const feedUrl = q
    ? `https://www.reddit.com/r/${sub}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=on&sort=new&t=${t}`
    : `https://www.reddit.com/r/${sub}/.rss`;

  let res;
  try {
    res = await fetchWithRetry(feedUrl, { headers: BROWSER_HEADERS });
  } catch (err) {
    return json({ ok: false, type: "reddit", query: feedUrl, error: "feed_unreachable", detail: String(err) });
  }
  if (!res.ok) {
    // 403/404 usually means a private, banned, or nonexistent subreddit.
    return json({ ok: false, type: "reddit", query: feedUrl, error: "feed_error", detail: `HTTP ${res.status}` });
  }

  const xml = await res.text();
  if (!/<feed[\s>]/i.test(xml)) {
    return json({ ok: false, type: "reddit", query: feedUrl, error: "not_a_feed", detail: xml.slice(0, 120) });
  }

  const items = parseFeed(xml).slice(0, limit).map((raw) => {
    // Reddit's entry content ends with: <a href="…">[link]</a> <a href="…">[comments]</a>
    // For link posts, [link] is the submitted article URL; for self posts it's the
    // permalink. Prefer the outbound article; keep the reddit thread otherwise.
    const linkMatch = (raw.description || "").match(/<a href="([^"]+)">\s*\[link\]/i);
    const outbound  = linkMatch ? linkMatch[1] : "";
    const outHost   = outbound ? hostOf(outbound) : "";
    const external  = outHost && outHost !== "reddit.com" && !outHost.endsWith(".reddit.com") ? outbound : "";

    // Self-post body (if any) minus the "submitted by /u/… [link] [comments]" boilerplate.
    const snippet = stripTags(raw.description || "").split(/submitted by/i)[0].trim().slice(0, 300);

    return {
      id: hashId(raw.link || raw.title),
      title: raw.title,
      url: external || raw.link,
      urlResolved: true,
      source: `r/${sub}`,
      sourceDomain: external ? outHost : "reddit.com",
      publishedAt: toIso(raw.pubDate),
      snippet,
    };
  });

  return json({ ok: true, type: "reddit", query: q || feedUrl, subreddit: sub, fetchedAt: new Date().toISOString(), items });
}

// "worldnews" | "r/worldnews" | "/r/worldnews/" | reddit.com URL (with or
// without protocol) → bare sub name.
function normalizeSubreddit(input) {
  const s = String(input).trim()
    .replace(/^(https?:\/\/)?(www\.|old\.|new\.)?reddit\.com/i, "")
    .replace(/^\/+/, "")
    .replace(/^r\//i, "")
    .split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/.test(s) ? s : "";
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

// Retry policy:
//   502/503/504 + network errors → fast retries (baseMs backoff), up to `retries`.
//   429 → ONE retry after a 1.5–2.2s pause. The rate window is seconds, so a
//   sub-second retry guarantees another 429 — but one properly-spaced retry
//   usually clears it. More than one just hammers the upstream for nothing.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
async function fetchWithRetry(url, opts, { retries = 2, baseMs = 700 } = {}) {
  let lastErr;
  let tried429 = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, baseMs * attempt + Math.floor(Math.random() * 300)));
    }
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 && !tried429) {
        tried429 = true;
        await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 700)));
        const retry = await fetch(url, opts);
        if (retry.ok || attempt === retries) return retry;
        if (!RETRYABLE_STATUS.has(retry.status)) return retry;
        continue;
      }
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

// A Response suitable for caches.default — max-age controls how long it lives.
function cacheable(data, ttl) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8",
               "Cache-Control": `public, max-age=${ttl}` },
  });
}
