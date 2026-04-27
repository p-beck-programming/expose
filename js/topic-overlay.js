/* ═══════════════════════════════════════════════
   EXPOSÉ — topic-overlay.js
   Topic creation overlay — multi-step flow.

   Deployment note:
   - Import in dashboard.html:
     <script src="js/topic-overlay.js" defer></script>
   - Depends on: auth.service.js, topic.service.js (stub below)
   - Dispatches a custom event 'topic:created' on the document
     when a topic is successfully created. Dashboard listens
     for this to refresh the kanban.

   Migration to Vite+React:
   - This module becomes <TopicOverlay /> component
   - Sources state maps to useState([])
   - TopicService.create() maps to a POST /api/topics call
   ═══════════════════════════════════════════════ */

/* ── Stub topic service (replace with real API later) ── */
const TopicService = (() => {
  const KEY = 'expose_topics_v1';
  function getAll() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
  }
  function save(topics) { localStorage.setItem(KEY, JSON.stringify(topics)); }
  return {
    async create(topicData) {
      await new Promise(r => setTimeout(r, 700)); // simulate latency
      const all = getAll();
      const topic = {
        id: 't_' + Date.now(),
        name: topicData.name,
        sources: topicData.sources,
        allSourcesEnabled: topicData.allSourcesEnabled,
        createdAt: new Date().toISOString(),
        subtopics: [],
        heatScore: 0,
      };
      all.unshift(topic);
      save(all);
      return { success: true, topic };
    },
    getAll,
  };
})();

/* ── Suggestions for step 1 ── */
const SUGGESTIONS = [
  'AI regulation', 'Gaza ceasefire', 'TSMC earnings',
  'Climate policy', 'Fed interest rates', 'SpaceX launch',
];

