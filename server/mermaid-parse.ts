import './dom.js' // must run before mermaid is imported (sets up browser globals)
import mermaid from 'mermaid'

// Same config the client renders with (see DiagramPane) — a diagram that
// parses here parses there.
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })

export interface ParseResult {
  ok: boolean
  /** jison-style message: line number, caret, expected tokens. */
  error?: string
}

/**
 * Validate mermaid source. Never throws — syntax errors become
 * `{ ok: false, error }` so callers can embed the result in a 200 response.
 * `render` is deliberately NOT done server-side: jsdom lacks SVG layout APIs
 * (getBBox, …); the browser remains the final validator.
 */
export async function parseDiagram(text: string): Promise<ParseResult> {
  try {
    await mermaid.parse(text)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
