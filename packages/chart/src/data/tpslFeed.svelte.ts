import type { Hydromancer, TpslOrder } from '@local/hydromancer'

import type { HeatmapSource } from './heatmap'
import { heatmapCacheKey } from './heatmapCache'
import { Buckets, createLevelSampler, priceBand } from './levelSampler'

export interface TpslFeedOptions {
  coin: string
  sources: Record<TpslOrder['kind'], HeatmapSource>
  columnMs: number
  /** Center of the price range to track (e.g. last trade). */
  referencePrice: () => number | undefined
}

export interface TpslFeed {
  readonly error: string | undefined
  destroy(): void
}

/**
 * Samples Hydromancer's mirrored TP/SL orders into one heatmap for
 * take-profits and one for stop-losses. The value is the notional at each
 * trigger price.
 */
export function createTpslFeed(hm: Hydromancer, { coin, sources, columnMs, referencePrice }: TpslFeedOptions): TpslFeed {
  let error = $state<string>()

  const mirror = hm.mirrorTpsl({ coin, onError: (err) => (error = err?.message) })

  const sampler = createLevelSampler({
    // Pick our keys explicitly. The sampler drives every key it is given.
    sources: { tp: sources.tp, sl: sources.sl },
    columnMs,
    cache: hm.cache,
    cacheKey: (k) => heatmapCacheKey(coin, columnMs, k),
    read: () => {
      const ref = referencePrice()
      if (!mirror.ready || ref === undefined) return undefined
      const { tick, lo, hi } = priceBand(ref)
      const tp = new Buckets(tick, lo, hi)
      const sl = new Buckets(tick, lo, hi)
      for (const o of mirror.orders()) (o.kind === 'tp' ? tp : sl).add(o.triggerPx, o.sz * o.triggerPx)
      return { tick, levels: { tp: tp.levels(), sl: sl.levels() } }
    },
  })

  return {
    get error() {
      return error
    },
    destroy() {
      sampler.destroy()
      mirror.stop()
    },
  }
}
