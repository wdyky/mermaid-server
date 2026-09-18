import { parseArgs } from 'node:util'
import { VERSION } from './version.js'

export interface CliArgs {
  host?: string
  port?: number
  root?: string
  pidfile?: string
  token?: string
  parentPid?: number
}

const USAGE = `mermaid-server v${VERSION} — local mermaid diagram editor

Usage: node server.cjs [options]

Options:
  --host <ip>       Bind address (default 127.0.0.1)
  --port <n>        Port (default 8790)
  --root <dir>      Starting dir of the Open-file dialog (default $HOME)
  --pidfile <path>  Write the process id here on start, remove on exit
  --token <hex>     Shared API/UI secret (default: random per start)
  --parent-pid <n>  Exit when this process is gone (orphan watchdog; the pi
                    extension passes its own pid so a SIGKILLed pi does not
                    leave the server running)
  -h, --help        Show this help
  -v, --version     Print version and exit

Precedence per setting: CLI args > .env file > process.env > defaults.`

/**
 * Parse process.argv with node:util parseArgs (strict — unknown flags fail).
 * `--help`/`--version` print and exit(0); parse failures exit(2).
 * The result is an *optional* override layer on top of the .env/env chain.
 */
export function parseCliArgs(): CliArgs {
  let values: Record<string, string | boolean | undefined>
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined
  try {
    ;({ values } = parseArgs({
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        root: { type: 'string' },
        pidfile: { type: 'string' },
        token: { type: 'string' },
        'parent-pid': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
    }))
  } catch (err) {
    console.error((err as Error).message.split('\n')[0])
    console.error(USAGE)
    process.exit(2)
  }

  if (values.version) {
    console.log(VERSION)
    process.exit(0)
  }
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }

  let port: number | undefined
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`mermaid-server: invalid --port: ${values.port}`)
      process.exit(2)
    }
  }

  let parentPid: number | undefined
  if (values['parent-pid'] !== undefined) {
    parentPid = Number(values['parent-pid'])
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
      console.error(`mermaid-server: invalid --parent-pid: ${values['parent-pid']}`)
      process.exit(2)
    }
  }

  return {
    host: str(values.host),
    port,
    root: str(values.root),
    pidfile: str(values.pidfile),
    token: str(values.token),
    parentPid,
  }
}
