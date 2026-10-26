export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

/** Everything a layer needs to draw one frame. Coordinates are CSS pixels. */
export interface Frame {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  /** Data area. Axes sit to its right and below it. */
  plot: Rect
  /** Visible time range, ms. */
  t0: number
  t1: number
  /** Visible price range. */
  p0: number
  p1: number
  intervalMs: number
  x: (t: number) => number
  y: (price: number) => number
  timeAt: (x: number) => number
  priceAt: (y: number) => number
  pointer: Point | undefined
}

/**
 * One drawing pass over the shared canvas. Layers are drawn in stack order
 * (background → heatmaps → candles → overlay). Each runs inside save/restore.
 * `clip` confines it to the plot area. Layers with an `id` can be hidden.
 */
export interface Layer {
  id?: string
  clip?: boolean
  draw(frame: Frame): void
}

export const contains = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h

/** Centers a 1px line on a device pixel. */
export const crisp = (v: number): number => Math.round(v) + 0.5
