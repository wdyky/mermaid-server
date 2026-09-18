import express from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseCliArgs } from './args.js'
import { loadEnv } from './env.js'
import { SCRIPT_DIR } from './paths.js'
import { TabStore } from './tabs.js'
import { VERSION } from './version.js'
import { parseDiagram } from './mermaid-parse.js'

const cli = parseCliArgs()
const env = loadEnv(cli)
const store = new TabStore()
const app = express()

app.use(express.json({ limit: '10mb' }))

const MD_EXT = new Set(['.md', '.markdown', '.mmd'])

const mtimeMs = (p: string): number => statSync(p).mtimeMs

// ---------------------------------------------------------------- envelope
//
// Every API response has the same shape:
//   { "result": <payload> | null, "error": null | { "message", "code" } }
// HTTP status stays meaningful (400/404/500); the code makes errors
// branchable without string-matching English messages.

type ErrorCode =
  | 'BAD_REQUEST'
  | 'FILE_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'INTERNAL'

const ok = (res: express.Response, result: unknown): void => {
  res.json({ result, error: null })
}

const fail = (res: express.Response, status: number, code: ErrorCode, message: string): void => {
  res.status(status).json({ result: null, error: { message, code } })
}

// ---------------------------------------------------------------- auth
//
// Every /api route except /api/health requires the shared token — the
// per-start secret that guards the file-access API (read/save/browse/display).
// The pi extension passes its own via --token and keeps it in meta to
// authenticate; a standalone server self-generates one and injects it into the
// served page (see the static block) so the browser can authenticate too.
//
// Accepted transports (any one):
//   • Authorization: Bearer <token>  (pi extension; a custom header also
//     triggers a CORS preflight, keeping the token same-origin)
//   • X-Mermaid-Token: <token>
//   • ?token=<token>  (jupyter-style convenience)
//   • the mermaid_token cookie (set by the SPA-entry redirect below)
// The SPA itself is gated too: without a token the page is not served at all.

const hashToken = (t: string): Buffer => createHash('sha256').update(t).digest()
const tokenOk = (provided: string): boolean =>
  timingSafeEqual(hashToken(provided), hashToken(env.token))

const TOKEN_COOKIE = 'mermaid_token'

/** Read one cookie value from the raw Cookie header (no cookie-parser dep). */
const cookieValue = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const v = part.slice(eq + 1).trim()
    return v ? decodeURIComponent(v) : undefined
  }
  return undefined
}

/** The token presented on this request, from any accepted transport. */
const presentedToken = (req: express.Request): string | undefined => {
  const bearer = req.headers.authorization
  return (
    (typeof req.query.token === 'string' ? req.query.token : undefined) ??
    (bearer && bearer.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : undefined) ??
    (typeof req.headers['x-mermaid-token'] === 'string' ? req.headers['x-mermaid-token'] : undefined) ??
    cookieValue(req.headers.cookie, TOKEN_COOKIE)
  )
}

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next()
  const provided = presentedToken(req)
  if (!provided || !tokenOk(provided)) {
    fail(res, 401, 'UNAUTHORIZED', 'missing or invalid token')
    return
  }
  next()
})

// ---------------------------------------------------------------- endpoints

// ── session registry (orphan watchdog) ─────────────────────────────────────
// Which processes still want this server. Seeded from --parent-pid and
// refreshed by POST /api/session; the watchdog exits the server when the
// watched set drains (a SIGKILLed pi skips session_shutdown, so this is the
// only thing that reclaims the port/process in that case).
const sessionPids = new Set<number>()
if (env.parentPid !== null) sessionPids.add(env.parentPid)

/** Drop pids that are no longer alive (ESRCH). */
function liveSessions(): void {
  for (const pid of sessionPids) {
    try {
      process.kill(pid, 0)
    } catch {
      sessionPids.delete(pid)
    }
  }
}

