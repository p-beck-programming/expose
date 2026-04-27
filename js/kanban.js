/* ═══════════════════════════════════════════════
   EXPOSÉ — kanban.js
   Kanban board: columns, subtopic cards, drag-
   to-reorder, expand/collapse, full-screen overlay,
   tombstones, pinned column.

   Deployment note:
   - Import after topic.service.js in dashboard.html:
     <script src="js/topic.service.js" defer></script>
     <script src="js/kanban.js" defer></script>
   - Listens for 'topic:created' from topic-overlay.js
   - Calls TopicService and GeminiService (stub below)
   - Exports Kanban object to window for dashboard.js

   Migration to React:
   - Kanban.init()       → useEffect on mount
   - renderBoard()       → <KanbanBoard topics={topics} />
   - renderColumn()      → <KanbanColumn topic={topic} />
   - renderCard()        → <SubtopicCard subtopic={sub} />
   - openFullscreen()    → <FullscreenOverlay />
   ═══════════════════════════════════════════════ */

/* ── Gemini stub (replace with gemini.service.js) ── */
const GeminiService = {
  async fetchSubtopics(topic, apiKey) {
    // → In production: calls gemini.service.js which calls
    //   POST https://generativelanguage.googleapis.com/v1beta/...
    //   Returns structured subtopic data from source inflow.
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));

    // Demo data — realistic structure Gemini will return
    const demos = {
      default: [
        {
          id: 's_' + Math.random().toString(36).slice(2),
          name: 'Diplomatic negotiations stall amid new conditions',
          summary: 'Multiple sources report that talks have broken down following new demands introduced by both parties, with mediators expressing concern over the timeline.',
          score: 82,
          sourceCount: 14,
          sources: {
            x:      [{ title: 'Breaking: talks collapse after new terms introduced', source: '@BBCBreaking', url: '' }],
            reddit: [{ title: 'Megathread: latest developments and analysis', source: 'r/worldnews', url: '' }],
            web:    [{ title: 'Ceasefire negotiations falter as deadline passes', source: 'reuters.com', url: 'https://reuters.com' }, { title: 'UN envoy warns of "critical juncture"', source: 'bbc.co.uk', url: 'https://bbc.co.uk' }],
          },
          broadSources: [{ title: 'Historical context: why these talks are different', source: 'foreignpolicy.com', url: '' }, { title: 'Regional powers weigh in on stalled process', source: 'aljazeera.com', url: '' }],
        },
        {
          id: 's_' + Math.random().toString(36).slice(2),
          name: 'Humanitarian corridor agreement reached',
          summary: 'A limited agreement on humanitarian access was signed, though aid organizations warn that conditions on the ground remain dire and access is still restricted.',
          score: 61,
          sourceCount: 8,
          sources: {
            x:      [{ title: 'Aid convoy crosses checkpoint for first time in weeks', source: '@Reuters', url: '' }],
            reddit: [],
            web:    [{ title: 'Partial humanitarian deal offers thin relief', source: 'theguardian.com', url: 'https://theguardian.com' }],
          },
          broadSources: [],
        },
        {
          id: 's_' + Math.random().toString(36).slice(2),
          name: 'International pressure mounts on key stakeholders',
          summary: 'European and Arab nations have issued joint statements calling for immediate action, while the US administration signals a possible shift in its diplomatic approach.',
          score: 44,
          sourceCount: 5,
          sources: {
            x:      [],
            reddit: [{ title: 'EU statement analysis — what does this actually change?', source: 'r/geopolitics', url: '' }],
            web:    [{ title: 'Washington recalibrates its position', source: 'politico.com', url: 'https://politico.com' }],
          },
          broadSources: [{ title: 'G7 communiqué calls for immediate humanitarian pause', source: 'reuters.com', url: '' }],
        },
      ]
    };

    // Log to search log
    await TopicService.appendLog({
      query:        `${topic.name} — subtopic analysis`,
      topicId:      topic.id,
      topicName:    topic.name,
      resultsCount: demos.default.length,
    });

    return { success: true, subtopics: demos.default };
  }
};

