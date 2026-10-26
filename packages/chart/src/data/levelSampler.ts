import type { CacheStore } from '@local/hydromancer'

import { now } from '../time/clock'
import type { HeatmapSource } from './heatmap'
import { persistHeatmap } from './heatmapCache'
import { LevelHeatmap, sigFigStep } from './levelHeatmap'
import type { Level } from './levelHeatmap'

/** Sums quantities into price buckets, ignoring prices outside `[lo, hi]`. */
export class Buckets {
  #sums = new Map<number, number>()

  constructor(
    readonly tick: number,
    readonly lo: number,
    readonly hi: number,
  ) {}

  add(px: number, value: number): void {
    if (!(px >= this.lo && px <= this.hi)) return
    const row = Math.round(px / this.tick)
    this.#sums.set(row, (this.#sums.get(row) ?? 0) + value)
  }

  levels(): Level[] {
    return Array.from(this.#sums, ([row, sz]) => ({ px: row * this.tick, sz }))
  }
}

/**
 * Bucket size and price range for levels around `ref`. The range keeps far-off
 * outliers (e.g. a liquidation price of 1) from making the grid huge.
 */
export function priceBand(ref: number, band = 0.2, sigFigs = 4) {
  return { tick: sigFigStep(ref, sigFigs), lo: ref * (1 - band), hi: ref * (1 + band) }
}

export interface LevelState<K extends string> {
  /** Bucket size the levels are aggregated to. */
  tick: number
  levels: Record<K, Iterable<Level>>
}

export interface LevelSamplerOptions<K extends string> {
  /** One heatmap per key, e.g. per size tier. */
  sources: Record<K, HeatmapSource>
  columnMs: number
  maxColumns?: number
  sampleMs?: number
  /** Where the heatmaps are kept across reloads, one entry per key. */
  cache: CacheStore
  cacheKey: (key: K) => string
  /** Current state, or `undefined` while it isn't known yet. */
  read: () => LevelState<K> | undefined
}

/**
 * Samples a state that has no history of its own (liquidation levels, open
 * TP/SL orders) at a fixed cadence and builds a time heatmap from it. The
 * heatmaps are cached, so they reach back past the page load.
 */
export function createLevelSampler<K extends string>({ sources, columnMs, maxColumns, sampleMs = 1000, cache, cacheKey, read }: LevelSamplerOptions<K>): { destroy(): void } {
  const keys = Object.keys(sources) as K[]
  let tick: number | undefined
  let builders = new Map<K, LevelHeatmap>()
  const persistence = new Map(keys.map((k) => [k, persistHeatmap({ cache, key: cacheKey(k) })]))

  const timer = setInterval(() => {
    const state = read()
    if (!state) return
    if (state.tick !== tick) {
      // A new bucket size doesn't line up with the old rows, so start over.
      tick = state.tick
      builders = new Map(keys.map((k) => [k, new LevelHeatmap({ columnMs, tick: state.tick, maxColumns })]))
      for (const [k, builder] of builders) persistence.get(k)!.adopt(builder)
    }
    const t = now()
    for (const k of keys) {
      const builder = builders.get(k)!
      builder.add(t, state.levels[k])
      sources[k].set(builder.toGrid())
    }
  }, sampleMs)

  return {
    destroy() {
      clearInterval(timer)
      for (const p of persistence.values()) p.destroy()
    },
  }
}
