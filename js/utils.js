/* ═══════════════════════════════════════════════
   EXPOSÉ — theme.js
   Theme persistence and toggle.
   Import on every page.
   ═══════════════════════════════════════════════ */

const Theme = (() => {
  const PALETTES = [
    { id: 'console',    label: 'Console'    },
    { id: 'phosphor',   label: 'Phosphor'   },
    { id: 'coldwave',   label: 'Coldwave'   },
    { id: 'klaxon',     label: 'Klaxon'     },
    { id: 'nightshift', label: 'Nightshift' },
    { id: 'daybreak',   label: 'Daybreak'   },
  ];
  const DEFAULT = 'console';

  function get() {
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      if (s.palette && PALETTES.some(p => p.id === s.palette)) return s.palette;
      if (s.theme === 'light') return 'daybreak'; // legacy migration
      return DEFAULT;
    } catch { return DEFAULT; }
  }

  function apply(palette) {
    const id = PALETTES.some(p => p.id === palette) ? palette : DEFAULT;
    document.documentElement.setAttribute('data-palette', id);
    // Legacy hook: pages not yet migrated still read data-theme
    document.documentElement.setAttribute('data-theme', id === 'daybreak' ? 'light' : 'dark');
    const sel = document.getElementById('palette-select');
    if (sel && sel.value !== id) sel.value = id;
    // Settings page's Appearance select lists the same palette ids — keep in sync
    const pref = document.getElementById('theme-select');
    if (pref && pref.value !== id) pref.value = id;
  }

  function set(palette) {
    apply(palette);
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      s.palette = palette;
      localStorage.setItem('expose_settings_v1', JSON.stringify(s));
      // Also persist into the account record (fire-and-forget) so the palette
      // survives logout/login — the session-store copy alone gets rebuilt then.
      if (window.AuthService?.isAuthenticated?.()) {
        AuthService.updateSettings({ palette }).catch?.(() => {});
      }
    } catch {}
    return palette;
  }

  /* Legacy: old theme button cycled light/dark; now cycles palettes */
  function toggle() {
    const order = PALETTES.map(p => p.id);
    return set(order[(order.indexOf(get()) + 1) % order.length]);
  }

  function list() { return PALETTES.slice(); }
  function init() { apply(get()); }

  return { get, apply, set, toggle, list, init };
})();

window.Theme = Theme;

/* ═══════════════════════════════════════════════
   EXPOSÉ — router.js
   Lightweight page-level router.
   Handles auth guards and redirects between
   the static HTML pages.

   Migration to React Router v6:
     Each navigate() call → useNavigate() hook
     Each guard()  call   → <RequireAuth> wrapper
   ═══════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   EXPOSÉ — sidebar.js (collapse + shared chrome)
   One sidebar behavior for every app page:
   - Sidebar: collapse/expand rail, persisted
   - SidebarLog: query log renderer (reads localStorage
     directly so it works on pages without TopicService)
   - MobileNav: bottom tab bar, shown ≤768px via CSS
   - SidebarUI.init('dashboard'|'library'|'settings')
     wires all of it plus the footer (user + palette)
   ═══════════════════════════════════════════════ */

const Sidebar = (() => {
  const KEY = 'expose_sidebar_collapsed_v1';
  function collapsed() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }
  function apply(c) { document.body.classList.toggle('sidebar-collapsed', c); }
  function toggle() {
    const c = !collapsed();
    try { localStorage.setItem(KEY, c ? '1' : '0'); } catch {}
    apply(c);
  }
  /* Logo click in the rail state reopens; no-op when already expanded */
  function expand() { if (collapsed()) toggle(); }
  function init() { apply(collapsed()); }
  return { init, toggle, expand, collapsed };
})();
window.Sidebar = Sidebar;

