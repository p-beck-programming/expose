/* ═══════════════════════════════════════════════
   EXPOSÉ — article.service.js  (v2: Supabase Postgres)
   Data layer for filed articles (the Dossier / Library).

   v2: rows live in the Supabase `articles` table so the Library
   follows the user across devices. The v1 API was synchronous and
   dossier.js/library.html call it synchronously — so this keeps a
   sync facade over an in-memory cache:

     await ArticleService.load()   ← pages call this once at boot
     list()/count()                ← read the cache (sync, as before)
     add()/remove()/updateNote()   ← mutate the cache instantly, then
                                     persist in the background

   Ids are client-generated UUIDs so add() can return the finished
   article without waiting on the network.
   ═══════════════════════════════════════════════ */

const ArticleService = (() => {

  let cache = [];

  function uid() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
          (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  }

  function rowToArticle(r) {
    return {
      id:        r.id,
      topicId:   r.topic_id || '',
      topicName: r.topic_name || '',
      title:     r.title,
      url:       r.url,
      source:    r.source || '',
      note:      r.note || '',
      filedAt:   r.filed_at,
    };
  }

  /* Load the user's articles into the cache — call once per page boot,
     after auth. Safe to call again to re-sync. */
  async function load() {
    try {
      const { data, error } = await sb.from('articles')
        .select('*')
        .order('filed_at', { ascending: false });
      if (error) throw error;
      cache = (data || []).map(rowToArticle);
    } catch (e) {
      console.warn('[Exposé] articles load failed:', e?.message || e);
    }
    return cache;
  }

  /* Normalize any pasted link: full URLs, bare domains, with or
     without https:// — all accepted. Returns { href, domain }. */
  function normalizeUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (!u.hostname.includes('.')) return null;
      return { href: u.href, domain: u.hostname.replace(/^www\./, '') };
    } catch { return null; }
  }

  /* ── CRUD (sync facade, background persistence) ── */

  function list(topicId) {
    const all = cache.slice().sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));
    return topicId ? all.filter(a => a.topicId === topicId) : all;
  }

  function add({ topicId, topicName, title, url, note, source }) {
    const norm = normalizeUrl(url);
    if (!norm) return { success: false, error: 'INVALID_URL' };

    if (cache.some(a => a.url === norm.href)) {
      return { success: false, error: 'DUPLICATE', message: 'Already filed.' };
    }

    const article = {
      id:        uid(),
      topicId:   topicId   || '',
      topicName: topicName || '',
      title:     (title || '').trim() || norm.domain + new URL(norm.href).pathname.replace(/\/$/, ''),
      url:       norm.href,
      source:    source || norm.domain,
      note:      (note || '').trim(),
      filedAt:   new Date().toISOString(),
    };
    cache.push(article);

    sb.from('articles').insert({
      id:         article.id,
      topic_id:   article.topicId,
      topic_name: article.topicName,
      title:      article.title,
      url:        article.url,
      source:     article.source,
      note:       article.note,
      filed_at:   article.filedAt,
    }).then(({ error }) => {
      if (error) console.warn('[Exposé] article save failed:', error.message);
    });

    return { success: true, article };
  }

  function remove(id) {
    cache = cache.filter(a => a.id !== id);
    sb.from('articles').delete().eq('id', id).then(({ error }) => {
      if (error) console.warn('[Exposé] article delete failed:', error.message);
    });
    return { success: true };
  }

  function updateNote(id, note) {
    const a = cache.find(x => x.id === id);
    if (!a) return { success: false, error: 'NOT_FOUND' };
    a.note = String(note || '').trim();
    sb.from('articles').update({ note: a.note }).eq('id', id).then(({ error }) => {
      if (error) console.warn('[Exposé] note save failed:', error.message);
    });
    return { success: true, article: a };
  }

  function count(topicId) {
    return list(topicId).length;
  }

  return { load, list, add, remove, updateNote, count, normalizeUrl };
})();

window.ArticleService = ArticleService;
