import { JSDOM } from 'jsdom'

// mermaid (and the DOMPurify it bundles) need browser globals at import time.
// Node has no DOM, so provide a minimal one. This module MUST be imported
// (directly or transitively) before 'mermaid' anywhere in the server — ESM
// evaluates dependencies in source order, so `import './dom.js'` listed first
// in the importing module is sufficient.
const dom = new JSDOM('<!doctype html><html><body></body></html>')

const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
// Node >= 21 defines a read-only global `navigator` getter — plain assignment
// throws in strict mode, so redefine the property.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})