/* ── State ── */
const Kanban = (() => {
  let topics = [];
  let dragState = null; // { colEl, startX, startIdx }

  /* ── Init ── */
  async function init() {
    topics = await TopicService.getTopics();
    renderBoard();
    renderSearchLog();

    // Listen for new topics from the overlay
    document.addEventListener('topic:created', async e => {
      const topic = e.detail;
      topics.unshift(topic);
      renderBoard();
      renderSearchLog();
      // Immediately fetch subtopics
      fetchTopicData(topic.id);
    });
  }

  /* ── Fetch subtopics from Gemini ── */
  async function fetchTopicData(topicId) {
    const topic = topics.find(t => t.id === topicId);
    if (!topic) return;

    // Set fetching state
    await TopicService.updateTopic(topicId, { status: 'fetching' });
    topic.status = 'fetching';
    updateColFetchingState(topicId, true);

    const apiKey = getApiKey();
    const result = await GeminiService.fetchSubtopics(topic, apiKey);

    if (result.success) {
      const updated = await TopicService.setSubtopics(topicId, result.subtopics);
      if (updated.success) {
        const idx = topics.findIndex(t => t.id === topicId);
        if (idx !== -1) topics[idx] = updated.topic;
      }
    } else {
      await TopicService.updateTopic(topicId, { status: 'error' });
      topic.status = 'error';
    }

    updateColFetchingState(topicId, false);
    renderColumn(topicId);
    renderSearchLog();
  }

  function getApiKey() {
    try {
      const settings = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      return settings.geminiApiKey || '';
    } catch { return ''; }
  }

  /* ── Full board render ── */
  function renderBoard() {
    const area = document.getElementById('kanban-area');
    if (!area) return;
    area.innerHTML = '';

    // Pinned column always first
    area.appendChild(buildPinnedColumn());

    if (topics.length === 0) {
      area.appendChild(buildEmptyState());
      return;
    }

    // Non-pinned topics as columns
    const sorted = [...topics].sort((a, b) => {
      if (a.pinned !== b.pinned) return 0; // topic pinning is column pinning — handled by col pinned-col class
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    sorted.forEach(topic => {
      area.appendChild(buildColumn(topic));
    });
  }

  /* ── Render a single column in place ── */
  function renderColumn(topicId) {
    const topic = topics.find(t => t.id === topicId);
    if (!topic) return;
    const existing = document.getElementById(`col-${topicId}`);
    if (!existing) { renderBoard(); return; }
    const fresh = buildColumn(topic);
    existing.replaceWith(fresh);
    // Re-render pinned column (pinned subtopics may have changed)
    const pinnedCol = document.getElementById('pinned-col');
    if (pinnedCol) pinnedCol.replaceWith(buildPinnedColumn());
  }

  /* ── Update only the fetching visual state of a column ── */
  function updateColFetchingState(topicId, isFetching) {
    const col = document.getElementById(`col-${topicId}`);
    if (!col) return;
    col.querySelectorAll('.subtopic-card').forEach(c => {
      c.classList.toggle('fetching', isFetching);
    });
  }

  /* ════════════════════════════════
     BUILD PINNED COLUMN
  ════════════════════════════════ */
  function buildPinnedColumn() {
    const pinned = TopicService.getPinnedSubtopics(topics);
    const col = el('div', 'kanban-col pinned-col');
    col.id = 'pinned-col';

    // Header
    const header = el('div', 'col-header');
    header.innerHTML = `
      <span class="col-drag-handle">${dragIcon()}</span>
      <span class="col-pin-icon">${pinIcon()}</span>
      <div class="col-title-wrap">
        <div class="col-name">Pinned</div>
        <div class="col-meta">
          <span class="col-subtopic-count">${pinned.length} subtopic${pinned.length !== 1 ? 's' : ''}</span>
        </div>
      </div>`;
    col.appendChild(header);

    // Body
    const body = el('div', 'col-body');
    if (pinned.length === 0) {
      body.innerHTML = `
        <div class="col-empty">
          <div class="col-empty-ring">${pinIcon(16)}</div>
          <div class="col-empty-text">Pin subtopic cards here<br/>for quick access</div>
        </div>`;
    } else {
      pinned.forEach(sub => {
        body.appendChild(buildCard(sub, sub._topicId, sub._topicName, true));
      });
    }
    col.appendChild(body);
    return col;
  }

  /* ════════════════════════════════
     BUILD TOPIC COLUMN
  ════════════════════════════════ */
  function buildColumn(topic) {
    const col = el('div', 'kanban-col');
    col.id = `col-${topic.id}`;
    col.setAttribute('data-topic-id', topic.id);

    const subtopics  = (topic.subtopics || []).filter(s => !s.pinned);
    const active     = subtopics.filter(s => !s.expired);
    const expired    = subtopics.filter(s => s.expired);
    const unviewed   = TopicService.getUnviewedCount(topic);
    const isFetching = topic.status === 'fetching';

    // ── Header
    const header = el('div', 'col-header');
    header.innerHTML = `
      <span class="col-drag-handle">${dragIcon()}</span>
      <div class="col-title-wrap">
        <div class="col-name" title="${esc(topic.name)}">${esc(topic.name)}</div>
        <div class="col-meta">
          <span class="col-subtopic-count">${active.length} subtopic${active.length !== 1 ? 's' : ''}</span>
          <div class="col-heat">
            ${buildHeatDots(topic.heatScore)}
          </div>
        </div>
      </div>
      <div class="col-header-right">
        ${unviewed > 0 ? `<span class="unviewed-badge">${unviewed}</span>` : ''}
        <button class="col-menu-btn" title="Column options" onclick="Kanban.openColMenu('${topic.id}', event)">
          <svg viewBox="0 0 13 13" fill="currentColor">
            <circle cx="6.5" cy="2.5" r="1.2"/><circle cx="6.5" cy="6.5" r="1.2"/><circle cx="6.5" cy="10.5" r="1.2"/>
          </svg>
        </button>
      </div>`;
    attachColDrag(header, col);
    col.appendChild(header);

    // ── Body
    const body = el('div', 'col-body');

    if (isFetching && active.length === 0) {
      // Show skeleton cards
      [1, 2, 3].forEach(() => body.appendChild(buildSkeleton()));
    } else if (active.length === 0 && !isFetching) {
      body.innerHTML = `
        <div class="col-empty">
          <div class="col-empty-ring">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
              <circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="8.5"/>
              <circle cx="8" cy="10.5" r="0.6" fill="currentColor"/>
            </svg>
          </div>
          <div class="col-empty-text">No subtopics yet.<br/>Data is loading…</div>
        </div>`;
    } else {
      // Sort: highest score first
      const sorted = [...active].sort((a, b) => (b.score || 0) - (a.score || 0));
      sorted.forEach(sub => {
        const card = buildCard(sub, topic.id, topic.name, false, isFetching);
        body.appendChild(card);
      });
    }

    // Tombstones
    expired.forEach(sub => body.appendChild(buildTombstone(sub, topic.id)));

    col.appendChild(body);
    return col;
  }

  function buildHeatDots(score) {
    const max = 5;
    let html = '<div class="heat-dots">';
    for (let i = 0; i < max; i++) {
      let cls = 'heat-dot';
      if (i < score) cls += score >= 4 ? ' fire' : score >= 2 ? ' hot' : ' active';
      html += `<div class="${cls}"></div>`;
    }
    html += '</div>';
    return html;
  }

  /* ════════════════════════════════
     BUILD SUBTOPIC CARD
  ════════════════════════════════ */
  function buildCard(sub, topicId, topicName, inPinnedCol = false, isFetching = false) {
    const card = el('div', [
      'subtopic-card',
      !sub.viewed && !inPinnedCol ? 'unviewed' : '',
      sub.pinned && !inPinnedCol  ? 'pinned' : '',
      isFetching                  ? 'fetching' : '',
    ].filter(Boolean).join(' '));
    card.id = `card-${sub.id}`;
    card.setAttribute('data-subtopic-id', sub.id);
    card.setAttribute('data-topic-id', topicId);

    const scoreClass = sub.score >= 70 ? 'score-high' : sub.score >= 40 ? 'score-mid' : 'score-low';

    // Source bubbles
    const xCount      = (sub.sources?.x      || []).length;
    const redditCount = (sub.sources?.reddit  || []).length;
    const webCount    = (sub.sources?.web     || []).length;
    const bubbles = [
      xCount      > 0 ? `<span class="source-bubble x-bubble">${xLogoSvg(9)}${xCount}</span>` : '',
      redditCount > 0 ? `<span class="source-bubble reddit-bubble">${redditLogoSvg(9)}${redditCount}</span>` : '',
      webCount    > 0 ? `<span class="source-bubble web-bubble">${webSvg(9)}${webCount}</span>` : '',
    ].join('');
    const totalSources = xCount + redditCount + webCount;

    card.innerHTML = `
      <div class="card-header" onclick="Kanban.toggleCard('${sub.id}', '${topicId}', event)">
        <div class="card-header-left">
          <div class="card-identifier">${esc(topicName)}</div>
          <div class="card-title">${esc(sub.name)}</div>
          <div class="card-summary">${esc(sub.summary || '')}</div>
        </div>
        <div class="card-actions">
          <div class="live-badge"><div class="live-badge-dot"></div>LIVE</div>
          <button class="card-action-btn refresh-btn" title="Refresh" onclick="event.stopPropagation();Kanban.refreshCard('${topicId}')">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.5 6A4.5 4.5 0 1 1 6 1.5c1.2 0 2.3.47 3.18 1.32"/>
              <polyline points="9,1 9,3.5 11.5,3.5"/>
            </svg>
          </button>
          <button class="card-action-btn pinned-btn ${sub.pinned ? 'is-pinned' : ''}" title="${sub.pinned ? 'Unpin' : 'Pin'}"
            onclick="event.stopPropagation();Kanban.togglePin('${topicId}', '${sub.id}', ${sub.pinned})">
            ${pinIcon(11)}
          </button>
        </div>
      </div>
      <div class="card-meta-row">
        <div class="source-bubbles">${bubbles || '<span style="font-size:10px;color:var(--ink-muted)">—</span>'}</div>
        <div class="card-right">
          <span class="card-source-count">${totalSources} source${totalSources !== 1 ? 's' : ''}</span>
          <span class="score-badge ${scoreClass}">${sub.score ?? '—'}</span>
        </div>
      </div>

      <!-- Expanded section -->
      <div class="card-expanded" id="expanded-${sub.id}">
        ${buildExpandedContent(sub)}
        <div class="expanded-open-prompt" onclick="Kanban.openFullscreen('${sub.id}', '${topicId}')">
          <svg viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="8,1 12,1 12,5"/><polyline points="5,12 1,12 1,8"/>
            <line x1="12" y1="1" x2="7" y2="6"/><line x1="1" y1="12" x2="6" y2="7"/>
          </svg>
          Open full view
        </div>
        ${sub.broadSources?.length > 0 ? buildBroadPanel(sub) : ''}
      </div>`;

    return card;
  }

  function buildExpandedContent(sub) {
    const groups = [
      { key: 'x',      label: 'X (Twitter)', iconCls: 'x-icon-sm',      icon: xLogoSvg(10) },
      { key: 'reddit', label: 'Reddit',       iconCls: 'reddit-icon-sm', icon: redditLogoSvg(10) },
      { key: 'web',    label: 'Web',          iconCls: 'web-icon-sm',    icon: webSvg(10) },
    ];
    return groups.map(g => {
      const items = sub.sources?.[g.key] || [];
      if (!items.length) return '';
      return `
        <div class="expanded-source-group">
          <div class="expanded-group-label">
            <svg class="${g.iconCls}" viewBox="0 0 12 12">${''}</svg>
            ${g.label}
          </div>
          ${items.map(a => `
            <div class="expanded-article">
              <div class="expanded-article-dot"></div>
              <div>
                <div class="expanded-article-title">${esc(a.title)}</div>
                <div class="expanded-article-source">${esc(a.source)}</div>
              </div>
            </div>`).join('')}
        </div>`;
    }).join('');
  }

  function buildBroadPanel(sub) {
    return `
      <div class="broad-search-panel visible">
        <div class="broad-header" onclick="this.classList.toggle('open');this.nextElementSibling.style.display=this.classList.contains('open')?'block':'none'">
          <span class="broad-label">Broad web search</span>
          <span class="broad-tag">All sources</span>
          <span class="broad-chevron">
            <svg viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="2,4 5.5,7.5 9,4"/>
            </svg>
          </span>
        </div>
        <div class="broad-body">
          ${(sub.broadSources || []).map(a => `
            <div class="broad-article">
              <div class="broad-article-dot"></div>
              <div>
                <div class="broad-article-text">${esc(a.title)}</div>
                <div class="broad-article-source">${esc(a.source)}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  /* ════════════════════════════════
     BUILD TOMBSTONE
  ════════════════════════════════ */
  function buildTombstone(sub, topicId) {
    const t = el('div', 'tombstone');
    t.id = `tomb-${sub.id}`;
    t.innerHTML = `
      <div class="tombstone-text">${esc(sub.name)}</div>
      <span class="tombstone-label">EXPIRED</span>
      <button class="tombstone-dismiss" title="Dismiss" onclick="Kanban.dismissTombstone('${topicId}','${sub.id}')">
        <svg viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <line x1="1" y1="1" x2="10" y2="10"/><line x1="10" y1="1" x2="1" y2="10"/>
        </svg>
      </button>`;
    return t;
  }

  /* ════════════════════════════════
     BUILD SKELETON
  ════════════════════════════════ */
  function buildSkeleton() {
    const s = el('div', 'skeleton-card');
    s.innerHTML = `
      <div class="skel skel-sm skel-w40" style="margin-bottom:8px"></div>
      <div class="skel skel-lg skel-w80" style="margin-bottom:6px"></div>
      <div class="skel skel-md skel-w100" style="margin-bottom:4px"></div>
      <div class="skel skel-sm skel-w60"></div>`;
    return s;
  }

  /* ════════════════════════════════
     BUILD EMPTY STATE
  ════════════════════════════════ */
  function buildEmptyState() {
    const wrap = el('div', 'empty-zone');
    wrap.innerHTML = `
      <div class="empty-icon-wrap">
        <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1" y="4" width="7.5" height="20" rx="2.5"/>
          <rect x="10" y="4" width="7.5" height="20" rx="2.5"/>
          <rect x="19" y="4" width="8" height="20" rx="2.5"/>
        </svg>
      </div>
      <div class="empty-title">No topics yet</div>
      <div class="empty-sub">Add your first topic to start monitoring sources and surfacing intelligence.</div>
      <button class="empty-cta" onclick="Overlay.open()">
        <svg viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="6.5" y1="1" x2="6.5" y2="12"/><line x1="1" y1="6.5" x2="12" y2="6.5"/>
        </svg>
        Add your first topic
      </button>
      <div class="tip-row">
        <span class="tip-pill">Tip</span>
        Exposé reads your sources and surfaces subtopics automatically
      </div>`;
    return wrap;
  }

  /* ════════════════════════════════
     INTERACTIONS
  ════════════════════════════════ */

  async function toggleCard(subtopicId, topicId, event) {
    const card = document.getElementById(`card-${subtopicId}`);
    if (!card) return;
    const isExpanded = card.classList.contains('expanded');

    if (isExpanded) {
      // Title bar click = collapse
      if (event?.target.closest('.card-header')) {
        card.classList.remove('expanded');
      }
    } else {
      // Expand
      card.classList.add('expanded');
      // Mark viewed
      await TopicService.markViewed(topicId, subtopicId);
      card.classList.remove('unviewed');
      // Update unviewed badge on column
      const topic = topics.find(t => t.id === topicId);
      const sub   = topic?.subtopics?.find(s => s.id === subtopicId);
      if (sub) sub.viewed = true;
      updateUnviewedBadge(topicId);
    }
  }

  function updateUnviewedBadge(topicId) {
    const topic  = topics.find(t => t.id === topicId);
    if (!topic) return;
    const count  = TopicService.getUnviewedCount(topic);
    const badge  = document.querySelector(`#col-${topicId} .unviewed-badge`);
    const right  = document.querySelector(`#col-${topicId} .col-header-right`);
    if (count > 0) {
      if (badge) badge.textContent = count;
      else if (right) {
        const b = el('span', 'unviewed-badge');
        b.textContent = count;
        right.prepend(b);
      }
    } else {
      badge?.remove();
    }
  }

  async function togglePin(topicId, subtopicId, currentlyPinned) {
    const newPinned = !currentlyPinned;
    await TopicService.pinSubtopic(topicId, subtopicId, newPinned);
    // Update local state
    const topic = topics.find(t => t.id === topicId);
    const sub   = topic?.subtopics?.find(s => s.id === subtopicId);
    if (sub) sub.pinned = newPinned;
    // Re-render affected column and pinned col
    renderColumn(topicId);
    document.getElementById('pinned-col')?.replaceWith(buildPinnedColumn());
  }

  async function dismissTombstone(topicId, subtopicId) {
    await TopicService.dismissTombstone(topicId, subtopicId);
    const topic = topics.find(t => t.id === topicId);
    if (topic) topic.subtopics = topic.subtopics.filter(s => s.id !== subtopicId);
    document.getElementById(`tomb-${subtopicId}`)?.remove();
  }

  async function refreshCard(topicId) {
    await fetchTopicData(topicId);
  }

  function openColMenu(topicId, event) {
    event.stopPropagation();
    // Simple inline menu (can be upgraded to a proper dropdown later)
    const topic = topics.find(t => t.id === topicId);
    if (!topic) return;
    const action = prompt(`Topic: "${topic.name}"\n\nType an action:\n- rename\n- delete`);
    if (!action) return;
    if (action.trim() === 'rename') {
      const name = prompt('New topic name:', topic.name);
      if (name?.trim()) {
        TopicService.updateTopic(topicId, { name: name.trim() });
        topic.name = name.trim();
        renderBoard();
      }
    } else if (action.trim() === 'delete') {
      if (confirm(`Delete topic "${topic.name}"? This cannot be undone.`)) {
        TopicService.deleteTopic(topicId);
        topics = topics.filter(t => t.id !== topicId);
        renderBoard();
      }
    }
  }

  /* ════════════════════════════════
     FULL-SCREEN OVERLAY
  ════════════════════════════════ */

  function openFullscreen(subtopicId, topicId) {
    const topic = topics.find(t => t.id === topicId);
    const sub   = topic?.subtopics?.find(s => s.id === subtopicId)
               || TopicService.getPinnedSubtopics(topics).find(s => s.id === subtopicId);
    if (!sub) return;

    const overlay = document.getElementById('fullscreen-overlay');
    const body    = document.getElementById('fullscreen-body');
    if (!overlay || !body) return;

    const scoreClass = sub.score >= 70 ? 'score-high' : sub.score >= 40 ? 'score-mid' : 'score-low';
    const totalSrc   = (sub.sources?.x?.length || 0) + (sub.sources?.reddit?.length || 0) + (sub.sources?.web?.length || 0);

    body.innerHTML = `
      <div class="fullscreen-identifier">${esc(topic?.name || 'Topic')}</div>
      <div class="fullscreen-headline">${esc(sub.name)}</div>
      <div class="fullscreen-summary">${esc(sub.summary || 'No summary available.')}</div>
      <div class="fullscreen-scores">
        <div class="fullscreen-score-pill">
          <span class="fullscreen-score-label">Signal</span>
          <span class="fullscreen-score-val ${scoreClass}">${sub.score ?? '—'}</span>
        </div>
        <div class="fullscreen-score-pill">
          <span class="fullscreen-score-label">Sources</span>
          <span class="fullscreen-score-val">${totalSrc}</span>
        </div>
      </div>
      ${buildFullscreenSources(sub)}
      ${sub.broadSources?.length > 0 ? buildFullscreenBroad(sub) : ''}`;

    document.getElementById('fullscreen-title').textContent = sub.name;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeFullscreen() {
    document.getElementById('fullscreen-overlay')?.classList.remove('open');
    document.body.style.overflow = '';
  }

  function buildFullscreenSources(sub) {
    const groups = [
      { key: 'x',      label: 'X / Twitter' },
      { key: 'reddit', label: 'Reddit' },
      { key: 'web',    label: 'Web sources' },
    ];
    return groups.map(g => {
      const items = sub.sources?.[g.key] || [];
      if (!items.length) return '';
      return `
        <div class="fullscreen-section-title">${g.label}</div>
        ${items.map(a => `
          <div class="fullscreen-article">
            <div class="fullscreen-article-dot"></div>
            <div class="fullscreen-article-body">
              <div class="fullscreen-article-source">${esc(a.source)}</div>
              <div class="fullscreen-article-title">
                ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}
              </div>
            </div>
          </div>`).join('')}`;
    }).join('');
  }

  function buildFullscreenBroad(sub) {
    return `
      <div class="fullscreen-section-title" style="margin-top:24px">Broad web search</div>
      ${(sub.broadSources || []).map(a => `
        <div class="fullscreen-article">
          <div class="fullscreen-article-dot" style="opacity:0.5"></div>
          <div class="fullscreen-article-body">
            <div class="fullscreen-article-source">${esc(a.source)}</div>
            <div class="fullscreen-article-title">
              ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}
            </div>
          </div>
        </div>`).join('')}`;
  }

  /* ════════════════════════════════
     SEARCH LOG SIDEBAR
  ════════════════════════════════ */

  async function renderSearchLog() {
    const log  = await TopicService.getSearchLog();
    const list = document.getElementById('log-list');
    if (!list) return;

    if (log.length === 0) {
      list.innerHTML = `
        <div class="log-empty">
          <div class="log-empty-ring">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
              <circle cx="7" cy="7" r="5.5"/>
              <line x1="7" y1="4.5" x2="7" y2="7.5"/>
              <circle cx="7" cy="9.5" r="0.5" fill="currentColor"/>
            </svg>
          </div>
          <div class="log-empty-text">No searches yet.<br/>Add a topic to begin.</div>
        </div>`;
      return;
    }

    list.innerHTML = log.slice(0, 30).map(entry => `
      <div class="log-item" onclick="Kanban.rerunSearch('${entry.id}', '${esc(entry.query)}', '${esc(entry.topicName)}')">
        <div class="log-dot"></div>
        <div class="log-content">
          <div class="log-query">${esc(entry.query)}</div>
          <div class="log-time">${timeAgo(entry.createdAt)}</div>
        </div>
      </div>`).join('');
  }

  async function rerunSearch(logId, query, topicName) {
    const confirmed = confirm(`You're about to re-run the search results of:\n\n"${query}"\n\nProceed?`);
    if (!confirmed) return;
    const topic = topics.find(t => t.name === topicName);
    if (topic) await fetchTopicData(topic.id);
    else alert('Original topic no longer exists. Create a new topic to search again.');
  }

  /* ════════════════════════════════
     DRAG TO REORDER COLUMNS
  ════════════════════════════════ */

  function attachColDrag(handle, col) {
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('.col-menu-btn')) return;
      dragState = { col, startX: e.clientX, startLeft: col.offsetLeft };
      col.style.opacity = '0.7';
      col.style.transform = 'scale(1.01)';
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup',   onDragEnd);
    });
  }

  function onDragMove(e) {
    if (!dragState) return;
    const delta = e.clientX - dragState.startX;
    dragState.col.style.transform = `scale(1.01) translateX(${delta}px)`;
  }

  async function onDragEnd(e) {
    if (!dragState) return;
    const { col } = dragState;
    col.style.opacity  = '';
    col.style.transform = '';
    dragState = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup',   onDragEnd);

    // Get new order of col IDs (excluding pinned-col)
    const area = document.getElementById('kanban-area');
    const ids  = [...area.querySelectorAll('.kanban-col:not(.pinned-col)')]
                   .map(c => c.getAttribute('data-topic-id'))
                   .filter(Boolean);
    await TopicService.reorderTopics(ids);
    topics = await TopicService.getTopics();
  }

  /* ════════════════════════════════
     HELPERS
  ════════════════════════════════ */

  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function timeAgo(iso) {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 60)    return 'just now';
    if (d < 3600)  return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }
  function dragIcon() {
    return `<svg viewBox="0 0 10 10" fill="currentColor"><circle cx="3" cy="2.5" r="1"/><circle cx="7" cy="2.5" r="1"/><circle cx="3" cy="5" r="1"/><circle cx="7" cy="5" r="1"/><circle cx="3" cy="7.5" r="1"/><circle cx="7" cy="7.5" r="1"/></svg>`;
  }
  function pinIcon(size = 12) {
    return `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}"><path d="M9 1L5.5 4.5l-3 .5 4 4 .5-3L10.5 2.5z"/><line x1="1.5" y1="10.5" x2="4.5" y2="7.5"/></svg>`;
  }
  function xLogoSvg(size = 12) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.631 5.905-5.631zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
  }
  function redditLogoSvg(size = 12) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>`;
  }
  function webSvg(size = 12) {
    return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="${size}" height="${size}"><circle cx="10" cy="10" r="8"/><path d="M10 2c-2 2-3 5-3 8s1 6 3 8M10 2c2 2 3 5 3 8s-1 6-3 8"/><line x1="2" y1="10" x2="18" y2="10"/></svg>`;
  }

  /* ── Public API ── */
  return {
    init,
    renderBoard,
    renderColumn,
    toggleCard,
    togglePin,
    dismissTombstone,
    refreshCard,
    openColMenu,
    openFullscreen,
    closeFullscreen,
    rerunSearch,
    renderSearchLog,
    fetchTopicData,
  };
})();

window.Kanban = Kanban;