/* ── Overlay state ── */
const Overlay = (() => {
  let currentStep = 1;
  const totalSteps = 2;

  // Sources per type: { x: [], reddit: [], web: [] }
  let sources = { x: [], reddit: [], web: [] };
  let xMode = 'topic'; // 'topic' | 'handle'
  let allSourcesEnabled = false;

  /* ── DOM refs (resolved at open time) ── */
  const $ = id => document.getElementById(id);

  /* ── Open / Close ── */
  function open() {
    reset();
    const backdrop = $('overlay-backdrop');
    backdrop.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => backdrop.classList.add('open'));
    });
    setTimeout(() => $('topic-name-input')?.focus(), 250);
    document.addEventListener('keydown', onKeyDown);
  }

  function close() {
    const backdrop = $('overlay-backdrop');
    backdrop.classList.remove('open');
    document.removeEventListener('keydown', onKeyDown);
    setTimeout(() => { backdrop.style.display = 'none'; }, 240);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.shiftKey) {
      if (currentStep === 1) goToStep2();
    }
  }

  /* ── Reset ── */
  function reset() {
    currentStep = 1;
    sources = { x: [], reddit: [], web: [] };
    xMode = 'topic';
    allSourcesEnabled = false;

    // Clear inputs
    const nameInput = $('topic-name-input');
    if (nameInput) { nameInput.value = ''; nameInput.classList.remove('error'); }
    ['x-source-input', 'reddit-input', 'web-input'].forEach(id => {
      const el = $(id); if (el) el.value = '';
    });
    // Reset toggle
    const toggle = $('all-sources-toggle');
    if (toggle) toggle.classList.remove('on');
    const block = $('all-sources-block');
    if (block) block.classList.remove('enabled');
    allSourcesEnabled = false;

    // Collapse all source sections
    document.querySelectorAll('.source-section').forEach(s => s.classList.remove('expanded'));
    // Reset X mode
    setXMode('topic');
    renderTags();
    updateStep();
  }

  /* ── Steps ── */
  function updateStep() {
    // Progress pips
    document.querySelectorAll('.progress-pip').forEach((pip, i) => {
      pip.classList.toggle('done', i + 1 < currentStep);
      pip.classList.toggle('active', i + 1 === currentStep);
    });
    // Step panels
    document.querySelectorAll('.overlay-step').forEach((el, i) => {
      el.classList.toggle('active', i + 1 === currentStep);
    });
    // Step label
    const label = $('overlay-step-label');
    if (label) label.textContent = `Step ${currentStep} of ${totalSteps}`;
    // Title + sub
    const title = $('overlay-title');
    const sub   = $('overlay-sub');
    if (currentStep === 1) {
      if (title) title.textContent = 'New topic';
      if (sub)   sub.textContent   = 'What do you want Exposé to monitor?';
    } else {
      const name = $('topic-name-input')?.value?.trim() || 'this topic';
      if (title) title.textContent = 'Add sources';
      if (sub)   sub.textContent   = `Where should Exposé look for "${name}"?`;
    }
    // Footer buttons
    const backBtn = $('overlay-back-btn');
    const nextBtn = $('overlay-next-btn');
    const hint    = $('overlay-footer-hint');
    if (backBtn) backBtn.style.display = currentStep > 1 ? 'inline-flex' : 'none';
    if (nextBtn) {
      const label = nextBtn.querySelector('.btn-next-label');
      if (label) label.textContent = currentStep === totalSteps ? 'Start monitoring' : 'Continue';
      const icon  = nextBtn.querySelector('.next-arrow');
      if (icon) icon.style.display = currentStep === totalSteps ? 'none' : 'block';
    }
    if (hint) {
      hint.style.display = currentStep === 1 ? 'flex' : 'none';
    }
  }

  function goToStep2() {
    const input = $('topic-name-input');
    const val   = input?.value?.trim();
    const err   = $('topic-name-error');

    if (!val) {
      input?.classList.add('error');
      if (err) { err.classList.add('visible'); err.querySelector('span').textContent = 'Please enter a topic name.'; }
      input?.focus(); return;
    }
    if (val.length < 3) {
      input?.classList.add('error');
      if (err) { err.classList.add('visible'); err.querySelector('span').textContent = 'Topic name must be at least 3 characters.'; }
      input?.focus(); return;
    }
    input?.classList.remove('error');
    if (err) err.classList.remove('visible');
    currentStep = 2;
    updateStep();
  }

  async function submit() {
    const btn = $('overlay-next-btn');

    // Require at least one source or all-sources enabled
    const totalSources = sources.x.length + sources.reddit.length + sources.web.length;
    const hint = $('no-sources-hint');
    if (totalSources === 0 && !allSourcesEnabled) {
      if (hint) { hint.style.display = 'flex'; }
      // Pulse source sections
      document.querySelectorAll('.source-section').forEach(s => {
        s.style.animation = 'none';
        requestAnimationFrame(() => { s.style.animation = ''; });
      });
      return;
    }
    if (hint) hint.style.display = 'none';

    if (btn) { btn.classList.add('loading'); btn.disabled = true; }

    const result = await TopicService.create({
      name: $('topic-name-input')?.value?.trim(),
      sources,
      allSourcesEnabled,
    });

    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }

    if (result.success) {
      // Dispatch event so dashboard can pick it up
      document.dispatchEvent(new CustomEvent('topic:created', { detail: result.topic }));
      close();
    }
  }

  /* ── Source management ── */
  function setXMode(mode) {
    xMode = mode;
    const topicBtn  = $('x-mode-topic');
    const handleBtn = $('x-mode-handle');
    const prefix    = $('x-prefix');
    const input     = $('x-source-input');
    const placeholder = $('x-placeholder');

    if (topicBtn)  topicBtn.classList.toggle('active',  mode === 'topic');
    if (handleBtn) handleBtn.classList.toggle('active', mode === 'handle');

    if (prefix) prefix.style.display = mode === 'handle' ? 'flex' : 'none';
    if (input) {
      input.classList.toggle('has-prefix', mode === 'handle');
      input.placeholder = mode === 'handle' ? 'username' : 'e.g. AI regulation, GPT';
    }
    if (input) input.value = '';
  }

  function addSource(type) {
    let value = '';
    if (type === 'x') {
      const raw = $('x-source-input')?.value?.trim();
      if (!raw) return;
      value = xMode === 'handle'
        ? '@' + raw.replace(/^@/, '')
        : raw;
      if ($('x-source-input')) $('x-source-input').value = '';
    } else if (type === 'reddit') {
      const raw = $('reddit-input')?.value?.trim().replace(/^r\//, '');
      if (!raw) return;
      value = 'r/' + raw;
      if ($('reddit-input')) $('reddit-input').value = '';
    } else if (type === 'web') {
      const raw = $('web-input')?.value?.trim()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      if (!raw) return;
      value = raw;
      if ($('web-input')) $('web-input').value = '';
    }
    if (!value) return;
    if (sources[type].includes(value)) return; // no duplicates
    sources[type].push(value);
    renderTags();
    updateSourceCounts();
    // Dismiss no-sources hint
    const hint = $('no-sources-hint');
    if (hint) hint.style.display = 'none';
  }

  function removeSource(type, value) {
    sources[type] = sources[type].filter(v => v !== value);
    renderTags();
    updateSourceCounts();
  }

  function renderTags() {
    Object.keys(sources).forEach(type => {
      const container = $(`${type}-tags`);
      if (!container) return;
      container.innerHTML = '';
      sources[type].forEach(val => {
        const tag = document.createElement('div');
        tag.className = 'source-tag';
        tag.innerHTML = `
          <span>${escHtml(val)}</span>
          <button class="tag-remove" onclick="Overlay.removeSource('${type}', '${escHtml(val)}')">
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
            </svg>
          </button>`;
        container.appendChild(tag);
      });
    });
  }

  function updateSourceCounts() {
    const counts = { x: sources.x.length, reddit: sources.reddit.length, web: sources.web.length };
    Object.entries(counts).forEach(([type, count]) => {
      const el = $(`${type}-count`);
      if (el) el.textContent = count > 0 ? count : '';
    });
  }

  function toggleSection(type) {
    const section = $(`source-section-${type}`);
    if (!section) return;
    const wasExpanded = section.classList.contains('expanded');
    // Close all others
    document.querySelectorAll('.source-section').forEach(s => s.classList.remove('expanded'));
    if (!wasExpanded) section.classList.add('expanded');
  }

  function toggleAllSources() {
    allSourcesEnabled = !allSourcesEnabled;
    const toggle = $('all-sources-toggle');
    const block  = $('all-sources-block');
    if (toggle) toggle.classList.toggle('on', allSourcesEnabled);
    if (block)  block.classList.toggle('enabled', allSourcesEnabled);
  }

  function setSuggestion(text) {
    const input = $('topic-name-input');
    if (input) { input.value = text; input.focus(); updateCharCount(text); }
  }

  function updateCharCount(val) {
    const el = $('char-count');
    if (!el) return;
    const max = 60;
    el.textContent = `${val.length} / ${max}`;
    el.classList.toggle('warn', val.length > max * 0.8);
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── Public API ── */
  return { open, close, goToStep2, submit, addSource, removeSource, setXMode, toggleSection, toggleAllSources, setSuggestion, updateCharCount };
})();

/* Expose globally for inline onclick handlers */
window.Overlay = Overlay;
