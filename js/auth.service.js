/* ═══════════════════════════════════════════════
   EXPOSÉ — auth.service.js
   Authentication and user profile management.

   Migration map:
     signUp(email, pw)      → POST /api/auth/signup
     login(email, pw)       → POST /api/auth/login
     logout()               → POST /api/auth/logout
     getUser()              → GET  /api/auth/me
     updatePassword(pw)     → PATCH /api/auth/password
     updateSettings(data)   → PATCH /api/auth/settings
     deleteAccount()        → DELETE /api/auth/account
     isAuthenticated()      → check session cookie / JWT
   ═══════════════════════════════════════════════ */

const AuthService = (() => {
  const USERS_KEY    = 'expose_users_v1';
  const SESSION_KEY  = 'expose_session_v1';
  const SETTINGS_KEY = 'expose_settings_v1';

  /* ── Internals ── */
  function getUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch { return {}; }
  }
  function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

  function hashPw(pw) {
    // Prototype-only hash — NOT cryptographically secure.
    // Replace with bcrypt/argon2 server-side on migration.
    let h = 0;
    for (let i = 0; i < pw.length; i++) h = (Math.imul(31, h) + pw.charCodeAt(i)) | 0;
    return h.toString(36) + '_' + pw.length;
  }

  function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
  function delay(ms)        { return new Promise(r => setTimeout(r, ms)); }

  function defaultSettings() {
    return {
      geminiApiKey:  '',
      refreshRate:   60,     // minutes
      theme:         'light',
      expandTopics:  true,
      notifications: false,
    };
  }

  /* ── Sign up ── */
  async function signUp(email, password) {
    // → POST /api/auth/signup { email, password }
    await delay(650);
    const key = email.toLowerCase().trim();
    if (!validateEmail(key))  return { success: false, error: 'Please enter a valid email address.' };
    if (!password || password.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
    const users = getUsers();
    if (users[key]) return { success: false, error: 'An account with this email already exists.' };

    const user = {
      id:        'u_' + Date.now(),
      email:     key,
      createdAt: new Date().toISOString(),
      settings:  defaultSettings(),
    };
    users[key] = { ...user, passwordHash: hashPw(password) };
    saveUsers(users);

    // Persist session
    localStorage.setItem(SESSION_KEY,  JSON.stringify(user));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(user.settings));
    return { success: true, user };
  }

  /* ── Login ── */
  async function login(email, password) {
    // → POST /api/auth/login { email, password }
    await delay(650);
    const key = email.toLowerCase().trim();
    if (!key || !password) return { success: false, error: 'Please fill in all fields.' };
    const users  = getUsers();
    const record = users[key];
    if (!record)                          return { success: false, error: 'No account found with this email.' };
    if (record.passwordHash !== hashPw(password)) return { success: false, error: 'Incorrect password. Please try again.' };

    const user = { id: record.id, email: record.email, createdAt: record.createdAt, settings: record.settings };
    localStorage.setItem(SESSION_KEY,  JSON.stringify(user));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(user.settings || defaultSettings()));
    return { success: true, user };
  }

  /* ── Logout ── */
  function logout() {
    // → POST /api/auth/logout
    localStorage.removeItem(SESSION_KEY);
  }

  /* ── Get current user ── */
  function getUser() {
    // → GET /api/auth/me
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  }

  function isAuthenticated() { return !!getUser(); }

  /* ── Update password ── */
  async function updatePassword(currentPw, newPw) {
    // → PATCH /api/auth/password { currentPassword, newPassword }
    await delay(500);
    const user  = getUser();
    if (!user) return { success: false, error: 'Not authenticated.' };
    const users = getUsers();
    const rec   = users[user.email];
    if (!rec)                           return { success: false, error: 'Account not found.' };
    if (rec.passwordHash !== hashPw(currentPw)) return { success: false, error: 'Current password is incorrect.' };
    if (!newPw || newPw.length < 8)    return { success: false, error: 'New password must be at least 8 characters.' };
    rec.passwordHash = hashPw(newPw);
    saveUsers(users);
    return { success: true };
  }

  /* ── Update settings ── */
  async function updateSettings(data) {
    // → PATCH /api/auth/settings { ...settingsFields }
    await delay(300);
    const user  = getUser();
    if (!user) return { success: false };
    const users = getUsers();
    const rec   = users[user.email];
    if (!rec) return { success: false };

    const merged = { ...(rec.settings || defaultSettings()), ...data };
    rec.settings = merged;
    saveUsers(users);

    // Update active session + settings store
    user.settings = merged;
    localStorage.setItem(SESSION_KEY,  JSON.stringify(user));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return { success: true, settings: merged };
  }

  /* ── Get settings ── */
  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || defaultSettings(); } catch { return defaultSettings(); }
  }

  /* ── Delete account ── */
  async function deleteAccount(password) {
    // → DELETE /api/auth/account { password }
    await delay(700);
    const user  = getUser();
    if (!user) return { success: false, error: 'Not authenticated.' };
    const users = getUsers();
    const rec   = users[user.email];
    if (!rec || rec.passwordHash !== hashPw(password)) return { success: false, error: 'Incorrect password.' };

    delete users[user.email];
    saveUsers(users);
    // Clear all user data
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem('expose_topics_v1');
    localStorage.removeItem('expose_search_log_v1');
    return { success: true };
  }

  /* ── Public API ── */
  return {
    signUp,
    login,
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
