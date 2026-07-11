---
name: verify
description: How to build, launch, and drive Exposé end-to-end on this machine (no node — headless Edge via CDP + python http.server).
---

# Verifying Exposé on this machine

Static site, no build step. **This machine has no node/npm** — Python 3.10 (`py -3`)
and Edge are the tools that work.

## Launch

```bash
# serve the app (from the repo root)
py -3 -m http.server 3123 --bind 127.0.0.1   # run in background

# headless Edge with CDP (profile dir must be scratch, not default)
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --remote-debugging-port=9333 \
  --user-data-dir="<scratch>\edge-profile" --no-first-run about:blank &
curl -s http://127.0.0.1:9333/json/version   # confirm CDP up
```

## Drive

`py -3 -m pip install --user websocket-client` (once), then talk CDP over the
page target's `webSocketDebuggerUrl` — **pass `suppress_origin=True`** or Edge
rejects the handshake with 403. Useful methods: `Page.navigate`,
`Runtime.evaluate` (`awaitPromise:true` for the async service calls),
`Page.captureScreenshot`. Listen for `Runtime.consoleAPICalled` /
`Runtime.exceptionThrown` to catch page errors.

Flows worth driving: login/signup (fill inputs, call `handleLogin()` /
`handleSignup()`, read `#login-error-msg`), auth guards (navigate to
dashboard.html without a session → must land on login.html),
`TopicService.createTopic` → reload → topic persists, logout → caches wiped.

## Cloud (Supabase) path without a real project

`js/supabase.client.js` accepts `http://127.0.0.1:<port>` URLs (supabase local
dev). Run a mock of the two endpoints the app uses — GoTrue
(`POST /auth/v1/token`, `/signup`, `/logout`, `GET /auth/v1/user`) and PostgREST
(`GET|POST|PATCH /rest/v1/user_data`) — with permissive CORS (allow headers:
`authorization, apikey, content-type, prefer, x-client-info,
x-supabase-api-version, accept-profile, content-profile`). A JWT with base64url
`{sub, email, exp}` payload and a fake signature satisfies supabase-js (it never
verifies client-side). `maybeSingle()` sends `Accept:
application/vnd.pgrst.object+json` → return a bare object, not an array.
Temporarily sed-swap the two constants at the top of `js/supabase.client.js` to
the mock URL/key (key must be >40 chars), **and restore the placeholders after**.
A working mock + driver from 2026-07 lives in git history as scratchpad
`mock_supabase.py` / `drive_cloud.py` (session ad1415fc).

## Gotchas

- Files may be edited by the user mid-session — re-read before Edit.
- The `expose_session_v1` mirror is what the sync guards read; seeding it via
  `localStorage.setItem` is enough to get past `Router.requireAuth()` for
  local-mode tests.
- CloudStore pushes are debounced 800ms — sleep ~2s before asserting the mock
  received a PATCH.
