/* ═══════════════════════════════════════════════
   EXPOSÉ — auth.service.js
   Authentication and user profile management,
   backed by Supabase Auth (email/password + Google).

   Requires (on pages that sign in / mutate the account):
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="js/supabase.client.js"></script>
   Pages that only *read* auth state (index.html) can skip
   those — getUser()/isAuthenticated() read the localStorage
   session mirror synchronously.

   Cloud model:
     Supabase Auth   → identity, bcrypt hashing, JWT sessions,
                       email verification, OAuth (Google)
     user_data row   → per-user settings (RLS: owner-only)
     localStorage    → synchronous mirror/cache ONLY — holds no
                       passwords and is never the source of truth
   ═══════════════════════════════════════════════ */

const AuthService = (() => {
  const SESSION_KEY  = 'expose_session_v1';
  const SETTINGS_KEY = 'expose_settings_v1';
  const TOPICS_KEY   = 'expose_topics_v1';
  const LOG_KEY      = 'expose_search_log_v1';
  const OWNER_KEY    = 'expose_cloud_owner_v1';

  // Lazy accessor — auth.service.js also loads on pages without the SDK.
  const sb = () => window.SupabaseClient?.client || null;

  const NOT_CONFIGURED =
    'Cloud sync is not configured. Paste your Supabase URL and anon key into js/supabase.client.js (see DEPLOYMENT.md).';

  function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  function defaultSettings() {
    return {
      geminiApiKey:  '',
      refreshRate:   60,     // minutes
      theme:         'light',
      expandTopics:  true,
      notifications: false,
    };
  }

  // Map Supabase's raw messages onto the copy the UI already styles around.
  function friendly(error) {
    const msg = error?.message || 'Something went wrong. Please try again.';
    if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    if (/email not confirmed/i.test(msg))       return 'Please confirm your email first — check your inbox for the verification link.';
    if (/already registered/i.test(msg))        return 'An account with this email already exists.';
    if (/rate limit|too many/i.test(msg))       return 'Too many attempts — please wait a minute and try again.';
    if (/failed to fetch|network/i.test(msg))   return 'Could not reach the server. Check your connection and try again.';
    return msg;
  }

  function setMirror(user) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: user.id, email: user.email, createdAt: user.created_at,
    }));
  }

  /* ── Sign up ── */
  async function signUp(email, password) {
    const c = sb();
    if (!c) return { success: false, error: NOT_CONFIGURED };
    const key = email.toLowerCase().trim();
    if (!validateEmail(key))              return { success: false, error: 'Please enter a valid email address.' };
    if (!password || password.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };

    const { data, error } = await c.auth.signUp({ email: key, password });
    if (error) return { success: false, error: friendly(error) };

    // With "Confirm email" enabled in Supabase there is no session until the
    // link in the inbox is clicked — tell the UI so it doesn't redirect.
    if (!data.session) return { success: true, needsConfirmation: true, user: { email: key } };

    setMirror(data.session.user); // sync, before the page redirects
    return { success: true, user: getUser() };
  }

  /* ── Login ── */
  async function login(email, password) {
    const c = sb();
    if (!c) return { success: false, error: NOT_CONFIGURED };
    const key = email.toLowerCase().trim();
    if (!key || !password) return { success: false, error: 'Please fill in all fields.' };

    const { data, error } = await c.auth.signInWithPassword({ email: key, password });
    if (error) return { success: false, error: friendly(error) };

    setMirror(data.user); // sync, before the page redirects
    return { success: true, user: getUser() };
  }

  /* ── Login with Google (OAuth) ── */
  async function loginWithGoogle() {
    const c = sb();
    if (!c) return { success: false, error: NOT_CONFIGURED };
    // Land back on login.html: it's a guest page so the synchronous auth guard
    // won't bounce the token out of the URL; its auth listener then forwards
    // to the dashboard once the SDK has ingested the session.
    const redirectTo = new URL('login.html', window.location.href).href;
    const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) return { success: false, error: friendly(error) };
    return { success: true, redirecting: true }; // browser is navigating to Google now
  }

  /* ── Logout ── */
  async function logout() {
    // Clear the mirror first so guards fail closed even if signOut is cut short.
    localStorage.removeItem(SESSION_KEY);
    clearLocalCache();
    // scope:'local' = sign out THIS device only (default 'global' would kill
    // the user's sessions on every other device too).
    try { await sb()?.auth.signOut({ scope: 'local' }); } catch { /* token already dropped locally */ }
  }

  // Wipe cached personal data (topics, log, Gemini key) on logout/delete —
  // this may be a shared computer. The palette stays: it's a device preference.
  function clearLocalCache() {
    localStorage.removeItem(TOPICS_KEY);
    localStorage.removeItem(LOG_KEY);
    localStorage.removeItem(OWNER_KEY);
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ palette: s.palette, theme: s.theme }));
    } catch { localStorage.removeItem(SETTINGS_KEY); }
  }

  /* ── Get current user (sync — reads the session mirror) ── */
  function getUser() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  }

  function isAuthenticated() { return !!getUser(); }

  /* ── Update password ── */
  async function updatePassword(currentPw, newPw) {
    const c = sb();
    if (!c) return { success: false, error: NOT_CONFIGURED };
    const user = getUser();
    if (!user)                      return { success: false, error: 'Not authenticated.' };
    if (!newPw || newPw.length < 8) return { success: false, error: 'New password must be at least 8 characters.' };

    // Re-authenticate to prove the current password before changing it.
    const check = await c.auth.signInWithPassword({ email: user.email, password: currentPw });
    if (check.error) return { success: false, error: 'Current password is incorrect.' };

    const { error } = await c.auth.updateUser({ password: newPw });
    if (error) return { success: false, error: friendly(error) };
    return { success: true };
  }

  /* ── Update settings ── */
  async function updateSettings(data) {
    const merged = { ...defaultSettings(), ...getSettings(), ...data };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    // Write-through to the user's RLS-protected row (debounced in CloudStore).
    if (isAuthenticated() && window.CloudStore) CloudStore.pushSettings(merged);
    return { success: true, settings: merged };
  }

  /* ── Get settings (sync — reads the cache; CloudStore.pull refreshes it) ── */
  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || defaultSettings(); } catch { return defaultSettings(); }
  }

  /* ── Delete account ── */
  async function deleteAccount(password) {
    const c = sb();
    if (!c) return { success: false, error: NOT_CONFIGURED };
    const user = getUser();
    if (!user) return { success: false, error: 'Not authenticated.' };

    // Verify the password for email/password accounts. Google-only accounts
    // have no password — the confirmation modal is the gate for them.
    const { data: fresh } = await c.auth.getUser();
    const hasPassword = (fresh?.user?.identities || []).some(i => i.provider === 'email');
    if (hasPassword) {
      const check = await c.auth.signInWithPassword({ email: user.email, password });
      if (check.error) return { success: false, error: 'Incorrect password.' };
    }

    // security-definer RPC (supabase/setup.sql) — deletes the calling user
    // from auth.users; the user_data row cascades away with it.
    const { error } = await c.rpc('delete_user');
    if (error) return { success: false, error: friendly(error) };

    await logout(); // drop the (now-dead) token + wipe the local cache
    return { success: true };
  }

  /* ── Public API ── */
  return {
    signUp,
    login,
    loginWithGoogle,
    logout,
    getUser,
    isAuthenticated,
    updatePassword,
    updateSettings,
    getSettings,
    deleteAccount,
    defaultSettings,
  };
})();

window.AuthService = AuthService;
