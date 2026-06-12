/* ═══════════════════════════════════════════════
   EXPOSÉ — article.service.js
   Data layer for filed articles (the Dossier).
   localStorage-backed, same service pattern as
   TopicService for the future API migration:
     list()            → GET    /api/articles
     add(data)         → POST   /api/articles
     remove(id)        → DELETE /api/articles/:id
     updateNote(id, n) → PATCH  /api/articles/:id
   ═══════════════════════════════════════════════ */

const ArticleService = (() => {

  const KEY = 'expose_articles_v1';

  function uid() { return '_' + Math.random().toString(36).slice(2, 10); }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
  }
  function write(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
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

  /* ── CRUD ── */

  function list(topicId) {
    const all = read().sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));
    return topicId ? all.filter(a => a.topicId === topicId) : all;
  }

  function add({ topicId, topicName, title, url, note, source }) {
    const norm = normalizeUrl(url);
    if (!norm) return { success: false, error: 'INVALID_URL' };

    const all = read();
    if (all.some(a => a.url === norm.href)) {
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
    all.push(article);
    write(all);
    return { success: true, article };
  }

  function remove(id) {
    write(read().filter(a => a.id !== id));
    return { success: true };
  }

  function updateNote(id, note) {
    const all = read();
    const a = all.find(x => x.id === id);
    if (!a) return { success: false, error: 'NOT_FOUND' };
    a.note = String(note || '').trim();
    write(all);
    return { success: true, article: a };
  }

  function count(topicId) {
    return list(topicId).length;
  }

  return { list, add, remove, updateNote, count, normalizeUrl };
})();

window.ArticleService = ArticleService;
