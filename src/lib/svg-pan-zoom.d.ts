/**
 * Minimal types for svg-pan-zoom (no @types package is used).
 * Only the surface this app relies on.
 */
declare module 'svg-pan-zoom' {
  export interface PanZoomPoint {
    x: number
    y: number
  }

  export interface PanZoomInstance {
    zoomIn(): void
    zoomOut(): void
    reset(): void
    /** absolute=true treats zoom as an absolute scale, not a multiplier. */
    zoom(zoom: number, absolute?: boolean): void
    pan(point: PanZoomPoint): void
    getPan(): PanZoomPoint
    getZoom(): number
    resize(): void
    destroy(): void
    disableDblClickZoom(): void
  }

  export interface PanZoomOptions {
    center?: boolean
    fit?: boolean
    zoomEnabled?: boolean
    panEnabled?: boolean
    controlIconsEnabled?: boolean
    maxZoom?: number
    minZoom?: number
    onPan?: (pan: PanZoomPoint) => void
    onZoom?: (zoom: number) => void
    customEventsHandler?: {
      haltEventListeners?: string[]
      init?: (options: {
        svgElement: SVGSVGElement
        instance: PanZoomInstance
      }) => void
      destroy?: () => void
    }
    [key: string]: unknown
  }

  export default function panzoom(
    svg: SVGSVGElement,
    options?: PanZoomOptions,
  ): PanZoomInstance
}
