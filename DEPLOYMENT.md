# Exposé — Deployment Guide

## Project Structure

```
expose/
├── index.html              ← Landing / marketing page
├── login.html              ← Login screen
├── signup.html             ← Signup screen
├── dashboard.html          ← Main app (authenticated)
├── overlay-demo.html       ← Dev-only component demo (exclude from production)
├── css/
│   ├── variables.css       ← Design tokens, CSS custom properties, fonts
│   ├── base.css            ← Reset, body, typography defaults
│   ├── components.css      ← Buttons, inputs, pills, badges (shared)
│   ├── nav.css             ← Topnav, sidebar
│   ├── landing.css         ← Landing page specific styles
│   ├── auth.css            ← Login / signup styles
│   ├── overlay.css         ← Topic creation overlay
│   ├── kanban.css          ← Kanban columns, subtopic cards
│   └── dashboard.css       ← Dashboard shell layout
├── js/
│   ├── auth.service.js     ← Auth logic (localStorage → swap for API)
│   ├── topic.service.js    ← Topic CRUD (localStorage → swap for API)
│   ├── gemini.service.js   ← Gemini API calls, source pipeline
│   ├── kanban.js           ← Kanban render, drag/drop, card logic
│   ├── topic-overlay.js    ← Topic creation overlay
│   ├── dashboard.js        ← Dashboard init, event wiring
│   ├── router.js           ← Client-side routing, auth guards
│   └── theme.js            ← Theme toggle, persisted preference
├── worker/
│   └── expose-proxy.js     ← Cloudflare Worker (deploy separately — see below)
└── assets/
    └── favicon.svg         ← Brand mark as SVG favicon
```

---

## Current Stage: Static Site + Supabase Backend

Accounts and topics live in **Supabase** (Postgres + Auth): users sign in with
email/password or Google and see their topics from any device. localStorage is
only a per-page cache — never the source of truth. Until you paste your Supabase
keys into `js/supabase.client.js` (see the Supabase section below) the app runs
in **local-only mode**: browsing works, but login/signup shows a clear
"Cloud sync is not configured" error.

There is still no build step and no server of your own to run.

For local development with proper routing (so relative paths resolve correctly):
```bash
# Option A — Python (built into macOS/Linux)
cd expose && python3 -m http.server 3000

# Option B — Node.js
npx serve expose

# Option C — VS Code
Install "Live Server" extension → right-click index.html → Open with Live Server
```

---

## Cloudflare Worker: expose-proxy

The app depends on a Cloudflare Worker that acts as a CORS proxy and fetch gateway.
It lives at `worker/expose-proxy.js` and must be deployed separately from the static site.

### What it does

| `?type=` | What it fetches | Auth needed |
|----------|----------------|-------------|
| `news`   | Google News RSS → GDELT DOC 2.0 fallback | None |
| `rss`    | Any RSS or Atom feed URL (`&url=…`) | None |
| `youtube`| Per-channel YouTube Atom feed (`&channel=…`) | None |

### Deploy / update the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → your Worker (`expose-proxy`)
2. Click **Edit code** → paste the contents of `worker/expose-proxy.js` → **Deploy**
3. No secrets or environment variables are required — all sources are keyless.

### Verify after deploy

```
# News (Google News RSS → GDELT fallback)
https://expose-proxy.pbeckman731.workers.dev/?type=news&q=nashville&when=3d

# RSS feed
https://expose-proxy.pbeckman731.workers.dev/?type=rss&url=https%3A%2F%2Fwww.newschannel5.com%2Ffeed

# YouTube channel
https://expose-proxy.pbeckman731.workers.dev/?type=youtube&channel=%40NewsChannel5
```

Each should return `{"ok":true,"items":[...]}`.

---

## Deployment: Static Hosting (Current Build)

Since there is no backend, any static host works. The entire `/expose` folder
is the deployable artifact.

### Netlify (recommended — free, zero config)
1. Go to netlify.com → New site from Git (or drag-and-drop the folder)
2. Build command: _(leave blank — no build step)_
3. Publish directory: `expose`
4. Click Deploy
5. Done — live in ~30 seconds at a `*.netlify.app` URL
6. Custom domain: Site settings → Domain management → Add custom domain

### Vercel
1. `npm i -g vercel` then run `vercel` inside the `expose/` folder
2. Framework preset: Other
3. No build command, output directory: `.` (current folder)
4. Or use the Vercel dashboard and drag the folder

### GitHub Pages
1. Push the `expose/` folder contents to a GitHub repo's `main` branch
2. Repo Settings → Pages → Source: Deploy from branch → `main` → `/root`
3. Live at `https://yourusername.github.io/expose`

### Nginx (self-hosted VPS)
```nginx
server {
    listen 80;
    server_name expose.yourdomain.com;
    root /var/www/expose;
    index dashboard.html;

    # Serve each HTML page directly
    location / {
        try_files $uri $uri.html $uri/ =404;
    }

    # Cache static assets aggressively
    location ~* \.(css|js|svg|png|jpg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";
}
```
With HTTPS (required for Gemini API calls from the browser):
```bash
sudo certbot --nginx -d expose.yourdomain.com
```

### Apache (.htaccess)
```apache
Options -Indexes
DirectoryIndex dashboard.html

<FilesMatch "\.(css|js|svg)$">
    Header set Cache-Control "max-age=31536000, public, immutable"
</FilesMatch>
```

---

## Environment: API Key Handling

Currently the Gemini API key is entered by the user in Settings and stored in
localStorage under the key `expose_settings_v1`. It is never sent to a server.

**This is acceptable for a personal/single-user prototype.**

