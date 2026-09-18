# AGENTS.md — mermaid-server

Local-first mermaid diagram editor: React SPA + small local Node HTTP server.
UI modeled on mermaid.live, but file-backed, tabbed, and driven by plain HTTP
endpoints. **Hard requirement: 100% offline** — every dependency comes from npm
and is bundled; the page must never fetch anything from the internet (no CDN
scripts, no webfonts, no runtime `script src="https://…"`).

## Status

- ✅ Implemented and tested: server (all endpoints), client (tabs, editor,
  diagram pane, open dialog), build (`tsc -b && vite build`), lint, curl-based
  endpoint tests, dev flow (vite proxy + server).
- ✅ `svg-pan-zoom` typing: local declaration in `src/lib/svg-pan-zoom.d.ts`
  (there is no usable `@types` package for it — do not add one).
- ✅ Diagram pan/zoom persists per tab in localStorage (`mermaid-server:panzoom`);
  survives refresh, kept across resizes; code change keeps zoom, re-centers.
  Reset button clears a tab's saved view. See Gotchas for the svg-pan-zoom
  specifics.
- ✅ Server-side syntax check: `display`/`reload` validate the file with
  `mermaid.parse` (jsdom-backed, `server/mermaid-parse.ts`) and report it in
  `result.parse` — 200 either way; the browser stays the final validator.
- ✅ JS bundle for the pi extension: `npm run bundle` / `npm run ship` → the
  pi package (`index.js` built extension + `server/server.cjs` single-file
  server + `server/dist/` SPA), with extension-managed lifecycle (CLI args,
  pidfile, clean SIGTERM, EADDRINUSE, health carries pid/version, persistent
  token, `--parent-pid` orphan watchdog). See "Bundling and single-file
  builds".
- ✅ The pi extension (`~/.pi/agent/extensions/mermaid/`) wraps
  `POST /api/display`, `POST /api/reload`, `GET /api/state`,
  `DELETE /api/tabs/:name` (the agent can also just `curl`). Endpoint
  contract below is the stable interface for it.
- ✅ Extension-managed server lifecycle: the pi extension spawns/stops/restarts
  the bundled server, tracks the pid, auto-starts it (input probe + tool
  preflight), pins a persistent token, and reaps orphans via
  `--parent-pid`/`POST /api/session` (see "pi extension lifecycle").
- ⬜ Not done (deliberate scope cuts): per-tab mermaid config editor, SVG/PNG
  export, tab renaming, stripping ```mermaid fences from markdown files.

## Commands

```sh
npm run dev      # concurrently: tsx server (:8790) + vite dev (:5173, proxies /api)
npm run build    # tsc -b && vite build → dist/
npm run bundle   # esbuild server → bundle/server/server.cjs, extension → bundle/index.js (+ SPA copy)
npm run ship     # copy bundle/ (the pi package) → ~/.pi/agent/extensions/mermaid/
npm start        # single process: serves dist/ + API on the .env port
npm run lint     # eslint (react-hooks v7 strict rules are ON — see gotchas)
```

Typechecking the extension (the app tsconfig excludes `extension/` — it needs pi's
own packages, which only the pi runtime provides; use pi's install for types):

```sh
cat > /tmp/ext-tsconfig.json <<EOF
{
  "compilerOptions": {
    "noEmit": true, "target": "es2022", "module": "esnext",
    "moduleResolution": "bundler", "strict": true, "skipLibCheck": true,
    "typeRoots": ["$HOME/.pi/agent/npm/node_modules/@types"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["$HOME/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent"],
      "typebox": ["$HOME/.pi/agent/npm/node_modules/typebox"]
    }
  },
  "include": ["$PWD/extension/index.ts"]
}
EOF
tsc -p /tmp/ext-tsconfig.json     # relative include paths resolve against /tmp
```

Test the API while the server runs:

```sh
curl localhost:8790/api/health
curl -X POST localhost:8790/api/display -H 'Content-Type: application/json' \
     -d '{"name":"demo","path":"/abs/file.md"}'
curl -X POST localhost:8790/api/reload -H 'Content-Type: application/json' \
     -d '{"name":"demo"}'
