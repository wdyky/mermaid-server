import { useCallback, useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { FileQuestion } from 'lucide-react'
import clsx from 'clsx'
import { api } from './lib/api'
import {
  deletePanZoom,
  loadActive,
  loadDirty,
  loadTabs,
  loadView,
  saveActive,
  saveDirty,
  saveTabs,
  saveView,
  setOpenTabNames,
} from './lib/storage'
import type { Tab } from './lib/types'
import { Navbar } from './components/Navbar'
import { TabBar } from './components/TabBar'
import { OpenDialog } from './components/OpenDialog'
import { EditorPane } from './components/EditorPane'
import { DiagramPane } from './components/DiagramPane'

const POLL_MS = 2000

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs())
  const [active, setActive] = useState<string | null>(() => {
    const stored = loadActive()
    const initial = loadTabs()
    if (stored && initial.some((t) => t.name === stored)) return stored
    return initial[0]?.name ?? null
  })
  const [view, setView] = useState(() => loadView())
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set(loadDirty()))
  const [dialogOpen, setDialogOpen] = useState(false)
  const [serverUp, setServerUp] = useState(true)
  const [authError, setAuthError] = useState(false)
  const [dragging, setDragging] = useState(false)

  const tabsRef = useRef(tabs)
  const activeRef = useRef(active)
  const dirtyRef = useRef(dirty)
  const lastDisplayAt = useRef(0)
  /** Names closed in this session. A /api/state snapshot taken before the
   *  DELETE landed must not resurrect them (a pi display of the same name
   *  re-opens it — see the lastDisplay branch and openFile). */
  const closedTabsRef = useRef<Set<string>>(new Set())

  // Keep refs in sync for use inside async callbacks / event handlers.
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    activeRef.current = active
  }, [active])
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // ------------------------------------------------------------ persistence
  useEffect(() => saveTabs(tabs), [tabs])
  useEffect(() => saveActive(active), [active])
  useEffect(() => saveView(view), [view])
  // Persist the dirty set: the editor content is restored from localStorage on
  // reload, so without this an unsaved edit would come back looking saved.
  useEffect(() => saveDirty(dirty), [dirty])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', view.dark)
  }, [view.dark])

  // Re-register our tabs with the server (survives server restarts).
  useEffect(() => {
    api
      .sync(tabsRef.current.map((t) => ({ name: t.name, path: t.path, mtime: t.savedMtime })))
      .catch(() => {})
  }, [])

  // ------------------------------------------------------------- polling
  useEffect(() => {
    let stopped = false
    let timer: number | undefined

    const poll = async () => {
      if (stopped) return
      try {
        const state = await api.state()
        if (stopped) return
        setServerUp(true)
        setAuthError(false)

        const prev = tabsRef.current
        const next: Tab[] = []
        let changed = false
        const seen = new Set<string>()

        // Refresh local tabs whose file changed on disk (pi reload / external
        // edit). `path` is taken from the server too: a display with an
        // existing name can re-point the tab at a different file, and keeping
        // the stale path would make Save write the new content into the old
        // file.
        for (const tab of prev) {
          seen.add(tab.name)
          const st = state.tabs.find((s) => s.name === tab.name)
          if (!st || dirtyRef.current.has(tab.name)) {
            next.push(tab)
            continue
          }
          // Refresh when the server's file is newer OR the tab was re-pointed
          // at a different path (an older file would otherwise go unnoticed).
          const pathChanged = st.path !== tab.path
          if (!pathChanged && !(st.mtime > 0 && st.mtime > tab.savedMtime)) {
            next.push(tab)
            continue
          }
          try {
            const r = await api.read(st.path)
            next.push({ ...tab, path: st.path, content: r.content, savedMtime: r.mtime })
            changed = true
          } catch {
            // file unreadable — keep the local copy
            next.push(tab)
          }
        }
        // Adopt tabs created server-side (pi display) that we don't have.
        for (const st of state.tabs) {
          if (seen.has(st.name) || closedTabsRef.current.has(st.name)) continue
          try {
            const r = await api.read(st.path)
            next.push({ name: st.name, path: st.path, content: r.content, savedMtime: r.mtime })
            changed = true
          } catch {
            // file gone — skip
          }
        }
        if (changed) setTabs(next)

        // Keep the active tab valid. On a fresh browser the tabs above are
        // adopted before any lastDisplay arrives, and a tab can vanish
        // server-side (closed elsewhere) — without this the tab bar shows a
        // tab while the pane says "No diagram open".
        const activeNow = activeRef.current
        if (next.length > 0 && (activeNow === null || !next.some((t) => t.name === activeNow))) {
          setActive(next[0].name)
        } else if (next.length === 0 && activeNow !== null) {
          setActive(null)
        }

        // A display request arrived → show that tab (and let a name closed
        // in this session come back — it is an explicit pi request).
        if (state.lastDisplay && state.lastDisplay.at !== lastDisplayAt.current) {
          lastDisplayAt.current = state.lastDisplay.at
          closedTabsRef.current.delete(state.lastDisplay.name)
          setActive(state.lastDisplay.name)
        }
      } catch (e) {
        setServerUp(false)
        setAuthError((e as { code?: string }).code === 'UNAUTHORIZED')
      }
      if (!stopped && !document.hidden) {
        timer = window.setTimeout(poll, POLL_MS)
      }
    }

    void poll()
    const onVisibility = () => {
      if (!document.hidden && !stopped) {
        window.clearTimeout(timer)
        void poll()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // --------------------------------------------------------------- actions
  const openFile = useCallback(async (name: string, path: string) => {
    closedTabsRef.current.delete(name)
    const r = await api.display(name, path)
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.name === name)
      if (i === -1) {
        return [...prev, { name, path: r.path, content: r.content, savedMtime: r.mtime }]
      }
      const next = [...prev]
      next[i] = { ...next[i], path: r.path, content: r.content, savedMtime: r.mtime }
      return next
    })
    setActive(name)
    setDirty((prev) => {
      if (!prev.has(name)) return prev
      const n = new Set(prev)
      n.delete(name)
      return n
    })
    toast.success(`Opened “${name}”`)
  }, [])

  const closeTab = useCallback((name: string) => {
    if (
      dirtyRef.current.has(name) &&
      !window.confirm(`“${name}” has unsaved changes. Close anyway?`)
    ) {
      return
    }
    const prev = tabsRef.current
    const next = prev.filter((t) => t.name !== name)
    setTabs(next)
    if (activeRef.current === name) {
      setActive(next.length > 0 ? next[next.length - 1].name : null)
    }
    setDirty((d) => {
      if (!d.has(name)) return d
      const n = new Set(d)
      n.delete(name)
      return n
    })
    deletePanZoom(name)
    closedTabsRef.current.add(name)
    api.closeTab(name).catch(() => {})
  }, [])

  const saveTab = useCallback(
    async (name: string) => {
      const tab = tabsRef.current.find((t) => t.name === name)
      if (!tab) return
      try {
        const r = await api.save(tab.path, tab.content)
        setTabs((prev) => prev.map((t) => (t.name === name ? { ...t, savedMtime: r.mtime } : t)))
        setDirty((prev) => {
          if (!prev.has(name)) return prev
          const n = new Set(prev)
          n.delete(name)
          return n
        })
        toast.success('Saved')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [],
  )

  const reloadTab = useCallback(
    async (name: string) => {
      const tab = tabsRef.current.find((t) => t.name === name)
      if (!tab) return
      if (
        dirtyRef.current.has(name) &&
        !window.confirm(`“${name}” has unsaved changes. Reload from disk?`)
      ) {
        return
      }
      try {
        const r = await api.reload(name)
        // `path` comes from the server too: a tab can be re-pointed at a
        // different file, and keeping the stale path would make Save target
        // the wrong file.
        setTabs((prev) =>
          prev.map((t) =>
            t.name === name ? { ...t, path: r.path, content: r.content, savedMtime: r.mtime } : t,
          ),
        )
        setDirty((prev) => {
          if (!prev.has(name)) return prev
          const n = new Set(prev)
          n.delete(name)
          return n
        })
        toast.success('Reloaded from disk')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [],
  )

  const changeContent = useCallback((name: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.name === name ? { ...t, content } : t)))
    setDirty((prev) => {
      if (prev.has(name)) return prev
      const n = new Set(prev)
      n.add(name)
      return n
    })
  }, [])

  // -------------------------------------------------------- split dragging
  const mainRef = useRef<HTMLDivElement>(null)
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const main = mainRef.current
    if (!main) return
    setDragging(true)
    const onMove = (ev: PointerEvent) => {
      const rect = main.getBoundingClientRect()
      const ratio = (ev.clientX - rect.left) / rect.width
      setView((v) => ({ ...v, splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }))
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activeTab = tabs.find((t) => t.name === active) ?? null

  // Keep the pan/zoom persistence filter in sync with the open tabs. Done in
  // render (not an effect) so it reflects a close immediately — an in-flight
  // svg-pan-zoom animation can otherwise re-save the just-closed tab.
  setOpenTabNames(tabs.map((t) => t.name))

  return (
    <div className="flex h-full flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Navbar
        dark={view.dark}
        onToggleDark={() => setView((v) => ({ ...v, dark: !v.dark }))}
        onOpen={() => setDialogOpen(true)}
      />
      <TabBar tabs={tabs} active={active} dirty={dirty} onSelect={setActive} onClose={closeTab} />
      {!serverUp && !authError && (
        <div className="shrink-0 bg-amber-100 px-4 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Server unreachable — is it running? (npm run dev starts it on port 8790)
        </div>
      )}
      {authError && (
        <div className="shrink-0 bg-red-100 px-4 py-1 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          Not authorized. Open this page with <code>?token=&lt;token&gt;</code> (the server
          prints it on start; the pi extension keeps it in{' '}
          <code>extdata/mermaid/server.json</code>).
        </div>
      )}
      <main
        ref={mainRef}
        className={clsx('flex min-h-0 flex-1 p-2', dragging && 'cursor-col-resize select-none')}
      >
        {activeTab ? (
          <>
            <div style={{ width: `${view.splitRatio * 100}%` }} className="min-w-0">
              <EditorPane
                tab={activeTab}
                dark={view.dark}
                onSave={() => void saveTab(activeTab.name)}
                onReload={() => void reloadTab(activeTab.name)}
                onChange={(content) => changeContent(activeTab.name, content)}
              />
            </div>
            <div
              onPointerDown={startDrag}
              className="mx-1 w-1 shrink-0 cursor-col-resize rounded bg-zinc-200 hover:bg-rose-400 dark:bg-zinc-800 dark:hover:bg-rose-500"
              title="Drag to resize"
            />
            <div className="min-w-0 flex-1">
              <DiagramPane
                tabName={activeTab.name}
                code={activeTab.content}
                theme={view.theme}
                look={view.look}
                grid={view.grid}
                onTheme={(theme) => setView((v) => ({ ...v, theme }))}
                onLook={(look) => setView((v) => ({ ...v, look }))}
                onToggleGrid={() => setView((v) => ({ ...v, grid: !v.grid }))}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-500 dark:text-zinc-400">
            <FileQuestion className="h-12 w-12" />
            <p className="text-sm">No diagram open</p>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
            >
              Open a file
            </button>
          </div>
        )}
      </main>
      {dialogOpen && (
        <OpenDialog
          existingNames={tabs.map((t) => t.name)}
          onClose={() => setDialogOpen(false)}
          onConfirm={openFile}
        />
      )}
      <Toaster theme={view.dark ? 'dark' : 'light'} position="bottom-right" />
    </div>
  )
}
