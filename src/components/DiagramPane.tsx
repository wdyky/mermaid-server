import { useCallback, useEffect, useRef, useState } from 'react'
import mermaid, { type MermaidConfig } from 'mermaid'
import Hammer from 'hammerjs'
import panzoom, { type PanZoomInstance } from 'svg-pan-zoom'
import { AlertTriangle, Grid3x3, Maximize, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import clsx from 'clsx'
import { deletePanZoom, hashContent, loadPanZoom, savePanZoom } from '../lib/storage'
import type { MermaidLook } from '../lib/types'

mermaid.initialize({
  securityLevel: 'strict',
  startOnLoad: false,
})

const THEMES = ['default', 'dark', 'forest', 'neutral'] as const

interface Props {
  tabName: string
  code: string
  theme: string
  look: MermaidLook
  grid: boolean
  onTheme: (theme: string) => void
  onLook: (look: MermaidLook) => void
  onToggleGrid: () => void
}

export function DiagramPane({ tabName, code, theme, look, grid, onTheme, onLook, onToggleGrid }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const pzoomRef = useRef<PanZoomInstance | null>(null)
  const hammerRef = useRef<InstanceType<typeof Hammer> | null>(null)
  const idCounter = useRef(0)
  /** Suppress persistence while we programmatically reset the view. */
  const suppressSaveRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  /** Mermaid error messages can embed the whole input ("No diagram type
   *  detected … for text: <file>"); never dump a whole file into the overlay. */
  const truncate = (msg: string): string =>
    msg.length > 500 ? `${msg.slice(0, 500)}… (truncated)` : msg

  const disposePanZoom = useCallback(() => {
    hammerRef.current?.destroy()
    hammerRef.current = null
    pzoomRef.current?.destroy()
    pzoomRef.current = null
  }, [])

  // ------------------------------------------------- pan/zoom persistence
  // onPan/onZoom callbacks stay attached to the instance they were created
  // for (svg-pan-zoom can fire them after destroy, e.g. a zoom animation in
  // flight when the tab unmounts). Writing from a stale instance would
  // re-save a tab that was just closed, or save the new instance's view
  // under the old tab's name — so persist only when the instance is still
  // the current one.
  const saveCurrentView = useCallback(
    (pz: PanZoomInstance) => {
      if (pz !== pzoomRef.current || suppressSaveRef.current) return
      const state = loadPanZoom()
      state[tabName] = {
        contentHash: hashContent(code),
        pan: pz.getPan(),
        zoom: pz.getZoom(),
      }
      savePanZoom(state)
    },
    [tabName, code],
  )

  const applySavedView = useCallback(() => {
    const pz = pzoomRef.current
    if (!pz) return
    const saved = loadPanZoom()[tabName]
    if (!saved) {
      // Default: settle slightly zoomed out so large diagrams don't touch the toolbar.
      pz.zoom(0.9)
      return
    }
    // Absolute zoom happens around the SVG center, so the diagram stays centered.
    pz.zoom(saved.zoom, true)
    if (saved.contentHash === hashContent(code)) {
      // Same diagram as when saved → restore the exact location.
      // Code changed → location stays managed (centered).
      pz.pan(saved.pan)
    }
  }, [tabName, code])

  const resetView = useCallback(() => {
    const pz = pzoomRef.current
    if (!pz) return
    // onPan/onZoom fire synchronously inside setCTM — suppress the re-save.
    suppressSaveRef.current = true
    pz.reset()
    pz.zoom(0.9)
    suppressSaveRef.current = false
    deletePanZoom(tabName)
  }, [tabName])

  const setupPanZoom = useCallback(() => {
    const svg = hostRef.current?.querySelector('svg')
    if (!svg) return
    disposePanZoom()
    // The onPan/onZoom callbacks close over THIS instance so a stale, already
    // disposed instance can never persist (see saveCurrentView).
    const instance = panzoom(svg, {
      center: true,
      fit: true,
      zoomEnabled: true,
      panEnabled: true,
      controlIconsEnabled: false,
      maxZoom: 20,
      minZoom: 0.1,
      onPan: () => saveCurrentView(instance),
      onZoom: () => saveCurrentView(instance),
      customEventsHandler: {
        haltEventListeners: ['touchstart', 'touchend', 'touchmove', 'touchleave', 'touchcancel'],
        init: (options) => {
          let initialScale = 1
          let pannedX = 0
          let pannedY = 0
          const hammer = new Hammer(options.svgElement)
          hammerRef.current = hammer
          const resetPanned = () => {
            pannedX = 0
            pannedY = 0
          }
          const handlePan = (event: {
            type: string
            deltaX: number
            deltaY: number
            scale: number
            center: { x: number; y: number }
          }) => {
            options.instance.panBy({ x: event.deltaX - pannedX, y: event.deltaY - pannedY })
            pannedX = event.deltaX
            pannedY = event.deltaY
          }
          hammer.get('pinch').set({ enable: true })
          hammer.on('panstart panmove', (event) => {
            if (event.type === 'panstart') resetPanned()
            handlePan(event)
          })
          hammer.on('pinchstart pinchmove', (event) => {
            if (event.type === 'pinchstart') {
              initialScale = options.instance.getZoom()
              resetPanned()
            }
            options.instance.zoomAtPoint(initialScale * event.scale, {
              x: event.center.x,
              y: event.center.y,
            })
            handlePan(event)
          })
          options.svgElement.addEventListener('touchmove', (event) => event.preventDefault())
        },
        destroy: () => {
          hammerRef.current?.destroy()
          hammerRef.current = null
        },
      },
    })
    pzoomRef.current = instance
    instance.disableDblClickZoom()
    applySavedView()
  }, [disposePanZoom, saveCurrentView, applySavedView])

  // Re-render the diagram when code/theme/look change.
  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    const id = `mermaid-diagram-${++idCounter.current}`
    mermaid.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: theme as MermaidConfig['theme'],
      look,
    })
    // Render into the host element (3rd arg) instead of document.body: on a
    // parse error mermaid throws *before* it removes its temp div, so rendering
    // body-side leaks one DIV#d{id} per failed render. Inside the host, our
    // error-path replaceChildren() cleans it up.
    mermaid
      .render(id, code, host)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !hostRef.current) return
        hostRef.current.innerHTML = svg
        // Mermaid emits <svg width="100%" style="max-width: Wpx" viewBox="…">
        // without a height. .diagram-host svg (index.css) stretches it to fill
        // the pane; the inline max-width must be neutralized here because it
        // beats the stylesheet.
        const svgEl = hostRef.current.querySelector('svg')
        if (svgEl) svgEl.style.maxWidth = '100%'
        bindFunctions?.(hostRef.current)
        setError(null)
        setupPanZoom()
      })
      .catch((e: unknown) => {
        if (cancelled) return
        hostRef.current?.replaceChildren()
        disposePanZoom()
        setError(truncate(e instanceof Error ? e.message : String(e)))
      })
    return () => {
      cancelled = true
      disposePanZoom()
    }
  }, [code, theme, look, setupPanZoom, disposePanZoom])

  // Keep the user's pan/zoom when the container is resized; only
  // re-baseline the fit state for the new size (no view change).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => {
      pzoomRef.current?.resize()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const zoomButton =
    'rounded-md p-1.5 text-zinc-600 hover:bg-white/80 dark:text-zinc-300 dark:hover:bg-zinc-800/80'

  return (
    <div
      className={clsx(
        'relative h-full min-h-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800',
        grid
          ? 'bg-white [background-image:radial-gradient(circle,#d4d4d8_1px,transparent_1px)] [background-size:20px_20px] dark:bg-zinc-950 dark:[background-image:radial-gradient(circle,#3f3f46_1px,transparent_1px)]'
          : 'bg-white dark:bg-zinc-950',
      )}
    >
      <div ref={hostRef} className="diagram-host size-full" />

      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex max-w-md items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Syntax error</p>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{error}</pre>
            </div>
          </div>
        </div>
      )}

      {/* pan/zoom toolbar (top-right, like the live editor) */}
      <div className="absolute top-2 right-2 flex flex-col gap-px overflow-hidden rounded-md border border-zinc-200 bg-zinc-100/90 dark:border-zinc-700 dark:bg-zinc-900/90">
        <button type="button" className={zoomButton} title="Zoom in" onClick={() => pzoomRef.current?.zoomIn()}>
          <ZoomIn className="h-4 w-4" />
        </button>
        <button type="button" className={zoomButton} title="Zoom out" onClick={() => pzoomRef.current?.zoomOut()}>
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={zoomButton}
          title="Fit to view"
          onClick={() => {
            pzoomRef.current?.reset()
            pzoomRef.current?.zoom(0.9)
          }}
        >
          <Maximize className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={zoomButton}
          title="Reset view (clears saved position)"
          onClick={resetView}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      {/* diagram settings (bottom-left) */}
      <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-100/90 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900/90">
        <select
          value={theme}
          onChange={(e) => onTheme(e.target.value)}
          className="rounded bg-transparent text-zinc-700 outline-none dark:text-zinc-200"
          title="Diagram theme"
        >
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={look}
          onChange={(e) => onLook(e.target.value as MermaidLook)}
          className="rounded bg-transparent text-zinc-700 outline-none dark:text-zinc-200"
          title="Diagram look"
        >
          <option value="classic">classic</option>
          <option value="handDrawn">hand-drawn</option>
          <option value="neo">neo</option>
        </select>
        <button
          type="button"
          onClick={onToggleGrid}
          title="Toggle grid"
          className={clsx(
            'rounded p-1',
            grid
              ? 'text-rose-600 dark:text-rose-400'
              : 'text-zinc-400 dark:text-zinc-500',
          )}
        >
          <Grid3x3 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
