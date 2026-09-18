import type { ServerState } from './types'

export interface BrowseResult {
  path: string
  parent: string | null
  dirs: string[]
  files: { name: string; isMd: boolean }[]
}

export interface ReadResult {
  path: string
  content: string
  mtime: number
}

export interface SaveResult {
  ok: boolean
  path: string
  mtime: number
}

export interface ParseResult {
  ok: boolean
  error?: string
}

export interface DisplayResult {
  name: string
  path: string
  content: string
  mtime: number
  parse: ParseResult
}

export interface ReloadResult {
  name: string
  path: string
  content: string
  mtime: number
  parse: ParseResult
}

// Token resolution order:
//   1. window.__MERMAID_TOKEN__ — injected by the server into the served
//      index.html (production / bundled SPA).
//   2. ?token=<t> in the URL — the dev flow (Vite on :5173 serves the SPA
//      without injection); remembered in localStorage so reloads and the
//      ?token-less address bar keep working.
//   3. localStorage (previous ?token=).
// Every /api call carries the token as the Authorization header; a missing
// token means every call but /api/health fails with 401.
const TOKEN: string = (() => {
  if (typeof window === 'undefined') return ''
  const injected = (window as unknown as { __MERMAID_TOKEN__?: string }).__MERMAID_TOKEN__
  if (injected) return injected
  try {
    const urlToken = new URLSearchParams(window.location.search).get('token')
    if (urlToken) {
      localStorage.setItem('mermaid-server:token', urlToken)
      return urlToken
    }
    return localStorage.getItem('mermaid-server:token') ?? ''
  } catch {
    return ''
  }
})()
const authHeaders = (): Record<string, string> =>
  TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}

// Every API response is { result, error } — unwrap it: throw on error,
// return the payload otherwise. The error carries `code` so callers can
// branch (e.g. UNAUTHORIZED → "open with ?token=", vs a dead server).
async function handle<T>(res: Response): Promise<T> {
  let body: { result: T | null; error: { message: string; code: string } | null }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return body.result as T
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })

export const api = {
  browse: (dir: string): Promise<BrowseResult> =>
    fetch(`/api/browse?dir=${encodeURIComponent(dir)}`, { headers: authHeaders() }).then((r) =>
      handle<BrowseResult>(r),
    ),

  read: (path: string): Promise<ReadResult> =>
    fetch(`/api/read?path=${encodeURIComponent(path)}`, { headers: authHeaders() }).then((r) =>
      handle<ReadResult>(r),
    ),

  save: (path: string, content: string): Promise<SaveResult> =>
    post('/api/save', { path, content }).then((r) => handle<SaveResult>(r)),

  display: (name: string, path: string): Promise<DisplayResult> =>
    post('/api/display', { name, path }).then((r) => handle<DisplayResult>(r)),

  reload: (name: string): Promise<ReloadResult> =>
    post('/api/reload', { name }).then((r) => handle<ReloadResult>(r)),

  closeTab: (name: string): Promise<{ deleted: true }> =>
    fetch(`/api/tabs/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() }).then(
      (r) => handle<{ deleted: true }>(r),
    ),

  sync: (tabs: { name: string; path: string; mtime: number }[]): Promise<{ ok: boolean }> =>
    post('/api/tabs/sync', { tabs }).then((r) => handle<{ ok: boolean }>(r)),

  state: (): Promise<ServerState> =>
    fetch('/api/state', { headers: authHeaders() }).then((r) => handle<ServerState>(r)),
}
