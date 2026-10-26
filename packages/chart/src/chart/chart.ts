import { fit } from '@thi.ng/math'
import { mapcat, minMax, transduce } from '@thi.ng/transducers'

import type { CandleSeries } from '../data/candles'
import type { HeatmapSource } from '../data/heatmap'
import { now } from '../time/clock'
import type { Frame, Layer, Point, Rect } from './frame'
import type { Palette } from './theme'
import { candleLayer } from './layers/candles'
import { gridLayer } from './layers/grid'
import { heatmapLayer } from './layers/heatmap'
import { overlayLayer } from './layers/overlay'
import { createRenderScheduler } from './scheduler'
import { Viewport } from './viewport'

const AXIS_RIGHT = 72
const AXIS_BOTTOM = 24
const RIGHT_PAD_BARS = 5
const PRICE_PAD = 0.08

export interface HeatmapSpec {
  id: string
  source: HeatmapSource
  palette: Palette
}

export interface ChartOptions {
  series: CandleSeries
  /** Drawn in order, so later ones sit on top. */
  heatmaps: readonly HeatmapSpec[]
  intervalMs: number
  hidden?: Iterable<string>
}

export interface ChartHandle {
  /** Hides the layers with these ids and shows all others. */
  setHidden(ids: Iterable<string>): void
  destroy(): void
}

/**
 * Binds a canvas to data sources. Rendering happens only when a source
 * changes, the canvas resizes, or the user interacts.
 */
export function createChart(canvas: HTMLCanvasElement, { series, heatmaps, intervalMs, hidden: initiallyHidden = [] }: ChartOptions): ChartHandle {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  const layers: Layer[] = [gridLayer, ...heatmaps.map((h) => heatmapLayer(h.id, h.source, h.palette)), candleLayer(series), overlayLayer(series)]
  let hidden = new Set(initiallyHidden)
  const viewport = new Viewport(intervalMs)
  let width = 0
  let height = 0
  let dpr = 1
  let pointer: Point | undefined
  let dragX: number | undefined
  /** Last rendered frame, used to map input back to data space. */
  let frame: Frame | undefined

  const scheduler = createRenderScheduler(render)

  /** Right edge in follow mode: just past the newest candle or the current time. */
  function liveEnd(): number {
    const last = series.last
    return Math.max(now(), last ? last.t + intervalMs : 0) + RIGHT_PAD_BARS * intervalMs
  }

  function priceRange(t0: number, t1: number): [number, number] {
    const visible = series.items.slice(series.lowerBound(t0 - intervalMs), series.lowerBound(t1))
    const [lo, hi] = transduce(
      mapcat((c) => [c.l, c.h]),
      minMax(),
      visible,
    )
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
    const pad = (hi - lo) * PRICE_PAD || Math.abs(hi) * 0.001 || 1
    return [lo - pad, hi + pad]
  }

  function buildFrame(): Frame {
    const plot: Rect = {
      x: 0,
      y: 0,
      w: Math.max(1, width - AXIS_RIGHT),
      h: Math.max(1, height - AXIS_BOTTOM),
    }
    const [t0, t1] = viewport.range(liveEnd())
    const [p0, p1] = priceRange(t0, t1)
    const left = plot.x
    const right = plot.x + plot.w
    const top = plot.y
    const bottom = plot.y + plot.h
    return {
      ctx: ctx!,
      width,
      height,
      plot,
      t0,
      t1,
      p0,
      p1,
      intervalMs,
      x: (t) => fit(t, t0, t1, left, right),
      y: (p) => fit(p, p0, p1, bottom, top),
      timeAt: (x) => fit(x, left, right, t0, t1),
      priceAt: (y) => fit(y, bottom, top, p0, p1),
      pointer,
    }
  }

  function render(): void {
    if (width === 0 || height === 0) return
    const f = buildFrame()
    frame = f
    const { plot } = f
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (const layer of layers) {
      if (layer.id !== undefined && hidden.has(layer.id)) continue
      ctx!.save()
      if (layer.clip) {
        ctx!.beginPath()
        ctx!.rect(plot.x, plot.y, plot.w, plot.h)
        ctx!.clip()
      }
      layer.draw(f)
      ctx!.restore()
    }
  }

  const resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return
    dpr = window.devicePixelRatio || 1
    width = entry.contentRect.width
    height = entry.contentRect.height
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    // Resizing clears the canvas. Draw before the browser paints the blank frame.
    scheduler.invalidate()
    scheduler.flush()
  })
  resizeObserver.observe(canvas)

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    dragX = e.offsetX
    canvas.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    pointer = { x: e.offsetX, y: e.offsetY }
    if (dragX !== undefined && frame) {
      const msPerPx = (frame.t1 - frame.t0) / frame.plot.w
      viewport.pan((dragX - e.offsetX) * msPerPx, liveEnd())
      dragX = e.offsetX
    }
    scheduler.invalidate()
  }
  const onPointerUp = () => {
    dragX = undefined
  }
  const onPointerLeave = () => {
    pointer = undefined
    scheduler.invalidate()
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (!frame) return
    viewport.zoom(Math.exp(e.deltaY * 0.002), frame.timeAt(e.offsetX), liveEnd())
    scheduler.invalidate()
  }
  const onDoubleClick = () => {
    viewport.reset()
    scheduler.invalidate()
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDoubleClick)

  const unsubscribe = [series.onChange(scheduler.invalidate), ...heatmaps.map((h) => h.source.onChange(scheduler.invalidate))]

  return {
    setHidden(ids) {
      hidden = new Set(ids)
      scheduler.invalidate()
    },
    destroy() {
      for (const fn of unsubscribe) fn()
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDoubleClick)
      scheduler.stop()
    },
  }
}
