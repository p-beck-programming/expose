/* ═══════════════════════════════════════════════
   EXPOSÉ — theme.js
   Theme persistence and toggle.
   Import on every page.
   ═══════════════════════════════════════════════ */

const Theme = (() => {
  function get() {
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1'));
      return s?.theme || 'light';
    } catch { return 'light'; }
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggle() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    // Persist without clobbering other settings
    try {
      const s = JSON.parse(localStorage.getItem('expose_settings_v1')) || {};
      s.theme = next;
      localStorage.setItem('expose_settings_v1', JSON.stringify(s));
    } catch {}
    return next;
  }

  function init() { apply(get()); }

  return { get, apply, toggle, init };
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
