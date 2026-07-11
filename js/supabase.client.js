/* ═══════════════════════════════════════════════
   EXPOSÉ — supabase.client.js
   Supabase bootstrap + cloud sync layer.

   Load order (every page that needs cloud data):
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="js/supabase.client.js"></script>
     <script src="js/auth.service.js"></script>
     ...rest of the services...

   Design: the app's page guards (Router.requireAuth) and several call
   sites read auth/settings SYNCHRONOUSLY, and gemini.service.js reads
   settings straight from localStorage. So localStorage stays — but only
   as a per-page cache and session *mirror*. Supabase is the source of
   truth: CloudStore.pull() refreshes the cache once per page load, and
   every local write is pushed back up (debounced write-through).

   Security model: the anon key below is PUBLIC by design — safe to ship
   in client JS. All protection comes from Supabase Auth (bcrypt, JWT,
   refresh tokens) + Row Level Security (supabase/setup.sql), which
   makes every user_data row invisible to everyone but its owner.
   NEVER put the service_role key in this file or anywhere client-side.
   ═══════════════════════════════════════════════ */

(() => {
  /* ────────────────────────────────────────────
     1. PASTE YOUR PROJECT VALUES HERE
        Supabase dash → your project → Settings → API
          Project URL      → SUPABASE_URL
          anon / public    → SUPABASE_ANON_KEY   (NOT service_role!)
     ──────────────────────────────────────────── */
  const SUPABASE_URL      = 'PASTE_YOUR_PROJECT_URL';   // e.g. https://abcdefghij.supabase.co
  const SUPABASE_ANON_KEY = 'PASTE_YOUR_ANON_KEY';

  /* ── Shared localStorage keys (same as the services) ── */
  const SESSION_KEY  = 'expose_session_v1';
  const SETTINGS_KEY = 'expose_settings_v1';
  const TOPICS_KEY   = 'expose_topics_v1';
  const LOG_KEY      = 'expose_search_log_v1';
  const OWNER_KEY    = 'expose_cloud_owner_v1'; // which user id the local cache belongs to

  const configured =
    (/^https:\/\/[^/]+\.supabase\.co$/.test(SUPABASE_URL) ||
     /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(SUPABASE_URL)) && // supabase local dev
    SUPABASE_ANON_KEY.length > 40 && !/^PASTE_/.test(SUPABASE_ANON_KEY);

  if (!configured) {
    console.warn('[Exposé] Supabase is not configured — running in local-only mode. ' +
                 'Paste your project URL + anon key into js/supabase.client.js (see DEPLOYMENT.md).');
  }

  const client = (configured && window.supabase)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession:   true,  // survives reloads; enables "login from anywhere, stay logged in"
          autoRefreshToken: true,
          detectSessionInUrl: true, // ingests the #access_token Google OAuth lands with
        },
      })
    : null;

  /* ── Session mirror ──
     A tiny synchronous snapshot of the signed-in user, kept in the same
     localStorage key the old prototype used, so Router.requireAuth(),
     dashboard's loadUser(), etc. keep working without becoming async. */
  function setMirror(user) {
    if (!user) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: user.id, email: user.email, createdAt: user.created_at,
    }));
  }
  function clearMirror() { localStorage.removeItem(SESSION_KEY); }

  // Kept fresh for the keepalive flush on page close (fetch there can't await getSession()).
  let accessToken = null;
  let cachedUid   = null;

  if (client) {
    client.auth.onAuthStateChange((event, session) => {
      if (session && session.user) {
        setMirror(session.user);
        accessToken = session.access_token;
        cachedUid   = session.user.id;
      } else {
        accessToken = null;
        cachedUid   = null;
        // No cloud session → the mirror is stale; clear it so guards fail closed.
        if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') clearMirror();
      }
    });
  }

  window.SupabaseClient = { client, configured, setMirror, clearMirror };

  /* ════════════════════════════════════════════
     CloudStore — pull/push between the user_data
     row and the localStorage cache.
  ════════════════════════════════════════════ */
  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };

  async function currentUserId() {
    if (!client) return null;
    try {
      const { data } = await client.auth.getSession();
      return data?.session?.user?.id || null;
    } catch { return null; }
  }

  /* ── PULL: cloud row → local cache. Memoized: runs once per page load. ── */
  let pullPromise = null;
  function pull() {
    if (!pullPromise) {
      pullPromise = doPull().catch(err => {
        console.warn('[CloudStore] pull failed:', err?.message || err);
        return { ok: false, reason: 'error' };
      });
    }
    return pullPromise;
  }

  async function doPull() {
    if (!client) return { ok: false, reason: 'unconfigured' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'signed-out' };

    const owner = localStorage.getItem(OWNER_KEY);
    if (owner && owner !== uid) {
      // A different account used this browser — never leak its data across.
      localStorage.removeItem(TOPICS_KEY);
      localStorage.removeItem(LOG_KEY);
    }

    let { data, error } = await client
      .from('user_data')
      .select('topics, settings, search_log')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };

    if (!data) {
      // Row missing (setup.sql trigger not installed, or pre-trigger account) — create it.
      const ins = await client.from('user_data').insert({ user_id: uid });
      if (ins.error && ins.error.code !== '23505') return { ok: false, reason: ins.error.message };
      data = { topics: [], settings: {}, search_log: [] };
    }

    // One-time migration: this browser holds pre-cloud topics and the cloud row
    // is empty → seed the cloud from local instead of wiping the user's data.
    const localTopics = readJson(TOPICS_KEY, []);
    if (!owner && (!data.topics || data.topics.length === 0) && localTopics.length > 0) {
      data.topics     = localTopics;
      data.search_log = readJson(LOG_KEY, []);
      queue({ topics: data.topics, search_log: data.search_log });
    }

    // Cloud settings win; device-local keys (e.g. palette picked while logged
    // out) survive underneath for anything the cloud copy doesn't define yet.
    const settings = { ...readJson(SETTINGS_KEY, {}), ...(data.settings || {}) };

    localStorage.setItem(TOPICS_KEY,   JSON.stringify(data.topics || []));
    localStorage.setItem(LOG_KEY,      JSON.stringify(data.search_log || []));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    localStorage.setItem(OWNER_KEY, uid);
    return { ok: true };
  }

  /* ── PUSH: local mutations → cloud row. Debounced write-through so a burst
     of edits (drag reorder, mark-viewed sweep) becomes one UPDATE. RLS means
     the worst a tampered client can do is edit its own row. ── */
  let pending   = {};
  let pushTimer = null;
  const DEBOUNCE_MS = 800;

  function queue(cols) {
    if (!client) return;
    Object.assign(pending, cols);
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  async function flush() {
    clearTimeout(pushTimer); pushTimer = null;
    if (!client || !Object.keys(pending).length) return;
    const payload = pending; pending = {};
    const uid = await currentUserId();
    if (!uid) return; // logged out mid-flight — drop, nothing to attach it to
    const { error } = await client
      .from('user_data')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('user_id', uid);
    if (error) {
      console.warn('[CloudStore] push failed:', error.message);
      pending = { ...payload, ...pending }; // requeue; newer edits win
      clearTimeout(pushTimer);
      pushTimer = setTimeout(flush, DEBOUNCE_MS * 4);
    }
  }

  // Tab closing/hiding inside the debounce window: best-effort keepalive PATCH
  // straight to PostgREST (the SDK's normal request would be cancelled).
  function flushOnHide() {
    if (!client || !Object.keys(pending).length || !accessToken || !cachedUid) return;
    const payload = pending; pending = {};
    clearTimeout(pushTimer); pushTimer = null;
    try {
      fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${cachedUid}`, {
        method: 'PATCH',
        keepalive: true,
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
      }).catch(() => {});
    } catch { /* keepalive body cap exceeded — the debounced path already covered most writes */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
  });
  window.addEventListener('pagehide', flushOnHide);

  window.CloudStore = {
    pull,
    flush,
    pushTopics:   (topics)   => queue({ topics }),
    pushLog:      (log)      => queue({ search_log: log }),
    pushSettings: (settings) => queue({ settings }),
  };
})();