app.get('/api/health', (_req, res) => {
  // pid/version let a managing client (the pi extension) confirm it talks to
  // the instance it started and detect orphans after lost pid state.
  // `watched`/`sessions` describe the orphan watchdog (see POST /api/session).
  liveSessions()
  ok(res, {
    ok: true,
    pid: process.pid,
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    watched: env.parentPid !== null,
    sessions: sessionPids.size,
  })
})

/**
 * Keep-alive registration (authenticated): a managing client (the pi
 * extension) posts its own pid so the orphan watchdog can tell whether any
 * pi session still cares about this server. Re-posting is idempotent and is
 * how a fresh pi adopts a server an older pi spawned.
 */
app.post('/api/session', (req, res) => {
  const pid = Number((req.body ?? {})?.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    fail(res, 400, 'BAD_REQUEST', 'body must be { pid: <positive int> }')
    return
  }
  sessionPids.add(pid)
  ok(res, { ok: true, sessions: sessionPids.size })
})

/** File browser for the Open dialog. */
app.get('/api/browse', (req, res) => {
  let dir: string
  try {
    dir = path.resolve(String(req.query.dir ?? env.rootDir))
    if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`)
  } catch (err) {
    fail(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, isMd: MD_EXT.has(path.extname(e.name).toLowerCase()) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    ok(res, {
      path: dir,
      parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
      dirs,
      files,
    })
  } catch (err) {
    fail(res, 400, 'BAD_REQUEST', (err as Error).message)
  }
})

app.get('/api/read', (req, res) => {
  const p = path.resolve(String(req.query.path ?? ''))
  try {
    const content = readFileSync(p, 'utf8')
    ok(res, { path: p, content, mtime: mtimeMs(p) })
  } catch (err) {
    fail(res, 404, 'FILE_NOT_FOUND', `cannot read ${p}: ${(err as Error).message}`)
  }
})

app.post('/api/save', (req, res) => {
  const { path: p, content } = (req.body ?? {}) as { path?: unknown; content?: unknown }
  if (typeof p !== 'string' || p === '' || typeof content !== 'string') {
    fail(res, 400, 'BAD_REQUEST', 'path and content (strings) required')
    return
  }
  const abs = path.resolve(p)
  try {
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    ok(res, { ok: true, path: abs, mtime: mtimeMs(abs) })
  } catch (err) {
    fail(res, 500, 'INTERNAL', `cannot write ${abs}: ${(err as Error).message}`)
  }
})

/**
 * Display a diagram: read the file, register the tab, mark it as the one to
 * show. The browser picks this up on its next /api/state poll.
 *
 * The file is also validated with mermaid.parse. Syntax errors do NOT fail
 * the request — the tab still opens and the browser shows the same error in
 * the diagram pane; result.parse is the curl-able signal for tools.
 */
app.post('/api/display', async (req, res) => {
  const { name, path: p } = (req.body ?? {}) as { name?: unknown; path?: unknown }
  if (typeof name !== 'string' || name.trim() === '') {
    fail(res, 400, 'BAD_REQUEST', 'name (non-empty string) required')
    return
  }
  if (typeof p !== 'string' || p === '') {
    fail(res, 400, 'BAD_REQUEST', 'path (non-empty string) required')
    return
  }
  const abs = path.resolve(p)
  let content: string
  let mtime: number
  try {
    content = readFileSync(abs, 'utf8')
    mtime = mtimeMs(abs)
  } catch (err) {
    fail(res, 404, 'FILE_NOT_FOUND', `cannot read ${abs}: ${(err as Error).message}`)
    return
  }
  const parse = await parseDiagram(content)
  store.upsert(name, abs, mtime)
  store.setLastDisplay(name)
  ok(res, { name, path: abs, content, mtime, parse })
})

/** Re-read a known tab's file from disk (and re-validate it). */
app.post('/api/reload', async (req, res) => {
  const { name } = (req.body ?? {}) as { name?: unknown }
  if (typeof name !== 'string' || name === '') {
    fail(res, 400, 'BAD_REQUEST', 'name required')
    return
  }
  const tab = store.get(name)
  if (!tab) {
    fail(res, 404, 'TAB_NOT_FOUND', `unknown tab: ${name}`)
    return
  }
  let content: string
  let mtime: number
  try {
    content = readFileSync(tab.path, 'utf8')
    mtime = mtimeMs(tab.path)
  } catch (err) {
    fail(res, 404, 'FILE_NOT_FOUND', `cannot read ${tab.path}: ${(err as Error).message}`)
    return
  }
  const parse = await parseDiagram(content)
  store.upsert(name, tab.path, mtime)
  ok(res, { name, path: tab.path, content, mtime, parse })
})

app.delete('/api/tabs/:name', (req, res) => {
  try {
    const deleted = store.delete(req.params.name)
    if (!deleted) {
      fail(res, 404, 'TAB_NOT_FOUND', `unknown tab: ${req.params.name}`)
      return
    }
    ok(res, { deleted: true })
  } catch (err) {
    fail(res, 500, 'INTERNAL', (err as Error).message)
  }
})

/** Client re-registers its tabs (startup / after server restart). */
app.post('/api/tabs/sync', (req, res) => {
  const { tabs } = (req.body ?? {}) as { tabs?: unknown }
  if (!Array.isArray(tabs)) {
    fail(res, 400, 'BAD_REQUEST', 'tabs array required')
    return
  }
  store.sync(
    tabs.filter(
      (t): t is { name: string; path: string; mtime?: number } =>
        !!t && typeof (t as Record<string, unknown>).name === 'string' &&
        typeof (t as Record<string, unknown>).path === 'string',
    ),
  )
  ok(res, { ok: true })
})

/** Polled by the browser: tab map + what was last asked to display.
 *
 * The stored per-tab mtime only reflects what the server last *read*; the
 * browser compares it against its own to detect external edits, so report the
 * file's CURRENT mtime (re-stat every poll — cheap, and it's the only way the
 * "external edit → editor refresh" flow can trigger). Unreadable file → keep
 * the stored mtime (the browser then keeps its local copy). */
app.get('/api/state', (_req, res) => {
  const { tabs, lastDisplay } = store.state()
  ok(res, {
    tabs: tabs.map((t) => {
      try {
        return { ...t, mtime: mtimeMs(t.path) }
      } catch {
        return t
      }
    }),
    lastDisplay,
  })
})

// ------------------------------------------------------------------- static
//
// The SPA is served from dist/. index.html is injected with the per-start
// token (window.__MERMAID_TOKEN__) so the browser can authenticate to the
// API; everything else (assets) is served verbatim by express.static.

const distDir = [
  path.join(SCRIPT_DIR, 'dist'), // bundled / tsx layout: dist next to the server file
  path.join(path.dirname(process.execPath), 'dist'), // compiled-binary layout
  path.join(process.cwd(), 'dist'),
].find((d) => existsSync(path.join(d, 'index.html')))

if (distDir) {
  const indexPath = path.join(distDir, 'index.html')

  /**
   * Gate the SPA (jupyter-style):
   *   • no/invalid token  → 401 hint page (the app is never served),
   *   • ?token=<valid>    → set the mermaid_token cookie and 302 to the same
   *     URL without the query param, so the address bar can be cleaned and
   *     reloads/deep links keep working off the cookie,
   *   • valid cookie/header → serve.
   * /api is handled by its own middleware above (skipped here).
   */
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api')) return next()
    const provided = presentedToken(req)
    if (!provided || !tokenOk(provided)) {
      res
        .status(401)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>mermaid-server — 401</title>' +
            '<body style="font:14px/1.5 system-ui;padding:2rem;max-width:42rem">' +
            '<h1 style="font-size:1.1rem">401 Unauthorized</h1>' +
            '<p>This server requires a token. Open it as ' +
            '<code>/?token=&lt;token&gt;</code> (the token is printed on start / kept ' +
            'in the pi extension\'s meta file). The token is then stored in a cookie ' +
            'and can be removed from the URL.</p></body>',
        )
      return
    }
    if (typeof req.query.token === 'string') {
      res.cookie(TOKEN_COOKIE, env.token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      })
      const url = new URL(req.originalUrl, 'http://localhost')
      url.searchParams.delete('token')
      res.redirect(302, url.pathname + url.search)
      return
    }
    next()
  })

  // Serve the (token-injected) SPA entry for / and for any non-API, non-file
  // route (Express 5: no '*' path). Registered before express.static so the
  // raw (token-less) index.html is never served for /index.html; index:false
  // keeps static from doing it for /. Both would lose the injected token.
  const serveApp = (_req: express.Request, res: express.Response): void => {
    try {
      const html = readFileSync(indexPath, 'utf8').replace(
        '</head>',
        `<script>window.__MERMAID_TOKEN__="${env.token}"</script>\n  </head>`,
      )
      res.type('html').send(html)
    } catch (err) {
      res.status(500).send(`cannot serve index.html: ${(err as Error).message}`)
    }
  }
  app.get('/index.html', serveApp)
  app.use(express.static(distDir, { index: false }))
  app.get('/', serveApp)
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    // Let express.static handle real asset files; fall back to the SPA for the
    // rest (client-side routes).
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    return serveApp(req, res)
  })
} else {
  app.get('/', (_req, res) => {
    res.send('mermaid-server: API is up. No dist/ found — run `npm run build` for the UI.')
  })
}

// ---------------------------------------------------------------- lifecycle
//
// The pi extension spawns this process (detached) and manages it by pid:
// SIGTERM → clean close, pidfile removed, exit 0. EADDRINUSE means someone
// else owns the port — exit non-zero so the spawner's health re-probe can
// settle "already running" instead of a crash stack.

const server = app.listen(env.port, env.host, () => {
  writePidfile()
  console.log(
    `mermaid-server v${VERSION} (pid ${process.pid}) listening on http://${env.host}:${env.port}`,
  )
  if (!distDir) console.log('note: no dist/ found, serving API only')
  // The API can read/write arbitrary local files: loopback is the safe default.
  if (env.host !== '127.0.0.1' && env.host !== 'localhost' && env.host !== '::1') {
    console.warn(
      `WARNING: bound to non-loopback address ${env.host} — the token-guarded API can ` +
        'read/write arbitrary local files. Prefer 127.0.0.1.',
    )
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `mermaid-server: port ${env.port} already in use — is another instance running?`,
    )
  } else {
    console.error(`mermaid-server: failed to listen: ${err.message}`)
  }
  process.exit(1)
})

