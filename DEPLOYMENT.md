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
│   ├── gemini.service.js   ← Gemini API calls, search grounding
│   ├── kanban.js           ← Kanban render, drag/drop, card logic
│   ├── topic-overlay.js    ← Topic creation overlay
│   ├── dashboard.js        ← Dashboard init, event wiring
│   ├── router.js           ← Client-side routing, auth guards
│   └── theme.js            ← Theme toggle, persisted preference
└── assets/
    └── favicon.svg         ← Brand mark as SVG favicon
```

---

## Current Stage: Static Prototype

All data is stored in **localStorage**. No backend, no build step, no dependencies.
To run: open `dashboard.html` in any modern browser. That's it.

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

## Migration: localStorage → Real Database

Every service file is written as an abstraction layer. Swapping the data layer
requires changes in exactly one place per service — the service file itself.
No component or UI code needs to change.

### auth.service.js
```
Current:  reads/writes localStorage keys 'expose_users_v1', 'expose_session_v1'
Swap to:  fetch('/api/auth/signup', ...)  POST { email, password }
          fetch('/api/auth/login', ...)   POST { email, password }
          fetch('/api/auth/me', ...)      GET  (uses httpOnly cookie session)
          fetch('/api/auth/logout', ...)  POST
```
Recommended backend: **Supabase Auth** (free tier, drop-in) or **Firebase Auth**.
Change: replace the 4 localStorage methods with 4 fetch calls. UI is untouched.

### topic.service.js
```
Current:  reads/writes localStorage key 'expose_topics_v1'
Swap to:  fetch('/api/topics', ...)          GET    → list all topics for user
          fetch('/api/topics', ...)          POST   → create topic
          fetch('/api/topics/:id', ...)      PATCH  → update (rename, pin, etc.)
          fetch('/api/topics/:id', ...)      DELETE → delete topic
```
Recommended backend: **Supabase Postgres** or **PlanetScale MySQL**.
Schema hint:
```sql
CREATE TABLE topics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sources     JSONB NOT NULL DEFAULT '{}',
  all_sources BOOLEAN DEFAULT FALSE,
  pinned      BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE subtopics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id    UUID REFERENCES topics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  summary     TEXT,
  score       INTEGER,
  sources     JSONB,
  viewed      BOOLEAN DEFAULT FALSE,
  expired     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE search_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  query       TEXT NOT NULL,
  topic_id    UUID REFERENCES topics(id),
  results     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

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
- [ ] Move Gemini API key to a server-side proxy
- [ ] Replace localStorage auth with a real auth provider
- [ ] Add HTTPS (required — Gemini API blocks non-HTTPS origins)
- [ ] Set security headers (X-Frame-Options, CSP, HSTS)
- [ ] Remove `overlay-demo.html` from the deployed folder
- [ ] Add a `robots.txt` if the app should not be indexed
- [ ] Set up error monitoring (e.g. Sentry free tier)
- [ ] Test on mobile (dashboard layout needs responsive breakpoints)
