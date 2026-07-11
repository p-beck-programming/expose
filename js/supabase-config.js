/* ═══════════════════════════════════════════════
   EXPOSÉ — supabase-config.js
   One place to point the app at YOUR Supabase project.

   Setup (see DEPLOYMENT.md → "Backend: Supabase"):
   1. Create a free project at supabase.com
   2. Project Settings → API → copy the Project URL and the
      anon/public key into the two constants below.

   The anon key is PUBLIC by design — every row is protected by
   Row Level Security (supabase/schema.sql), so the key only lets
   a user touch their own data. Never put the service_role key here.

   Load order on every page:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
     <script src="js/supabase-config.js"></script>
     <script src="js/auth.service.js"></script>
   ═══════════════════════════════════════════════ */

const SUPABASE_URL      = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

(() => {
  if (SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
    console.warn('[Exposé] supabase-config.js is not configured yet — see DEPLOYMENT.md');
  }
  // window.sb is the shared client used by every service file.
  // Defaults: session persisted in localStorage, tokens auto-refresh,
  // OAuth/recovery tokens in the URL are detected and consumed on load.
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