For a multi-user production deployment:
- Move the API key server-side
- Create a thin proxy endpoint: `POST /api/search { topic, sources }`
- The proxy calls Gemini and returns results — the client never sees the key
- See the "Migration to Real Backend" section below

---

## Supabase: Accounts + Cross-Device Topics (one-time setup)

The auth/data backend is **Supabase** (free tier: 500 MB Postgres, 50k monthly
active users). Security comes from **Supabase Auth** (bcrypt password hashing,
JWT sessions, email verification, Google OAuth) plus **Row Level Security** —
the browser talks to the database directly with the *public* anon key, and RLS
policies make each user's row invisible to everyone else. There is no secret
to hide in the client, and no server of your own to run.

### 1. Create the project
1. [supabase.com](https://supabase.com) → New project (free plan)
2. Pick any name/region; set a strong database password (you won't need it in the app)

### 2. Create the table, policies, and functions
1. Dashboard → **SQL Editor** → New query
2. Paste the entire contents of `supabase/setup.sql` → **Run**
   (creates the `user_data` table, RLS policies, the signup trigger, and the
   `delete_user()` self-deletion function)

### 3. Wire the app to your project
1. Dashboard → **Settings → API**: copy the **Project URL** and the
   **anon / public** key (never the `service_role` key)
2. Paste both into the two constants at the top of `js/supabase.client.js`

### 4. Auth providers
- **Email/password** works out of the box. "Confirm email" is ON by default —
  keep it on (recommended; the signup page handles the "check your inbox" flow)
  or turn it off under **Authentication → Providers → Email**.
- **Google**: Authentication → Providers → Google → enable, then follow the
  linked guide to create an OAuth client in Google Cloud Console and paste the
  Client ID/Secret. Under **Authentication → URL Configuration** add your site's
  `login.html` URLs (production *and* local dev, e.g.
  `http://localhost:3000/login.html`) to **Redirect URLs** — OAuth intentionally
  lands back on `login.html`, which forwards to the dashboard once the session
  is ingested.

### 5. Free-tier caveat
Free projects **pause after ~1 week without traffic** (data is kept; unpause
from the dashboard). Any login or topic refresh counts as traffic. For a
low-traffic deployment, add a weekly ping (e.g. a Cloudflare Worker cron that
does `GET <PROJECT_URL>/rest/v1/` with the anon key) or just use the app.

### How the sync works (for future maintenance)
- `js/supabase.client.js` — creates the client, mirrors the session into
  `expose_session_v1` (so the synchronous page guards still work), and exposes
  `CloudStore`: `pull()` (cloud row → localStorage cache, once per page load)
  and debounced `pushTopics/pushLog/pushSettings` (write-through on every edit).
- `js/auth.service.js` — same public API as before, Supabase Auth internals.
- `js/topic.service.js` — unchanged logic; reads go through the cache after a
  `pull()`, writes push back up. One `user_data` row per user, JSONB columns
  (`topics`, `settings`, `search_log`) matching the old localStorage shapes.
- First login on a browser that has pre-cloud local topics migrates them up
  automatically (only into an empty cloud row, and never across accounts).

### gemini.service.js
```
Current:  calls Gemini API directly from browser with user-provided key
Swap to:  calls your own proxy endpoint POST /api/search
          proxy calls Gemini server-side with server-stored key
          proxy returns structured subtopic data
```

---

## Migration: Static HTML → Vite + React

File mapping when you're ready to upgrade:

| Current file            | React equivalent                          |
|-------------------------|-------------------------------------------|
| `index.html`            | `src/pages/Landing.jsx`                   |
| `login.html`            | `src/pages/Login.jsx`                     |
| `signup.html`           | `src/pages/Signup.jsx`                    |
| `dashboard.html`        | `src/pages/Dashboard.jsx`                 |
| `css/variables.css`     | `src/styles/variables.css` (unchanged)    |
| `css/kanban.css`        | `src/styles/kanban.css` (unchanged)       |
| `js/auth.service.js`    | `src/services/auth.service.js`            |
| `js/topic.service.js`   | `src/services/topic.service.js`           |
| `js/gemini.service.js`  | `src/services/gemini.service.js`          |
| `js/kanban.js`          | `src/components/Kanban/` folder           |
| `js/topic-overlay.js`   | `src/components/TopicOverlay/` folder     |
| `js/router.js`          | React Router v6 routes in `App.jsx`       |

Vite scaffold command when ready:
```bash
npm create vite@latest expose-react -- --template react
cd expose-react
npm install react-router-dom
npm run dev
```

---

## Browser Support

Targets modern browsers only (no IE). Requirements:
- CSS custom properties ✓
- ES Modules (import/export) ✓
- Fetch API ✓
- LocalStorage ✓
- CSS backdrop-filter (blur) — Safari requires `-webkit-` prefix (already included)

---

## Production Checklist

Before going live with real users:
- [ ] Deploy `worker/expose-proxy.js` to Cloudflare Workers (paste + Deploy in dashboard)
- [ ] Verify Worker endpoints return `ok:true` for news, rss, and youtube types
- [ ] Move Gemini API key to a server-side proxy
- [x] Replace localStorage auth with a real auth provider (Supabase Auth + RLS — see the Supabase section)
- [ ] Run `supabase/setup.sql` and paste the project URL + anon key into `js/supabase.client.js`
- [ ] Enable the Google provider + add your `login.html` redirect URLs in Supabase
- [ ] Add HTTPS (required — Gemini API blocks non-HTTPS origins)
- [ ] Set security headers (X-Frame-Options, CSP, HSTS)
- [ ] Remove `overlay-demo.html` from the deployed folder
- [ ] Add a `robots.txt` if the app should not be indexed
- [ ] Set up error monitoring (e.g. Sentry free tier)
- [ ] Test on mobile (dashboard layout needs responsive breakpoints)
