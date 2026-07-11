# Exposé — Deployment Guide

## Architecture (current)

```
┌────────────────────┐        ┌──────────────────────────────┐
│  Static site       │        │  Supabase (free tier)        │
│  (Netlify/Vercel/  │◄──────►│  · Auth: email + Google      │
│   GitHub Pages)    │  RLS   │  · Postgres: topics/articles │
│  HTML + CSS + JS   │        │    /search_log/profiles      │
└─────────┬──────────┘        └──────────────▲───────────────┘
          │ feeds                            │ service-role key
          ▼                                  │ (secret)
┌─────────────────────────────────────────────┐
│  Cloudflare Worker: expose-proxy (v8)       │
│  · CORS proxy: news / rss / youtube / reddit│
│  · Cron Trigger: refreshes due topics on    │
│    the server, even when nobody is online   │
└─────────────────────────────────────────────┘
```

- **Accounts are real**: Supabase Auth (bcrypt server-side), Google sign-in,
  email password reset. Topics, filed articles, settings, and the query log
  follow the user to any device they sign in on.
- **Security model**: the browser talks to Postgres directly using the
  *public* anon key; Row Level Security (`supabase/schema.sql`) restricts
  every row to its owner. The service-role key exists only as a Cloudflare
  Worker secret.
- **Hourly refresh is real**: a Worker Cron Trigger refreshes each topic on
  the schedule its owner picked in Settings → Refresh schedule (default 60
  min), whether or not the app is open. Everything runs on free tiers.

## Project Structure

```
expose/
├── index.html              ← Landing / marketing page
├── login.html              ← Sign in (email + Google, password reset)
├── signup.html             ← Sign up (email + Google)
├── dashboard.html          ← Main app (authenticated)
├── library.html            ← Filed articles (authenticated)
├── settings.html           ← Settings (authenticated)
├── overlay-demo.html       ← Dev-only component demo (exclude from production)
├── css/                    ← theme, base, components, nav, auth, overlay,
│                             kanban, landing (+ variables) stylesheets
├── js/
│   ├── supabase-config.js  ← YOUR project URL + anon key go here
│   ├── auth.service.js     ← Auth (Supabase: signup/login/Google/reset)
│   ├── topic.service.js    ← Topic CRUD (Supabase `topics`, `search_log`)
│   ├── article.service.js  ← Library CRUD (Supabase `articles`)
│   ├── gemini.service.js   ← Gemini fetch→cluster pipeline (client side)
│   ├── kanban.js           ← Kanban render, drag/drop, card logic
│   ├── topic-overlay.js    ← Topic creation overlay
│   ├── dossier.js          ← Dossier column + file-article modal
│   ├── utils.js            ← Theme, Router (async auth guards), sidebar
│   └── worldmap.js         ← Landing/dashboard world map
├── supabase/
│   └── schema.sql          ← Run once in the Supabase SQL editor
└── worker/
    └── expose-proxy.js     ← Cloudflare Worker (proxy + cron refresh)
```

---

## Setup 1 — Supabase (accounts + database)