curl localhost:8790/api/state
```

## Configuration — `.env`

| Key | Default | Meaning |
|---|---|---|
| `MERMAID_HOST` | `127.0.0.1` | bind address (keep loopback — the API reads/writes arbitrary local files) |
| `MERMAID_PORT` | `8790` | port |
| `MERMAID_ROOT_DIR` | `$HOME` | starting dir of the Open-file dialog |

**All env keys are `MERMAID_`-prefixed on purpose.** The machine has ambient
`PORT`/`HOST` vars from other services; unprefixed names got hijacked.
Precedence: CLI args > `.env` file > process.env > default. `.env` file
search order: `$MERMAID_SERVER_ENV` → next to the server file → next to the
executable (compiled binary) → `cwd()`. This is what makes the compiled binary
and the bundled `server.cjs` work: put `.env` and `dist/` next to the server
file. CLI args (see Bundling) are how the pi extension passes its own config —
no `.env` needed in the bundle.

## Architecture

```
browser (React SPA, Vite build)
   │  GET/POST /api/*            (plain JSON, no push)
   ▼
Node ESM server (Express) ──── local disk (.md files)
   └─ prod: also serves dist/ on the same port
```

- **No SSE, no websockets.** The browser polls `GET /api/state` every 2 s
  (paused via `visibilitychange` when the tab is hidden). Server → UI latency
  is ≤ 2 s by design; that's the price of keeping the tools trivially curl-able.
- **Disk is the source of truth for content.** The server stores only
  `name → {path, mtime}` in memory (`server/tabs.ts`); content is always
  re-read on demand.
- **One-way data flow:** file → editor → diagram. The diagram never writes back
  to the editor. Only two mutations exist: Save (editor → file) and Reload
  (file → editor, confirms when dirty).
- **Tab name = API identity.** Unique, user-chosen in the Open dialog, used by
  the pi tools. No renaming (close + reopen).

The full public API contract is the next section — the stable interface for
the pi tools.

## Public HTTP API

Stable contract for the pi extension (and any other client). Plain JSON over
HTTP, token-guarded, loopback-only by default. The browser is just one client —
anything that can POST to these endpoints drives the UI.

### Conventions

- **Base URL:** `http://127.0.0.1:8790` by default (`MERMAID_HOST`/
  `MERMAID_PORT` in `.env` can change it — see Configuration). Probe with
  `GET /api/health` first (the only unauthenticated route); if it fails, the
  server isn't running.
- **Auth:** every other route needs the per-start token, accepted as
  `Authorization: Bearer <token>`, `X-Mermaid-Token: <token>`, `?token=<token>`
  or the `mermaid_token` cookie; missing/wrong → 401 `UNAUTHORIZED`. The token
  is passed to the server with `--token` (the pi extension mints one per start),
  or self-generated and injected into the served page when standalone. The SPA
  entry `/` is gated too: `/?token=<t>` sets the cookie and 302-redirects to the
  token-less URL. `window.__MERMAID_TOKEN__` is the injected browser copy.
- All bodies/responses are JSON (`Content-Type: application/json`).
- **Envelope:** every response is
  `{ "result": <payload> | null, "error": null | { "message", "code" } }`.
  Success: `result` carries the payload, `error` is `null`. Failure:
  `result` is `null`, `error` is set. HTTP status stays meaningful
  (400/404/500) — branch on `error.code`, not the message string.
- **Error codes:** `BAD_REQUEST` (400, bad body/params), `FILE_NOT_FOUND`
  (404, unreadable file), `TAB_NOT_FOUND` (404, unknown tab name),
  `UNAUTHORIZED` (401, missing/invalid token), `INTERNAL` (500, unexpected
  failure).
- `mtime` is always milliseconds (`stat.mtimeMs`).
- **Tab name = identity.** Non-empty string, unique per open tab, used by
  every endpoint. No renaming (close + reopen). The server only validates
  non-empty; the client's Open dialog rejects duplicates.
- **`path` is resolved with `path.resolve()` — always pass absolute paths**
  (relative ones resolve against the *server's* cwd, not the caller's).
- The API accepts **any readable text file**; the `.md`/`.markdown`/`.mmd`
  filter exists only in the Open dialog's file browser, not in the API.

### Endpoints

| Endpoint | Body / query | `result` on 200 | Notes |
|---|---|---|---|
| `GET /api/health` | – | `{ ok, pid, version, uptime, watched, sessions }` | liveness probe (only unauthenticated route) |
| `POST /api/session` | `{ pid }` | `{ ok, sessions }` | keep-alive registration for the orphan watchdog |
| `GET /api/browse?dir=<abs>` | `dir` optional (default `MERMAID_ROOT_DIR`) | `{ path, parent, dirs[], files: [{name, isMd}] }` | `parent: null` at fs root; dot-dirs hidden; `isMd` = .md/.markdown/.mmd |
| `GET /api/read?path=<abs>` | – | `{ path, content, mtime }` | 404 `FILE_NOT_FOUND` if unreadable |
| `POST /api/save` | `{ path, content }` | `{ ok, path, mtime }` | creates parent dirs; 500 `INTERNAL` on write error |
| `POST /api/display` | `{ name, path }` | `{ name, path, content, mtime, parse }` | **the "show me" endpoint** — semantics below |
| `POST /api/reload` | `{ name }` | `{ name, path, content, mtime, parse }` | re-reads the tab's file; does **not** activate the tab |
| `DELETE /api/tabs/:name` | – (name URL-encoded) | `{ deleted: true }` | 404 `TAB_NOT_FOUND` for unknown names; clears `lastDisplay` if it pointed at this tab |
| `POST /api/tabs/sync` | `{ tabs: [{name, path, mtime?}] }` | `{ ok }` | client-only: re-registers tabs after a server restart; only adds names the server doesn't know yet |
| `GET /api/state` | – | `{ tabs: [{name, path, mtime}], lastDisplay: {name, at} \| null }` | polled by the browser every 2 s; `mtime` is **re-stat'ed per request** (that is how the client detects on-disk edits) — a missing file keeps the stored mtime |

`parse` is `{ ok: true }` or `{ ok: false, error }` — `error` is the
jison-style message (line number, caret, expected tokens).

### `POST /api/display` semantics (the pi "show" tool)

- Reads the file, **upserts** the tab — an existing `name` is silently
  re-pointed to the new path (content replaced), then sets
  `lastDisplay = { name, at: Date.now() }`.
- The response carries `content` + `mtime`, so a tool can echo/verify the
  diagram source without a second request.
- `result.parse` comes from server-side `mermaid.parse` (jsdom-backed). A
  syntax error does **not** fail the request — the tab still opens and the
  browser shows the same error in the diagram pane; `parse` is the
  curl-able signal for tools (e.g. the pi extension fixing its own diagrams).
- The browser (next 2 s poll, if open and visible) adopts the tab and
  **activates it** whenever `lastDisplay.at` changes — that is the whole
  "show me" mechanism. No push; ≤ 2 s latency by design.
- Errors: 400 `BAD_REQUEST` missing/empty `name` or `path`;
  404 `FILE_NOT_FOUND` unreadable file.

### `POST /api/reload` semantics (the pi "refresh" tool)

- Re-reads the tab's file from disk, returns the fresh content (+ fresh
  `parse`), updates the stored mtime. Does not touch `lastDisplay` (the
  active tab stays put).
- Errors: 400 `BAD_REQUEST` missing `name`; 404 `TAB_NOT_FOUND` unknown tab
  or `FILE_NOT_FOUND` if the file is gone.

### What the browser does with this (2 s poll loop)

1. Server tab not in local state → `GET /api/read` → add tab.
2. Server `mtime` > local `savedMtime` **and tab not dirty** → re-read
   (covers `/api/reload` and external file edits).
3. `lastDisplay.at` changed → activate that tab.

### curl examples (what the pi tools wrap)

```sh
# show a diagram (opens/activates tab "demo" in the UI within ~2 s)
curl -X POST localhost:8790/api/display -H 'Content-Type: application/json' \
     -d '{"name":"demo","path":"/abs/file.md"}'

# re-read the tab's file from disk (picks up external edits)
curl -X POST localhost:8790/api/reload -H 'Content-Type: application/json' \
     -d '{"name":"demo"}'

# what's open / what was last displayed
curl -s localhost:8790/api/state
```

### Notes for the pi extension

- Two tools: `display {name, path}` and `reload {name}` — thin POSTs as above;
  plain `curl` in bash works identically.
- Server URL: default `http://127.0.0.1:8790`; check `GET /api/health` first
  and report "server not running (npm run dev / npm start)" on failure.
- `name` is the user-facing tab name. If the user doesn't give one, derive a
  short one from the file name; check `GET /api/state` for existing names —
  display with an existing name silently re-points that tab.
- `display`/`reload` carry `result.parse` — check it to catch syntax errors
  without the browser. On failure responses branch on `error.code`
  (`TAB_NOT_FOUND`, `FILE_NOT_FOUND`, `BAD_REQUEST`, `INTERNAL`), not the
  message string.
- The extension is global (lives in `~/.pi/agent/extensions/`) and cannot read
  this project's `.env`; use the default or an explicit override in the
  extension's own config (see the `embed` extension's auth.json pattern).

## Flow

### Open (human or pi)
`OpenDialog` (step 1: server-side file browser via `/api/browse`; step 2: name
the tab) → `POST /api/display {name, path}` → response carries content → client
upserts the tab in state + localStorage and activates it. The pi tool does the
exact same POST; the browser picks it up on its next `/api/state` poll.

### Poll (every 2 s, `src/App.tsx`)
1. New server tab not in local state → `GET /api/read` → add tab.
2. Server mtime newer than local `savedMtime` **and tab not dirty** →
   `GET /api/read` → replace content (covers `/api/reload` and external edits).
3. `lastDisplay.at` changed → activate that tab (the "show me" behavior).

### Save / Reload (editor buttons)
- Save: `POST /api/save {path, content}` → update `savedMtime`, clear dirty.
  Also bound to Ctrl/Cmd+S in Monaco.
- Reload: `POST /api/reload {name}` → server re-reads disk → response content
  replaces editor content (confirm dialog when dirty).

### Resilience
- Browser refresh: tabs/content hydrate from localStorage, then the first poll
  merges server-side tabs (pi-opened tabs survive).
- Server restart: the in-memory map is lost; the client re-registers via
  `POST /api/tabs/sync` on startup so `/api/reload` keeps working.
- Diagram view: per-tab pan/zoom hydrates from localStorage on render. A
  content hash gates the location restore — same diagram → exact view; code
  changed → saved zoom is applied but the view re-centers.

## Key files

```
.env                       # MERMAID_HOST / MERMAID_PORT / MERMAID_ROOT_DIR
server/
  index.ts                 # express app: API + static dist/ (Express 5: no '*' routes, use regex);
                           # lifecycle: pidfile, SIGTERM/SIGINT shutdown, EADDRINUSE
  args.ts                  # CLI args (--host/--port/--root/--pidfile/-h/-v), parseArgs strict
  paths.ts                 # SCRIPT_DIR — script-relative .env/dist resolution (bundle-safe)
  version.ts               # VERSION constant (--version, /api/health, startup line)
  tabs.ts                  # in-memory name → {path, mtime} map
  env.ts                   # .env parser + loader (no dotenv dep); CLI > .env > process.env
  dom.ts                   # jsdom globals (window/document/navigator) — MUST be
                           # imported before 'mermaid' evaluates
  mermaid-parse.ts         # mermaid.parse wrapper → { ok, error? }; 200-safe
src/
  App.tsx                  # tab state, 2 s polling, save/reload/close, resizable split
  lib/
    api.ts                 # fetch wrappers for every endpoint
    storage.ts             # localStorage, all keys prefixed "mermaid-server:" (incl. panzoom)
    types.ts               # Tab / ViewState / ServerState / TabPanZoom
    monaco.ts              # monaco bootstrap: editor worker + initEditor()
    monacoExtra.ts         # mermaid language definition — COPIED VERBATIM from the
                           # mermaid live editor; keep it in sync if you upgrade
    svg-pan-zoom.d.ts      # hand-written minimal types (no @types package)
  components/
    Navbar.tsx  TabBar.tsx  OpenDialog.tsx
    EditorPane.tsx         # Monaco wrapper (create once, setValue on tab switch)
    DiagramPane.tsx        # mermaid.render + svg-pan-zoom/hammerjs + toolbars;
                           # per-tab pan/zoom persistence, SVG stretch to pane
```

## Gotchas (learned the hard way)

- **Monaco worker import path**: monaco's `exports` map subpaths relative to
  `esm/vs/`, so the correct specifier is
  `monaco-editor/editor/editor.worker?worker` — NOT
  `monaco-editor/esm/vs/editor/editor.worker?worker` (doubles the path, build
  fails).
- **No `@monaco-editor/react`** — its default loader fetches monaco from a
  jsdelivr CDN at runtime (violates the offline rule). We use `monaco-editor`
  directly with a ~30-line wrapper.
- **`@types/svg-pan-zoom` does not work here** — types live in
  `src/lib/svg-pan-zoom.d.ts` instead.
- **react-hooks v7 lint rules are strict**: no ref writes during render (sync
  refs in `useEffect`), no synchronous setState in effect bodies (the
  fetch-on-mount in OpenDialog has a justified disable comment).
- **Express 5**: `app.get('*', …)` throws; the SPA fallback uses a regex route
  `app.get(/^(?!\/api\/).*/, …)`.
- **mermaid.render** needs a unique id per call (counter in DiagramPane) and
  `securityLevel: 'strict'` stays on — content is user-supplied.
- **Mermaid's SVG must be stretched to fill the pane.** mermaid.render emits
  `<svg width="100%" style="max-width: Wpx" viewBox="…">` with no height —
  left alone, the SVG box is sized by the diagram's aspect ratio and pan/zoom
  clips at its edges (a visible "strip"). `.diagram-host svg { width/height:
  100% }` in index.css fixes the box; the inline `max-width` still beats the
  stylesheet, so DiagramPane also sets `style.maxWidth = '100%'` in JS.
- **svg-pan-zoom specifics:** `onPan`/`onZoom` fire synchronously inside
  `setCTM` (a suppression ref reliably guards programmatic resets); `zoom(z)`
  is a relative multiplier, `zoom(z, true)` absolute; `resize()` re-baselines
  the fit state without changing the view — use it on container resize instead
  of `reset()`; on init it caches and strips the `viewBox` attribute.
- **Vite dev**: the server also serves the *stale* `dist/` on :8790; use
  :5173 for HMR during development.
- **pkill footgun**: `pkill -f "tsx server/index.ts"` matches your own shell's
  command line; use the `pkill -f "tsx server/[i]ndex.ts"` bracket trick.
- **Ambient `NODE_ENV=production`** (same class of hijack as `PORT`/`HOST`):
  npm treats it as `--omit=dev` — `npm install`/`npm ci` silently skip
  devDependencies (typescript, vite, tsx, @types/*) and can even prune them
  from an existing node_modules. After wiping node_modules use
  `npm ci --include=dev`.
- **jsdom + mermaid import order**: `server/dom.ts` sets the browser globals
  and must run **before** `mermaid` is evaluated — ESM runs deps in source
  order, so `import './dom.js'` listed first in `mermaid-parse.ts` is enough.
  Node ≥ 21 has a read-only global `navigator` getter; plain assignment
  throws in strict mode, so `dom.ts` uses `Object.defineProperty`.
  `mermaid.render` is NOT done server-side (jsdom lacks SVG layout APIs);
  parse only.
- **Bundling single-file: esbuild shims `import.meta` as `{}` in CJS output**
  (no `.url`). Both consequences are handled in `scripts/bundle.mjs` —
  re-verify after any jsdom/css-tree version bump:
  - `server/paths.ts` falls back to `__dirname` when `fileURLToPath(
    import.meta.url)` throws.
  - jsdom's top-level `require.resolve("./xhr-sync-worker.js")` is patched by
    a banner (`require.resolve` falls back to the raw string — the sync XHR
    worker is never used here), and jsdom's top-level
    `readFileSync(default-stylesheet.css)` is swapped for inlined CSS by a
    plugin. css-tree's `createRequire(import.meta.url)` JSON requires are
    likewise inlined by a plugin.
- **ESLint OOMs on `bundle/`** if it is not ignored (21 MB minified CJS) —
  `bundle` sits in `globalIgnores` in `eslint.config.js`; keep it there.

## Bundling and single-file builds

Goal: run the whole app (server + client) from files that can be dropped next
to the pi extension — and, as an option, from one standalone binary.
**Maintain this section as the build changes.**

### JS bundle (implemented) — the extension deployment

The server is plain ESM TypeScript with zero native dependencies (jsdom is
pure JS), so esbuild compiles the whole server into a single CJS file that
runs on plain node — no node_modules, no bun, cross-platform:

```sh
npm run bundle   # → bundle/{index.js,package.json,server/server.cjs,server/dist/}
npm run ship     # copy bundle/ (the pi package) → ~/.pi/agent/extensions/mermaid/
```

```sh
# Typechecking the extension: the app tsconfig excludes extension/ (it needs pi's
# own packages, which only the pi runtime provides). Run it against pi's install:
tsc -p /dev/stdin <<'EOF'
{
  "compilerOptions": {
    "noEmit": true, "target": "es2022", "module": "esnext",
    "moduleResolution": "bundler", "strict": true, "skipLibCheck": true,
    "typeRoots": ["$HOME/.pi/agent/npm/node_modules/@types"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["$HOME/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent"],
      "typebox": ["$HOME/.pi/agent/npm/node_modules/typebox"]
    }
  },
  "include": ["extension/index.ts"]
}
EOF
node bundle/server.cjs --port 8791
```

- CJS output on purpose: esbuild inlines mermaid's dynamic diagram-module
  imports into the one file (ESM output would emit extra chunks).
- `server.cjs` resolves `.env` and `dist/` **next to itself first**
  (`SCRIPT_DIR` in `server/paths.ts`), then the executable's dir (compiled
  binary), then `cwd/`. No `dist/` found → API-only mode with a notice on `/`.
- `SCRIPT_DIR` is `fileURLToPath(import.meta.url)` with a `__dirname`
  fallback — esbuild does NOT shim `import.meta` in CJS output (see
  Gotchas). jsdom/css-tree single-file shims live in `scripts/bundle.mjs`
  and fail the build loudly if those libs change layout.
- Lifecycle contract for the extension that spawns it (detached):
  - `--pidfile <path>`: written on successful listen, removed on exit (only
    if it still names this pid).
  - SIGTERM/SIGINT → close server, drop keep-alive connections, remove
    pidfile, exit 0 (3 s hard backstop).
  - EADDRINUSE → clear one-liner, exit 1 — the spawner re-probes
    `/api/health` to settle "already running" (probe-then-spawn race).
  - `GET /api/health` → `{ ok, pid, version, uptime, watched, sessions }` —
    pid lets the extension reconcile its saved pid against the actual listener;
    `sessions`/`watched` expose the orphan watchdog state.
  - `--parent-pid <n>` → the server watches that pid (plus any pid registered
    via `POST /api/session`) and exits once the set drains, so a SIGKILLed
    spawner cannot leave an orphan. Absent → standalone, never self-exits.
  - stdout carries the startup line
    `mermaid-server v… (pid …) listening on http://host:port` — the extension
    redirects it to its own log file.

