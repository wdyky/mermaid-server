#!/usr/bin/env node
/**
 * Install the built package next to the pi extension, replacing what's there.
 *
 *   npm run ship                 → ~/.pi/agent/extensions/mermaid
 *   npm run ship -- <target-dir> → explicit target
 *
 * The target receives exactly the bundle/ contents (the pi package: index.js,
 * package.json, README.md, LICENSE, server/server.cjs, server/dist/) so the
 * deployed dir is byte-identical to what `npm publish` would ship. A running
 * server started from that dir is not stopped — the extension restarts it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundle = path.join(root, 'bundle')

if (!existsSync(path.join(bundle, 'index.js')) || !existsSync(path.join(bundle, 'server', 'server.cjs'))) {
  console.error('ship: bundle/index.js or bundle/server/server.cjs not found — run `npm run bundle` first')
  process.exit(1)
}

const target =
  process.argv[2] ?? path.join(os.homedir(), '.pi', 'agent', 'extensions', 'mermaid')

mkdirSync(target, { recursive: true })

// Exactly mirror bundle/ into the target: every top-level entry from the
// bundle (overwritten) plus stale top-level entries the bundle no longer has
// (e.g. an older single-file layout, or the pre-bundle mermaid.ts source).
// Nothing outside the target's top level is touched.
const wanted = new Set(readdirSync(bundle))
for (const entry of readdirSync(target)) {
  if (wanted.has(entry)) continue
  if (entry === 'node_modules' || entry.startsWith('.')) continue
  rmSync(path.join(target, entry), { recursive: true, force: true })
  console.log(`ship: removed stale ${entry}`)
}
for (const entry of wanted) {
  rmSync(path.join(target, entry), { recursive: true, force: true })
}
cpSync(bundle, target, { recursive: true })
console.log(`shipped bundle/ → ${target}`)
