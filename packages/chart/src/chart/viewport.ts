import { clamp } from '@thi.ng/math'

const DEFAULT_BARS = 150
const MIN_BARS = 10
const MAX_BARS = 2000

/**
 * Visible time window. While `follow` is set, the right edge tracks the live
 * edge supplied by the caller. Panning away detaches it, and panning back
 * re-attaches it.
 */
export class Viewport {
  span: number
  follow = true
  #end = 0

  constructor(readonly intervalMs: number) {
    this.span = DEFAULT_BARS * intervalMs
  }

  range(liveEnd: number): [number, number] {
    const t1 = this.follow ? liveEnd : this.#end
    return [t1 - this.span, t1]
  }

  pan(dt: number, liveEnd: number): void {
    const end = this.range(liveEnd)[1] + dt
    this.follow = end >= liveEnd
    this.#end = Math.min(end, liveEnd)
  }

  /** Scales the span by `factor`, keeping `anchor` fixed on screen. Following views zoom from the right edge. */
  zoom(factor: number, anchor: number, liveEnd: number): void {
    const span = clamp(this.span * factor, MIN_BARS * this.intervalMs, MAX_BARS * this.intervalMs)
    if (!this.follow) {
      const t1 = this.#end
      this.#end = Math.min(anchor + (t1 - anchor) * (span / this.span), liveEnd)
      this.follow = this.#end >= liveEnd
    }
    this.span = span
  }

  reset(): void {
    this.follow = true
    this.span = DEFAULT_BARS * this.intervalMs
  }
}
