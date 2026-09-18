import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The directory this server file (or the bundled server.cjs) lives in.
 *
 * Native ESM (tsx dev): `import.meta.url` is real.
 * esbuild CJS bundle: esbuild shims `import.meta` as an empty object, so
 * `fileURLToPath(import.meta.url)` throws — fall back to `__dirname`, which
 * IS real there (the bundle file's own directory).
 * (Not `import.meta.dirname`: esbuild does not shim it either way.)
 */
export const SCRIPT_DIR: string = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return __dirname
  }
})()
