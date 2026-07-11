/* ═══════════════════════════════════════════════
   EXPOSÉ — auth.service.js  (v2: Supabase Auth)
   Authentication and user profile management.

   v2: localStorage prototype auth replaced with Supabase —
   real accounts (bcrypt server-side), Google sign-in, password
   reset by email, and settings that follow the user across devices.

   Requires (loaded before this file on every page):
     supabase-js CDN  → window.supabase
     supabase-config  → window.sb (shared client)

   localStorage keys kept as DEVICE CACHES so every synchronous
   call site (Theme, gemini.service, sidebar) still works:
     expose_session_v1  — { id, email, providers }  mirror of the session
     expose_settings_v1 — mirror of profiles.settings (cloud wins on boot)
   ═══════════════════════════════════════════════ */

const AuthService = (() => {
  const SESSION_KEY  = 'expose_session_v1';
  const SETTINGS_KEY = 'expose_settings_v1';
  const MIGRATED_KEY = 'expose_cloud_migrated_v1';

  function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  function defaultSettings() {
    return {
      geminiApiKey:  '',
      refreshRate:   60,     // minutes — also drives the server-side cron refresh
      theme:         'light',
      expandTopics:  true,
      notifications: false,
    };
  }

  /* ── Device caches ── */
  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || defaultSettings(); } catch { return defaultSettings(); }
  }
  function cacheSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  function cacheSession(user) {
    if (!user) { localStorage.removeItem(SESSION_KEY); return; }
    const providers = user.app_metadata?.providers
      || (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: user.id, email: user.email, providers,
      createdAt: user.created_at,
    }));
  }

  /* ── Session helpers ── */
  async function session() {
    try { const { data } = await sb.auth.getSession(); return data.session || null; }
    catch { return null; }
  }
  async function sessionExists() { return !!(await session()); }

  // Synchronous — reads the cached mirror. Fine for UI (avatar, guards on
  // the landing page); real route guards go through requireAuth/requireGuest.
  function getUser() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  }
  function isAuthenticated() { return !!getUser(); }

  /* Providers of the signed-in user: ['email'], ['google'], or both. */
  function providers() { return getUser()?.providers || []; }
  function hasPasswordLogin() { return providers().includes('email'); }

  /* ── Page guards (async — pages await these in their boot IIFE) ── */
  async function requireAuth() {
    const s = await session();
    if (!s) { window.location.replace('login.html'); return false; }
    cacheSession(s.user);
    await syncFromCloud(s.user);
    await migrateLocalData(s.user);
    return true;
  }

  async function requireGuest() {
    const s = await session();
    if (s) { window.location.replace('dashboard.html'); return false; }
    return true;
  }

  /* ── Settings sync: cloud is the source of truth, device is the cache ── */
  async function syncFromCloud(user) {
    try {
      const { data, error } = await sb.from('profiles').select('settings').eq('id', user.id).maybeSingle();
      if (error) throw error;
      const cloud  = data?.settings || {};
      const merged = { ...defaultSettings(), ...getSettings(), ...cloud };
      cacheSettings(merged);
      // First cloud login: push device-only keys (palette, API key) up once.
      // Upsert also self-heals a missing profile row.
      if (!data || JSON.stringify(cloud) !== JSON.stringify(merged)) {
        await sb.from('profiles')
          .upsert({ id: user.id, email: user.email, settings: merged, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('[Exposé] settings sync failed:', e?.message || e); }
  }

  /* ── One-time import of pre-cloud localStorage data ── */
  async function migrateLocalData(user) {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;

      let localTopics = [], localArticles = [];
      try { localTopics   = JSON.parse(localStorage.getItem('expose_topics_v1'))   || []; } catch {}
      try { localArticles = JSON.parse(localStorage.getItem('expose_articles_v1')) || []; } catch {}

      if (localTopics.length) {
        const { count } = await sb.from('topics').select('id', { count: 'exact', head: true });
        if ((count || 0) === 0) {
          const rows = localTopics.map((t, i) => ({
            user_id:                user.id,
            name:                   String(t.name || 'Untitled topic'),
            sources:                t.sources || { web: [], rss: [], youtube: [], reddit: [] },
            strict_mode:            !!t.strictMode,
            max_subtopics:          Number.isFinite(+t.maxSubtopics) ? +t.maxSubtopics : 3,
            all_sources_enabled:    !!t.allSourcesEnabled,
            dismissed_subtopics:    t.dismissedSubtopics || [],
            pinned:                 !!t.pinned,
            paused:                 !!t.paused,
            position:               i,
            source_rotation_offset: t.sourceRotationOffset || 0,
            heat_score:             t.heatScore || 0,
            subtopics:              t.subtopics || [],
          }));
          const { error } = await sb.from('topics').insert(rows);
          if (error) throw error;
        }
      }

      if (localArticles.length) {
        const { count } = await sb.from('articles').select('id', { count: 'exact', head: true });
        if ((count || 0) === 0) {
          const rows = localArticles.map(a => ({
            user_id:    user.id,
            topic_id:   a.topicId || '',
            topic_name: a.topicName || '',
            title:      String(a.title || a.url || 'Untitled'),
            url:        String(a.url || ''),
            source:     a.source || '',
            note:       a.note || '',
            filed_at:   a.filedAt || new Date().toISOString(),
          })).filter(r => r.url);
          if (rows.length) {
            const { error } = await sb.from('articles').insert(rows);
            if (error) throw error;
          }
        }
      }

      localStorage.setItem(MIGRATED_KEY, '1');
      if (localTopics.length || localArticles.length) {
        console.info('[Exposé] imported local topics/articles into your account.');
      }
    } catch (e) {
      // Leave the flag unset so the import retries next visit.
      console.warn('[Exposé] local data import failed (will retry):', e?.message || e);
    }
  }

  /* ── Error prettifier ── */
  function friendlyAuthError(error) {
    const msg = error?.message || String(error);
    if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    if (/email not confirmed/i.test(msg))       return 'Please confirm your email first — check your inbox for the confirmation link.';
    if (/already registered/i.test(msg))        return 'An account with this email already exists.';
    if (/rate limit/i.test(msg))                return 'Too many attempts — please wait a minute and try again.';
    if (/password should be/i.test(msg))        return 'Password must be at least 8 characters.';
    if (/failed to fetch/i.test(msg))           return 'Could not reach the server. Check your connection (and that supabase-config.js is set up).';
    return msg;
  }

  /* ── Sign up ── */
  async function signUp(email, password) {
    const key = String(email || '').toLowerCase().trim();
    if (!validateEmail(key))              return { success: false, error: 'Please enter a valid email address.' };
    if (!password || password.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };

    const { data, error } = await sb.auth.signUp({ email: key, password });
    if (error) return { success: false, error: friendlyAuthError(error) };

    // With email confirmation ON, Supabase returns a ghost user (no identities)
    // for an address that already has an account — surface that honestly.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return { success: false, error: 'An account with this email already exists.' };
    }

    if (!data.session) {
      // Email confirmation is enabled on the project — no session until confirmed.
      return { success: true, needsConfirmation: true };
    }

    cacheSession(data.user);
    await syncFromCloud(data.user);
    return { success: true, user: { id: data.user.id, email: data.user.email } };
  }

  /* ── Login ── */
  async function login(email, password) {
    const key = String(email || '').toLowerCase().trim();
    if (!key || !password) return { success: false, error: 'Please fill in all fields.' };

    const { data, error } = await sb.auth.signInWithPassword({ email: key, password });
    if (error) return { success: false, error: friendlyAuthError(error) };

    cacheSession(data.user);
    await syncFromCloud(data.user);
    return { success: true, user: { id: data.user.id, email: data.user.email } };
  }

  /* ── Google sign-in (also signs up first-time users) ── */
  async function loginWithGoogle() {
    const redirectTo = new URL('dashboard.html', window.location.href).href;
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options:  { redirectTo },
    });
    if (error) return { success: false, error: friendlyAuthError(error) };
    return { success: true, redirecting: true }; // browser is navigating to Google
  }

  /* ── Password reset (email link → login.html#…type=recovery) ── */
  async function resetPassword(email) {
    const key = String(email || '').toLowerCase().trim();
    if (!validateEmail(key)) return { success: false, error: 'Enter your email address first.' };
    const redirectTo = new URL('login.html', window.location.href).href;
    await sb.auth.resetPasswordForEmail(key, { redirectTo });
    // Always report success — never reveal whether an email is registered.
    return { success: true };
  }

  /* Called on login.html after the user follows the recovery link. */
  async function completePasswordReset(newPassword) {
    if (!newPassword || newPassword.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
    const { data, error } = await sb.auth.updateUser({ password: newPassword });
    if (error) return { success: false, error: friendlyAuthError(error) };
    cacheSession(data.user);
    return { success: true };
  }

  /* ── Logout ── */
  async function logout() {
    try { await sb.auth.signOut(); } catch {}
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('expose_search_log_v1');
    // Keep the palette so the device keeps its look; drop account settings
    // (including the Gemini API key — this may be a shared machine).
    const palette = getSettings().palette;
    cacheSettings(palette ? { ...defaultSettings(), palette } : defaultSettings());
  }

  /* ── Update password (Settings page) ── */
  async function updatePassword(currentPw, newPw) {
    const user = getUser();
    if (!user) return { success: false, error: 'Not authenticated.' };
    if (!hasPasswordLogin()) {
      return { success: false, error: 'This account signs in with Google — manage your password in your Google account.' };
    }
    if (!newPw || newPw.length < 8) return { success: false, error: 'New password must be at least 8 characters.' };

    // Re-authenticate so a walk-up attacker can't change the password.
    const { error: reauthError } = await sb.auth.signInWithPassword({ email: user.email, password: currentPw });
    if (reauthError) return { success: false, error: 'Current password is incorrect.' };

    const { error } = await sb.auth.updateUser({ password: newPw });
    if (error) return { success: false, error: friendlyAuthError(error) };
    return { success: true };
  }

  /* ── Update settings (device cache + cloud profile) ── */
  async function updateSettings(data) {
    const merged = { ...defaultSettings(), ...getSettings(), ...data };
    cacheSettings(merged); // apply locally even if the network write fails
    const user = getUser();
    if (user) {
      const { error } = await sb.from('profiles')
        .upsert({ id: user.id, email: user.email, settings: merged, updated_at: new Date().toISOString() });
      if (error) {
        console.warn('[Exposé] settings save failed:', error.message);
        return { success: false, error: 'Saved on this device, but cloud sync failed. It will retry on next change.', settings: merged };
      }
    }
    return { success: true, settings: merged };
  }

  /* ── Delete account ── */
  async function deleteAccount(password) {
    const user = getUser();
    if (!user) return { success: false, error: 'Not authenticated.' };

    if (hasPasswordLogin()) {
      if (!password) return { success: false, error: 'Enter your password to confirm.' };
      const { error: reauthError } = await sb.auth.signInWithPassword({ email: user.email, password });
      if (reauthError) return { success: false, error: 'Incorrect password.' };
    }

    const { error } = await sb.rpc('delete_account');
    if (error) return { success: false, error: 'Could not delete account: ' + error.message };

    try { await sb.auth.signOut(); } catch {}
    [SESSION_KEY, SETTINGS_KEY, MIGRATED_KEY,
     'expose_topics_v1', 'expose_search_log_v1', 'expose_articles_v1',
    ].forEach(k => localStorage.removeItem(k));
    return { success: true };
  }

  /* ── Public API ── */
  return {
    signUp,
    login,
    loginWithGoogle,
    resetPassword,
    completePasswordReset,
    logout,
    getUser,
    isAuthenticated,
    sessionExists,
    requireAuth,
    requireGuest,
    hasPasswordLogin,
    updatePassword,
    updateSettings,
    getSettings,
    deleteAccount,
    defaultSettings,
  };
})();

window.AuthService = AuthService;
