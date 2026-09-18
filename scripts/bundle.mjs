#!/usr/bin/env node
/**
 * Bundle everything ship-able into bundle/ — a self-contained pi package:
 *
 *   npm run bundle
 *
 * Output (bundle/, i.e. the package):
 *   index.js            esbuild bundle of extension/index.ts (ESM; pi core deps
 *                       stay external and are provided by the pi runtime)
 *   package.json        pi manifest (pi.extensions → ./index.js) + npm metadata
 *   README.md, LICENSE
 *   server/server.cjs   single-file CJS server bundle (plain node, no deps)
 *   server/dist/        the Vite SPA (run `npm run build` first; without it the
 *                       server runs API-only)
 *
 * `npm run ship` copies bundle/ into the local extension dir;
 * `npm publish` can be run from bundle/ as-is.
 */
import { cpSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'bundle')

// css-tree's lib/data.js, lib/data-patch.js, lib/version.js load JSON via
// `createRequire(import.meta.url)(...)` — a dynamic require esbuild cannot
// analyze; in CJS output `import.meta` is an empty object, so the very first
// line of each file throws. Rewrite those files: drop the createRequire dance,
// inline every require('...json') as a build-time object literal. Fails the
// build loudly if css-tree changes its layout.
function inlineCssTreeJsonRequires() {
  return {
    name: 'inline-css-tree-json-requires',
    setup(build) {
      build.onLoad({ filter: /css-tree[\\/]lib[\\/][\w.-]+\.js$/ }, (args) => {
        let src
        try {
          src = readFileSync(args.path, 'utf8')
        } catch {
          return
        }
        if (!src.includes('createRequire(import.meta.url)')) return
        const dir = path.dirname(args.path)
        const resolveSpec = (spec) =>
          spec.startsWith('.')
            ? path.resolve(dir, spec)
            : path.join(root, 'node_modules', spec)
        const rewritten = src
          .replace(/import \{ createRequire \} from ['"]module['"];\n?/, '')
          .replace(/const require = createRequire\(import\.meta\.url\);\n?/, '')
          .replace(/require\((['"])((?:[^'"\\]|\\.)+)\1\)/g, (_m, _q, spec) => {
            const file = resolveSpec(spec)
            if (!existsSync(file)) {
              throw new Error(`bundle: css-tree require("${spec}") → ${file} (missing — css-tree layout changed?)`)
            }
            return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))
          })
        return { contents: rewritten, loader: 'js' }
      })
    },
  }
}

// jsdom's computed-style.js does a TOP-LEVEL readFileSync of its default
// stylesheet at a __dirname-relative path, which breaks in a single-file
// bundle (wrong depth, no node_modules). Inline the CSS into the bundle
// instead. Fails the build loudly if jsdom's layout ever changes.
function inlineJsdomDefaultStylesheet() {
  // Matches the whole top-level fs.readFileSync(...) call, so it can be
  // swapped for the CSS content as a string literal.
  const call =
    /fs\.readFileSync\(\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{\s*encoding:\s*"utf-8"\s*\}\s*\)/
  const cssPath = path.join(root, 'node_modules', 'jsdom', 'lib', 'jsdom', 'browser', 'default-stylesheet.css')
  return {
    name: 'inline-jsdom-default-stylesheet',
    setup(build) {
      build.onLoad(
        { filter: /computed-style\.js$/ },
        (args) => {
          if (!args.path.includes(`${path.sep}jsdom${path.sep}lib${path.sep}jsdom${path.sep}`)) {
            return // not jsdom's computed-style.js
          }
          const src = readFileSync(args.path, 'utf8')
          if (!call.test(src)) {
            throw new Error(`bundle: jsdom layout changed — computed-style.js no longer contains the expected readFileSync (jsdom version bump?)`)
          }
          const css = readFileSync(cssPath, 'utf8')
          return { contents: src.replace(call, JSON.stringify(css)), loader: 'js' }
        },
      )
    },
  }
}

rmSync(outDir, { recursive: true, force: true })

// jsdom's XHR impl runs a TOP-LEVEL require.resolve("./xhr-sync-worker.js"),
// which cannot be resolved from a single-file bundle and throws at import
// time. That sync XHR worker is never used by this server (mermaid.parse does
// no XHR; the worker is only spawned lazily if sync XHR happens), so patch the
// bundle-local require.resolve to fall back to the raw path string. The patch
// lives in the bundle's own module scope — it does not leak into the process.
const jsdomRequireResolveShim = `/* esbuild banner: see scripts/bundle.mjs */
;(function () {
  const orig = require.resolve;
  require.resolve = function (request, options) {
    try {
      return orig(request, options);
    } catch {
      return typeof request === 'string' ? request : String(request);
    }
  };
})();`

await esbuild.build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(outDir, 'server', 'server.cjs'),
  logLevel: 'warning',
  banner: { js: jsdomRequireResolveShim },
  plugins: [inlineJsdomDefaultStylesheet(), inlineCssTreeJsonRequires()],
})

const bytes = statSync(path.join(outDir, 'server', 'server.cjs')).size
console.log(`bundle/server/server.cjs  ${(bytes / 1024).toFixed(0)} KiB`)

const spa = path.join(root, 'dist')
if (existsSync(path.join(spa, 'index.html'))) {
  cpSync(spa, path.join(outDir, 'server', 'dist'), { recursive: true })
  console.log('bundle/server/dist/       copied from dist/')
} else {
  console.log('warning: no dist/ found — API-only bundle. Run `npm run build` first for the UI.')
}

// ── the extension itself ───────────────────────────────────────────────────
// Pi loads extensions through jiti with aliases for its core packages, so the
// bundle keeps those imports external (they are supplied by the pi runtime at
// load time) and bundles everything else (nothing here today).
await esbuild.build({
  entryPoints: [path.join(root, 'extension', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(outDir, 'index.js'),
  logLevel: 'warning',
  external: ['@earendil-works/*', 'typebox', 'typebox/*'],
})

for (const file of ['package.json', 'README.md', 'GITHUB.md', 'LICENSE']) {
  cpSync(path.join(root, 'extension', file), path.join(outDir, file))
}

// Media referenced by the GitHub-facing README (which uses relative paths). The
// npm facing README.md uses absolute raw URLs instead, and `files` excludes
// docs/, so the published tarball stays lean.
const docs = path.join(root, 'docs')
if (existsSync(docs)) {
  cpSync(docs, path.join(outDir, 'docs'), { recursive: true })
  console.log('bundle/docs/              copied from docs/')
}
console.log(
  `bundle/index.js + package.json + README.md + LICENSE (v${JSON.parse(readFileSync(path.join(root, 'extension', 'package.json'), 'utf8')).version})`,
)
