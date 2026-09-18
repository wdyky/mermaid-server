import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CliArgs } from './args.js'
import { SCRIPT_DIR } from './paths.js'

export interface ServerEnv {
  host: string
  port: number
  rootDir: string
  /**
   * Shared secret guarding the file-access API. The pi extension passes its
   * own via --token and keeps it; a standalone run self-generates one and the
   * server injects it into the served page so the browser can authenticate.
   */
  token: string
  /**
   * Pid of the process that spawned us (the pi extension passes its own).
   * When set, the server watches it and exits once no live parent/session
   * remains — so a SIGKILLed pi cannot leave an orphan server behind.
   * null = standalone (never self-exits on its own).
   */
  parentPid: number | null
}

/** Minimal .env parser: KEY=VALUE lines, # comments, optional quotes. */
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '') out[key] = value
  }
  return out
}

/**
 * Resolve host/port/rootDir.
 *
 * Precedence per key: CLI args > .env file > process.env > default.
 * The .env file is authoritative over process.env so an ambient PORT/HOST
 * (e.g. inherited from another service) can never hijack this server's port.
 * CLI args sit on top — that is how the pi extension passes its own config
 * (host/port/rootDir live in the extension's config.json) with no .env at all.
 *
 * .env file search order (first existing wins):
 *   1. $MERMAID_SERVER_ENV (explicit path)
 *   2. next to the server file (SCRIPT_DIR — tsx dev and bundled layout)
 *   3. next to the executable (compiled-binary layout)
 *   4. process.cwd()
 */
export function loadEnv(cli: CliArgs = {}): ServerEnv {
  const candidates: string[] = []
  if (process.env.MERMAID_SERVER_ENV) candidates.push(process.env.MERMAID_SERVER_ENV)
  candidates.push(path.join(SCRIPT_DIR, '.env'))
  candidates.push(path.join(path.dirname(process.execPath), '.env'))
  candidates.push(path.join(process.cwd(), '.env'))

  const fileEnv: Record<string, string> = {}
  for (const file of candidates) {
    if (existsSync(file)) {
      Object.assign(fileEnv, parseEnvFile(file))
      break
    }
  }

  const get = (key: string, fallback: string): string =>
    fileEnv[key] ?? process.env[key] ?? fallback

  return {
    host: cli.host ?? get('MERMAID_HOST', '127.0.0.1'),
    port: cli.port ?? (Number(get('MERMAID_PORT', '8790')) || 8790),
    rootDir: cli.root ?? get('MERMAID_ROOT_DIR', process.env.HOME ?? process.cwd()),
    token: cli.token?.trim() || randomBytes(16).toString('hex'),
    parentPid: cli.parentPid ?? null,
  }
}
