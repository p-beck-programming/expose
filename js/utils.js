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
  }

  function set(palette) {
    apply(palette);
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      s.palette = palette;
      localStorage.setItem('expose_settings_v1', JSON.stringify(s));
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
