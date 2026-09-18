export interface Tab {
  name: string
  path: string
  content: string
  /** mtime (ms) of the last disk state we know about for this file. */
  savedMtime: number
}

export type MermaidLook = 'classic' | 'handDrawn' | 'neo'

export interface ViewState {
  /** mermaid diagram theme */
  theme: string
  look: MermaidLook
  grid: boolean
  /** editor share of the split, 0..1 */
  splitRatio: number
  /** dark UI */
  dark: boolean
}

/** Saved diagram viewport per tab (svg-pan-zoom user units). */
export interface TabPanZoom {
  /** Hash of the content this viewport was saved for (stale-location check). */
  contentHash: string
  pan: { x: number; y: number }
  zoom: number
}

export interface ServerTab {
  name: string
  path: string
  mtime: number
}

export interface ServerState {
  tabs: ServerTab[]
  lastDisplay: { name: string; at: number } | null
}

export const DEFAULT_VIEW: ViewState = {
  theme: 'default',
  look: 'classic',
  grid: true,
  splitRatio: 0.4,
  dark: false,
}