const SidebarLog = (() => {
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function timeAgo(iso) {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 60)    return 'just now';
    if (d < 3600)  return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }
  function clockTime(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return '';
    return t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }
  function render() {
    const list = document.getElementById('log-list');
    if (!list) return;
    let log = [];
    try { log = JSON.parse(localStorage.getItem('expose_search_log_v1')) || []; } catch {}

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
          <div class="log-empty-text">No queries yet.<br/>Add a topic to begin.</div>
        </div>`;
      return;
    }

    // Clicking re-runs the search — only on the dashboard, where Kanban exists.
    const interactive = !!window.Kanban;
    list.innerHTML = log.slice(0, 30).map(entry => `
      <div class="log-item${interactive ? '' : ' log-static'}"
        ${interactive ? `onclick="Kanban.rerunSearch('${entry.id}', '${esc(entry.query)}', '${esc(entry.topicName)}')"` : ''}>
        <div class="log-dot"></div>
        <div class="log-content">
          <div class="log-query" title="${esc(entry.query)}">${esc(entry.query)}</div>
          <div class="log-time">${timeAgo(entry.createdAt)} — ${clockTime(entry.createdAt)}</div>
        </div>
      </div>`).join('');
  }
  return { render };
})();
window.SidebarLog = SidebarLog;

const MobileNav = (() => {
  const ITEMS = [
    { id: 'dashboard', label: 'Dashboard', href: 'dashboard.html', icon:
      '<svg viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1" width="5.5" height="5.5" rx="1.2"/><rect x="8.5" y="1" width="5.5" height="5.5" rx="1.2"/><rect x="1" y="8.5" width="5.5" height="5.5" rx="1.2"/><rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.2"/></svg>' },
    { id: 'library', label: 'Library', href: 'library.html', icon:
      '<svg viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h3.5v11H2zM6.5 2H10v11H6.5z"/><path d="M10.6 2.7l3 .8-2.8 10.6-3-.8z"/></svg>' },
    { id: 'settings', label: 'Settings', href: 'settings.html', icon:
      '<svg viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="7.5" r="2"/><path d="M7.5 1.5v1.8M7.5 11.7v1.8M13.5 7.5h-1.8M3.3 7.5H1.5M11.7 3.3l-1.3 1.3M4.6 10.1l-1.3 1.3M11.7 11.7l-1.3-1.3M4.6 4.9L3.3 3.6"/></svg>' },
  ];
  function mount(active) {
    if (document.getElementById('mobile-nav')) return;
    const nav = document.createElement('nav');
    nav.id = 'mobile-nav';
    nav.className = 'mobile-nav';
    nav.innerHTML = ITEMS.map(it => `
      <a class="mobile-nav-item ${it.id === active ? 'active' : ''}" href="${it.href}">
        ${it.icon}<span>${it.label}</span>
      </a>`).join('');
    document.body.appendChild(nav);
  }
  return { mount };
})();
window.MobileNav = MobileNav;

const SidebarUI = (() => {
  function initPalette() {
    const sel = document.getElementById('palette-select');
    if (!sel || typeof Theme === 'undefined') return;
    sel.innerHTML = Theme.list().map(p => `<option value="${p.id}">${p.label}</option>`).join('');
    sel.value = Theme.get();
    sel.onchange = () => Theme.set(sel.value);
  }
  function loadUser() {
    try {
      const session = JSON.parse(localStorage.getItem('expose_session_v1'));
      if (session?.email) {
        const email = document.getElementById('user-email');
        const avatar = document.getElementById('user-avatar');
        if (email)  email.textContent  = session.email;
        if (avatar) avatar.textContent = session.email[0].toUpperCase();
      }
    } catch {}
  }
  function init(activePage) {
    Sidebar.init();
    initPalette();
    loadUser();
    SidebarLog.render();
    MobileNav.mount(activePage);
  }
  return { init };
})();
window.SidebarUI = SidebarUI;

/* Sign out — global because sidebar footers call it via inline onclick */
window.handleLogout = function () {
  AuthService.logout();
  window.location.replace('index.html');
};

const Router = (() => {
  const PAGES = {
    landing:   'index.html',
    login:     'login.html',
    signup:    'signup.html',
    dashboard: 'dashboard.html',
    settings:  'settings.html',
  };

  function navigate(page) {
    const target = PAGES[page];
    if (target) window.location.href = target;
  }

  /* Call on pages that require auth — redirects to login if not authenticated */
  function requireAuth() {
    if (typeof AuthService === 'undefined') return;
    if (!AuthService.isAuthenticated()) {
      window.location.replace('login.html');
    }
  }

  /* Call on auth pages — redirects to dashboard if already logged in */
  function requireGuest() {
    if (typeof AuthService === 'undefined') return;
    if (AuthService.isAuthenticated()) {
      window.location.replace('dashboard.html');
    }
  }

  return { navigate, requireAuth, requireGuest };
})();

window.Router = Router;