### 1a. Create the project
1. Go to [supabase.com](https://supabase.com) → sign up (free) → **New project**
2. Pick any name (e.g. `expose`), a strong database password (you won't need
   it day-to-day), and the region closest to you → **Create**

### 1b. Create the tables
1. In the project: **SQL Editor** → **New query**
2. Paste the entire contents of `supabase/schema.sql` → **Run**
3. You should see "Success. No rows returned"

### 1c. Point the app at your project
1. **Project Settings** (gear icon) → **API**
2. Copy **Project URL** and the **anon / public** key into
   [js/supabase-config.js](js/supabase-config.js):
   ```js
   const SUPABASE_URL      = 'https://abcdefgh.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOi…';
   ```
   (The anon key is safe to publish — RLS is what protects data.)

### 1d. Auth URLs
1. **Authentication → URL Configuration**
2. **Site URL**: your deployed site, e.g. `https://your-site.netlify.app`
3. **Redirect URLs** → add both:
   - `https://your-site.netlify.app/**`
   - `http://localhost:3000/**` (for local development)

### 1e. Email confirmation (choose one)
- **Simple (recommended to start)**: **Authentication → Sign In / Up →
  Email** → turn **off** "Confirm email". Signups work instantly.
- **Stricter**: leave it on, but know Supabase's built-in mailer is heavily
  rate-limited (a few emails/hour — fine for personal use). For real volume,
  configure custom SMTP under **Authentication → Emails → SMTP Settings**
  (e.g. Resend free tier). Password-reset emails use the same mailer.

### 1f. Google sign-in
1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (any name)
2. **APIs & Services → OAuth consent screen**: User type **External** →
   fill in app name + your email → save (Publishing status "Testing" works;
   add your Google account under Test users, or click **Publish app**)
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: your site URL (and `http://localhost:3000`)
   - Authorized redirect URIs: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (shown verbatim in the next step's Supabase screen)
4. Copy the **Client ID** and **Client secret**
5. In Supabase: **Authentication → Sign In / Up → Auth Providers → Google** →
   enable, paste Client ID + Secret → **Save**

That's the whole backend. No servers to run.

---

## Setup 2 — Cloudflare Worker (proxy + scheduled refresh)

The Worker does two jobs: the CORS feed proxy the app has always used, and
(new in v8) the **server-side scheduled refresh**.

### 2a. Deploy / update the Worker code
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   your Worker (`expose-proxy`)
2. **Edit code** → paste the contents of `worker/expose-proxy.js` → **Deploy**

### 2b. Add the Supabase secrets
1. Worker → **Settings → Variables and Secrets** → **Add**:
   - `SUPABASE_URL` (type Secret) — e.g. `https://abcdefgh.supabase.co`
   - `SUPABASE_SERVICE_KEY` (type **Secret**) — Supabase → Project Settings →
     API → **service_role** key. ⚠️ This key bypasses RLS. It lives ONLY here.
   - optional: `TOPICS_PER_RUN` (plaintext, default `2`, max `5`) — topics
     refreshed per cron run
2. **Deploy** again if prompted

### 2c. Add the Cron Trigger
1. Worker → **Settings → Trigger Events** (or "Triggers") → **Add** →
   **Cron Trigger**
2. Cron expression: `*/10 * * * *` (every 10 minutes) → **Save**

How it works: every 10 minutes the Worker asks Supabase for topics whose
owner's refresh interval has elapsed (oldest first, `TOPICS_PER_RUN` at a
time), re-fetches their sources through its own feed handlers, clusters with
the owner's Gemini key, and writes the subtopics back. A user on "Every 1
hour" with 4 topics gets each topic refreshed hourly, spread across runs.
Without the secrets configured, the cron is a harmless no-op and the proxy
behaves exactly like v7.

### 2d. Verify
```
# Proxy endpoints (unchanged):
https://expose-proxy.pbeckman731.workers.dev/?type=news&q=nashville&when=3d
https://expose-proxy.pbeckman731.workers.dev/?type=rss&url=https%3A%2F%2Fwww.newschannel5.com%2Ffeed
https://expose-proxy.pbeckman731.workers.dev/?type=youtube&channel=%40NewsChannel5

# Cron: Worker → Observability → Logs → filter "scheduled" (or wait 10 min
# and check a stale topic's board — its updated_at/refreshed_at will move).
```

---

## Setup 3 — Static hosting (unchanged)

Any static host works; the `/expose` folder is the deployable artifact.

### Netlify (recommended — free, zero config)
1. netlify.com → New site from Git (or drag-and-drop the folder)
2. Build command: _(blank)_ · Publish directory: `expose`
3. Deploy — live in ~30 seconds
4. Put the final URL into Supabase **Site URL / Redirect URLs** (step 1d)
   and the Google OAuth **JavaScript origins** (step 1f)

### Vercel
1. `npm i -g vercel`, run `vercel` in the folder (preset: Other, no build)

### GitHub Pages
1. Push to a repo → Settings → Pages → Deploy from branch → `main` / root
2. Note: the site lives under `/expose/` — include that path in the Supabase
   redirect URLs

### Local development
```bash
cd expose && python3 -m http.server 3000     # or: npx serve expose
```
Use `http://localhost:3000` (it's already in your redirect allowlist from
step 1d). Don't open pages via `file://` — Google sign-in can't redirect
back to a file URL.

---

## Data & keys — what lives where

| Data | Where | Protected by |
|------|-------|--------------|
| Passwords | Supabase Auth (bcrypt) | never leaves Supabase |
| Topics / subtopics / articles / query log | Postgres tables | Row Level Security |
| Settings incl. **Gemini API key** | `profiles.settings` JSONB | RLS + (worker: secret service key) |
| Session tokens | Browser localStorage (supabase-js default) | short-lived JWT + rotation |
| Supabase service-role key | Cloudflare Worker secret | never in the repo or browser |

Notes:
- The Gemini API key is stored on the user's profile row so the **scheduled
  refresh can act for the user while they're offline** — that's the entire
  point of the cron. RLS means only that user (and the Worker) can read it.
  Users should use a free-tier Gemini key, which caps blast radius.
- localStorage keys (`expose_settings_v1`, `expose_session_v1`,
  `expose_search_log_v1`) are now **device caches** of cloud state, kept so
  synchronous UI code (theme boot, sidebar) stays instant. Sign-out clears
  the session, API key, and query log from the device but keeps the palette.
- **Existing localStorage data is imported automatically**: the first time a
  user signs in on a device that has pre-cloud topics/articles and their
  account is empty, everything is copied up to Supabase.

## Free-tier limits (why this stack)

| Service | Free tier | Exposé usage |
|---------|-----------|--------------|
| Supabase | 500 MB DB, 50k MAU, Google OAuth included; projects pause after ~7 idle days | Cron traffic every 10 min keeps it active |
| Cloudflare Workers | 100k requests/day, Cron Triggers included | proxy + 144 cron runs/day |
| Gemini (user's own key) | per-model daily quotas | 1 small text call per topic refresh |

Firebase was rejected because scheduled functions require the pay-as-you-go
Blaze plan; an all-Cloudflare stack (D1) was rejected because hand-rolled
password auth is a liability next to a managed auth provider.

---

## Migration: Static HTML → Vite + React (future)

| Current file            | React equivalent                          |
|-------------------------|-------------------------------------------|
| `index.html`            | `src/pages/Landing.jsx`                   |
| `login.html`            | `src/pages/Login.jsx`                     |
| `signup.html`           | `src/pages/Signup.jsx`                    |
| `dashboard.html`        | `src/pages/Dashboard.jsx`                 |
| `js/*.service.js`       | `src/services/` (already Supabase-backed — move as-is, swap the CDN global for `npm i @supabase/supabase-js`) |
| `js/kanban.js`          | `src/components/Kanban/` folder           |
| `js/topic-overlay.js`   | `src/components/TopicOverlay/` folder     |
| `js/utils.js` Router    | React Router v6 routes in `App.jsx`       |

```bash
npm create vite@latest expose-react -- --template react
cd expose-react && npm install react-router-dom @supabase/supabase-js
```

---

## Browser Support

Modern browsers only (no IE): CSS custom properties, ES2020, Fetch,
localStorage, `crypto.randomUUID` (falls back where unavailable),
backdrop-filter (Safari `-webkit-` prefix included).

---

## Production Checklist

- [ ] `supabase/schema.sql` run in the SQL editor
- [ ] `js/supabase-config.js` filled in with Project URL + anon key
- [ ] Supabase Site URL + Redirect URLs match the deployed site
- [ ] Google provider enabled (Cloud Console client ID/secret pasted in)
- [ ] Worker v8 deployed; endpoints return `ok:true`
- [ ] Worker secrets set: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- [ ] Cron Trigger added (`*/10 * * * *`) and visible in Trigger Events
- [ ] Sign up → add topic → sign in from a second browser/device → same board
- [ ] Set refresh to 1 hour, close all tabs, check back later — board updated
- [ ] Remove `overlay-demo.html` from the deployed folder
- [ ] Add `robots.txt` if the app should not be indexed
- [ ] Test on mobile (dashboard layout needs responsive breakpoints)
