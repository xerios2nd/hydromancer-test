import { ChangeEmitter } from './emitter'

export interface Candle {
  /** Open time, ms since epoch. */
  t: number
  /** Close time, ms since epoch. */
  T: number
  o: number
  h: number
  l: number
  c: number
  /** Volume in the base asset. */
  v: number
  /** Number of trades. */
  n: number
  /** True once the candle is finalized. */
  x: boolean
}

/**
 * Whether `next` should replace `prev` (same open time). Updates arrive out of
 * order (a REST backfill can land after a newer WebSocket update), so this must
 * not depend on arrival order: a finalized candle beats an open one, and an
 * open candle only ever grows, so its trade count is monotonic.
 */
export function supersedes(prev: Candle, next: Candle): boolean {
  if (prev.x !== next.x) return next.x
  return next.n >= prev.n
}

/** Candles sorted by open time, unique per open time, capped at `maxLength`. */
export class CandleSeries extends ChangeEmitter {
  #items: Candle[] = []

  constructor(readonly maxLength = 5000) {
    super()
  }

  get items(): readonly Candle[] {
    return this.#items
  }

  get last(): Candle | undefined {
    return this.#items.at(-1)
  }

  /** Index of the first candle with open time >= `t`. */
  lowerBound(t: number): number {
    const items = this.#items
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (items[mid]!.t < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Merges candles in any order, duplicates allowed. Notifies listeners once
   * if anything changed. Returns whether anything changed.
   */
  merge(candles: Iterable<Candle>): boolean {
    let changed = false
    for (const candle of candles) changed = this.#upsert(candle) || changed
    if (!changed) return false
    const excess = this.#items.length - this.maxLength
    if (excess > 0) this.#items.splice(0, excess)
    this.emitChange()
    return true
  }

  #upsert(candle: Candle): boolean {
    const items = this.#items
    const last = items.at(-1)
    // Fast path: live updates append or touch the last candle.
    if (!last || candle.t > last.t) {
      items.push(candle)
      return true
    }
    const i = candle.t === last.t ? items.length - 1 : this.lowerBound(candle.t)
    const prev = items[i]
    if (prev?.t === candle.t) {
      if (!supersedes(prev, candle)) return false
      items[i] = candle
      return true
    }
    items.splice(i, 0, candle)
    return true
  }
}
