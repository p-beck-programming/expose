/* ═══════════════════════════════════════════════
   EXPOSÉ — dossier.js
   UI layer for filed articles. Renders the Dossier
   column on the board, runs the file-article modal,
   and handles "file" actions from subtopic cards.
   Data lives in ArticleService (article.service.js).

   Migration to Vite+React:
   - buildColumn() → <DossierColumn />
   - modal         → <FileArticleModal />
   ═══════════════════════════════════════════════ */

const Dossier = (() => {

  const $ = id => document.getElementById(id);

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── Board column ── */

  function buildColumn() {
    const articles = ArticleService.list().slice(0, 12);
    const total    = ArticleService.count();

    const col = document.createElement('div');
    col.className = 'kanban-col dossier-col';
    col.id = 'dossier-col';
    col.innerHTML = `
      <div class="col-header" onclick="window.location.href='library.html'" title="Open the library">
        <div class="col-title-wrap">
          <div class="col-name">Dossier</div>
          <div class="col-meta"><span class="col-subtopic-count">${total} filed</span></div>
        </div>
        <div class="col-header-right">
          <button class="col-menu-btn" title="Open library"
            onclick="event.stopPropagation();window.location.href='library.html'">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 2h7v7"/><path d="M12 2L5.5 8.5"/><path d="M10 8v4H2V4h4"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="col-body">
        <button class="intake-btn" onclick="event.stopPropagation();Dossier.openModal()">+ FILE AN ARTICLE — PASTE A LINK</button>
        ${articles.map(cardHtml).join('')}
      </div>`;
    return col;
  }

  function cardHtml(a) {
    return `
      <div class="dossier-card" data-article-id="${esc(a.id)}">
        <button class="dossier-remove" title="Remove from dossier" onclick="Dossier.removeArticle('${esc(a.id)}')">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
        <div class="dossier-card-title">
          <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        </div>
        <div class="dossier-card-meta">
          <span class="src">${esc(a.source)}</span>
          ${a.topicName ? `<span class="topic-tag">${esc(a.topicName)}</span>` : ''}
          <span>${esc((a.filedAt || '').slice(0, 10))}</span>
        </div>
        ${a.note ? `<div class="dossier-card-note">// ${esc(a.note)}</div>` : ''}
      </div>`;
  }

  function refresh() {
    const existing = $('dossier-col');
    if (ArticleService.count() > 0) {
      const newCol = buildColumn();
      if (existing) existing.replaceWith(newCol);
      else document.getElementById('kanban-area')?.appendChild(newCol);
    } else if (existing) {
      existing.remove();
    }
  }

  function removeArticle(id) {
    ArticleService.remove(id);
    refresh();
    document.dispatchEvent(new CustomEvent('dossier:changed'));
  }

  /* ── File-article modal ── */

  async function openModal(prefill = {}) {
    const bd = $('dossier-backdrop');
    if (!bd) return;

    $('dossier-url').value   = prefill.url   || '';
    $('dossier-title').value = prefill.title || '';
    $('dossier-note').value  = '';
    hideError();

    // Topic select — value carries "id|name" so both are saved.
    const sel = $('dossier-topic');
    try {
      const topics = await TopicService.getTopics();
      sel.innerHTML = '<option value="">No topic</option>' +
        topics.map(t => `<option value="${esc(t.id)}|${esc(t.name)}">${esc(t.name)}</option>`).join('');
      if (prefill.topicId) {
        const opt = [...sel.options].find(o => o.value.startsWith(prefill.topicId + '|'));
        if (opt) sel.value = opt.value;
      }
    } catch { sel.innerHTML = '<option value="">No topic</option>'; }

    bd.classList.add('open');
    setTimeout(() => $(prefill.url ? 'dossier-note' : 'dossier-url')?.focus(), 60);
  }

  function closeModal() { $('dossier-backdrop')?.classList.remove('open'); }
  function handleBackdrop(e) { if (e.target === $('dossier-backdrop')) closeModal(); }

  function showError(msg) {
    const el = $('dossier-error');
    if (el) { el.textContent = msg; el.classList.add('visible'); }
  }
  function hideError() { $('dossier-error')?.classList.remove('visible'); }

  function save() {
    const tv = $('dossier-topic')?.value || '';
    const sep = tv.indexOf('|');
    const result = ArticleService.add({
      topicId:   sep > -1 ? tv.slice(0, sep) : '',
      topicName: sep > -1 ? tv.slice(sep + 1) : '',
      title:     $('dossier-title')?.value,
      url:       $('dossier-url')?.value,
      note:      $('dossier-note')?.value,
    });
    if (!result.success) {
      showError(result.error === 'DUPLICATE'
        ? 'That link is already filed.'
        : 'Enter a valid link — full URL or bare domain.');
      return;
    }
    closeModal();
    refresh();
    document.dispatchEvent(new CustomEvent('dossier:changed'));
  }

  /* ── File from a subtopic card's source list ── */
  function fileFromButton(btn) {
    const card = btn.closest('.subtopic-card');
    openModal({
      url:     btn.dataset.url    || '',
      title:   btn.dataset.title  || '',
      topicId: card?.dataset.topicId || '',
    });
  }

  return { buildColumn, refresh, removeArticle, openModal, closeModal, handleBackdrop, save, fileFromButton };
})();

window.Dossier = Dossier;
