export interface TabInfo {
  name: string
  path: string
  /** Last mtime (ms) the server read for this tab; 0 = unknown (e.g. after sync). */
  mtime: number
}

export interface LastDisplay {
  name: string
  at: number
}

/**
 * In-memory name -> path map. Content is never stored here — the disk is the
 * source of truth and is re-read on demand (display/reload/read).
 */
export class TabStore {
  private tabs = new Map<string, TabInfo>()
  private lastDisplay: LastDisplay | null = null

  upsert(name: string, path: string, mtime: number): TabInfo {
    const info: TabInfo = { name, path, mtime }
    this.tabs.set(name, info)
    return info
  }

  get(name: string): TabInfo | undefined {
    return this.tabs.get(name)
  }

  delete(name: string): boolean {
    if (this.lastDisplay?.name === name) this.lastDisplay = null
    return this.tabs.delete(name)
  }

  /** Re-register tabs (client startup, server restart). Keeps existing entries. */
  sync(tabs: { name: string; path: string; mtime?: number }[]): void {
    for (const t of tabs) {
      if (typeof t.name !== 'string' || typeof t.path !== 'string') continue
      if (!this.tabs.has(t.name)) {
        this.tabs.set(t.name, { name: t.name, path: t.path, mtime: t.mtime ?? 0 })
      }
    }
  }

  setLastDisplay(name: string): void {
    this.lastDisplay = { name, at: Date.now() }
  }

  state(): { tabs: TabInfo[]; lastDisplay: LastDisplay | null } {
    return { tabs: [...this.tabs.values()], lastDisplay: this.lastDisplay }
  }
}