function writePidfile(): void {
  if (!cli.pidfile) return
  try {
    mkdirSync(path.dirname(cli.pidfile), { recursive: true })
    writeFileSync(cli.pidfile, String(process.pid))
  } catch (err) {
    console.error(`warning: cannot write pidfile ${cli.pidfile}: ${(err as Error).message}`)
  }
}

/** Best effort; only removes a pidfile that still names us. */
function removePidfile(): void {
  if (!cli.pidfile) return
  try {
    if (Number(readFileSync(cli.pidfile, 'utf8')) === process.pid) unlinkSync(cli.pidfile)
  } catch {
    // missing/unreadable pidfile — nothing to do
  }
}

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`mermaid-server: shutting down (${reason})`)
  // Hard backstop in case close() stalls on connections we cannot see.
  setTimeout(() => {
    removePidfile()
    process.exit(0)
  }, 3000)
  server.close(() => {
    removePidfile()
    process.exit(0)
  })
  // Let in-flight requests finish, then drop keep-alive connections —
  // an actively polling browser would otherwise hold the server open.
  setTimeout(() => server.closeAllConnections(), 500).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// Orphan watchdog: only meaningful when a spawner asked us to watch it
// (--parent-pid). A standalone server (npm start / node server.cjs) is left
// alone — it exits only on a signal.
if (env.parentPid !== null) {
  const SESSION_SWEEP_MS = 5_000
  setInterval(() => {
    liveSessions()
    if (sessionPids.size === 0) shutdown('orphaned — no live parent session')
  }, SESSION_SWEEP_MS).unref()
}