### CLI args (implemented)

`--host <ip>`, `--port <n>`, `--root <dir>`, `--pidfile <path>`,
`--token <hex>`, `--parent-pid <n>`, `-h/--help`, `-v/--version` — `node:util` `parseArgs` (built-in, no
dependency), strict mode (unknown flags fail, exit 2). Precedence:
**CLI args > `.env` file > process.env > defaults** (`server/args.ts` +
`server/env.ts`).

### Server binary (implemented, optional alternative)

Compiles to a single standalone binary (bun runtime + express + code):

```sh
bun build --compile server/index.ts --outfile mermaid-server
```

- Platform-specific — rebuild after OS/arch changes. No npm script for it yet;
  bun is not installed on this machine (the JS bundle above is the default
  path — it needs no build-time tooling beyond node + esbuild).
- Resolves `.env`/`dist/` next to the executable first — same chain as the
  bundle (see Configuration). Node SEA remains the other alternative.

### Client single-file build (not implemented)

`vite build` already emits one JS + one CSS. To collapse into a single
`index.html`:

1. `vite-plugin-singlefile` (build-time-only dep) inlines JS + CSS into
   `index.html`.
2. Monaco worker: change the import in `src/lib/monaco.ts` from
   `monaco-editor/editor/editor.worker?worker` to `?worker&inline` — otherwise
   Vite emits the worker as a separate file. Base64-inlining adds ~33% to its
   size; it runs via a Blob URL in the browser.

