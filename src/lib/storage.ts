import type { Tab, TabPanZoom, ViewState } from './types'
import { DEFAULT_VIEW } from './types'

/** All localStorage keys are prefixed with the project name. */
const PREFIX = 'mermaid-server:'

export const KEYS = {
  tabs: `${PREFIX}tabs`,
  active: `${PREFIX}active`,
  view: `${PREFIX}view`,
  lastDir: `${PREFIX}lastDir`,
  panzoom: `${PREFIX}panzoom`,
  dirty: `${PREFIX}dirty`,
} as const

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // quota exceeded / private mode — non-fatal
  }
}

export const loadTabs = (): Tab[] => loadJSON<Tab[]>(KEYS.tabs, [])
export const saveTabs = (tabs: Tab[]): void => saveJSON(KEYS.tabs, tabs)
export const loadActive = (): string | null => loadJSON<string | null>(KEYS.active, null)
export const saveActive = (name: string | null): void => saveJSON(KEYS.active, name)
export const loadView = (): ViewState => ({
  ...DEFAULT_VIEW,
  ...loadJSON<Partial<ViewState>>(KEYS.view, {}),
})
export const saveView = (view: ViewState): void => saveJSON(KEYS.view, view)
export const loadLastDir = (): string | null => loadJSON<string | null>(KEYS.lastDir, null)
export const saveLastDir = (dir: string): void => saveJSON(KEYS.lastDir, dir)
export const loadPanZoom = (): Record<string, TabPanZoom> => loadJSON(KEYS.panzoom, {})

/** Names of tabs with unsaved edits. Persisted so a reload does not make an
 *  unsaved edit look saved; the content itself lives in KEYS.tabs. */
export const loadDirty = (): string[] => loadJSON<string[]>(KEYS.dirty, [])
export const saveDirty = (names: Iterable<string>): void =>
  saveJSON(KEYS.dirty, [...names])

/**
 * Names of the tabs currently open in the UI. Pan/zoom is only persisted for
 * those: svg-pan-zoom can fire onPan/onZoom from an instance that is still
 * "current" in React terms a tick after its tab was closed (an animation in
 * flight); filtering here keeps a stale write from resurrecting a closed
 * tab's entry.
 */
let openTabNames: ReadonlySet<string> = new Set()

export const setOpenTabNames = (names: Iterable<string>): void => {
  openTabNames = new Set(names)
}

export const savePanZoom = (state: Record<string, TabPanZoom>): void => {
  const out: Record<string, TabPanZoom> = {}
  for (const name of Object.keys(state)) {
    if (openTabNames.has(name)) out[name] = state[name]
  }
  saveJSON(KEYS.panzoom, out)
}

/** Drop a tab's stored pan/zoom (tab closed). */
export const deletePanZoom = (name: string): void => {
  const state = loadPanZoom()
  if (!(name in state)) return
  delete state[name]
  savePanZoom(state)
}

/** Small non-cryptographic hash (FNV-1a) — enough to detect content changes. */
export function hashContent(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