Keep this a separate build target (e.g. its own vite config); the normal
multi-file `dist/` stays for dev / `npm start`.

### Embedding the client in the binary (not implemented)

Bun compiled binaries can embed files:

```ts
import indexHtml from '../dist-single/index.html' with { type: 'file' }
```

then serve it from memory instead of `express.static(distDir)` (the static
block in `server/index.ts` already has a no-dist fallback to extend) → truly
one file, nothing to install besides the binary. Alternative: a `--dist
<path>` arg / `MERMAID_DIST_DIR` env with the SPA installed to e.g.
`/usr/local/lib/mermaid-server/dist/`.

### Global install

A compiled binary is self-contained — "install globally" = put it on PATH:

```sh
sudo install -o root -g root -m 755 mermaid-server /usr/local/bin/
mermaid-server            # until CLI args land: uses .env / defaults
```

No bun/node needed at runtime. `bun link -g` / `npm i -g` are pointless
ceremony for a standalone binary (they would add a runtime dependency).

## Source references

- Live editor (UI inspiration, Monaco definition, pan/zoom approach): the
  `mermaid-live-editor` project — `src/lib/util/monacoExtra.ts`,
  `src/lib/util/panZoom.ts`.
- Mermaid library source: `node_modules/mermaid` (or the upstream mermaid repo).
