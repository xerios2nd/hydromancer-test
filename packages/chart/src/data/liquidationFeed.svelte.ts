import type { Hydromancer, PerpPositions } from '@local/hydromancer'

import type { HeatmapSource } from './heatmap'
import { heatmapCacheKey } from './heatmapCache'
import { Buckets, createLevelSampler, priceBand } from './levelSampler'

/** Position size tiers, by notional. Each gets its own heatmap. */
export const LIQUIDATION_TIERS = [
  { id: 'small', label: '< $100k', min: 0 },
  { id: 'medium', label: '$100k – 1M', min: 100_000 },
  { id: 'large', label: '≥ $1M', min: 1_000_000 },
] as const

export type LiquidationTier = (typeof LIQUIDATION_TIERS)[number]['id']

export interface LiquidationFeedOptions {
  coin: string
  sources: Record<LiquidationTier, HeatmapSource>
  columnMs: number
  /** Center of the price range to track (e.g. last trade). */
  referencePrice: () => number | undefined
  pollMs?: number
}

export interface LiquidationFeed {
  readonly error: string | undefined
  destroy(): void
}

const tierOf = (notional: number): LiquidationTier => {
  for (let i = LIQUIDATION_TIERS.length - 1; i > 0; i--) {
    if (notional >= LIQUIDATION_TIERS[i]!.min) return LIQUIDATION_TIERS[i]!.id
  }
  return LIQUIDATION_TIERS[0].id
}

/**
 * Liquidation map from Hydromancer's position snapshots. Each position's
 * notional is summed at its liquidation price, with one heatmap per size tier.
 */
export function createLiquidationFeed(hm: Hydromancer, { coin, sources, columnMs, referencePrice, pollMs }: LiquidationFeedOptions): LiquidationFeed {
  let error = $state<string>()
  let positions: PerpPositions | undefined

  const polling = hm.pollPerpPositions({
    coin,
    pollMs,
    onSnapshot: (p) => (positions = p),
    onError: (err) => (error = err?.message),
  })

  const sampler = createLevelSampler({
    // Pick our keys explicitly. The sampler drives every key it is given.
    sources: { small: sources.small, medium: sources.medium, large: sources.large },
    columnMs,
    cache: hm.cache,
    cacheKey: (k) => heatmapCacheKey(coin, columnMs, k),
    read: () => {
      const ref = referencePrice()
      if (!positions || ref === undefined) return undefined
      const { tick, lo, hi } = priceBand(ref)
      const tiers = {
        small: new Buckets(tick, lo, hi),
        medium: new Buckets(tick, lo, hi),
        large: new Buckets(tick, lo, hi),
      } satisfies Record<LiquidationTier, Buckets>
      const { liquidationPx, notional } = positions
      for (let i = 0; i < liquidationPx.length; i++) {
        // Notional is signed (negative for shorts).
        const size = Math.abs(notional[i]!)
        tiers[tierOf(size)].add(liquidationPx[i]!, size)
      }
      return {
        tick,
        levels: {
          small: tiers.small.levels(),
          medium: tiers.medium.levels(),
          large: tiers.large.levels(),
        },
      }
    },
  })

  return {
    get error() {
      return error
    },
    destroy() {
      sampler.destroy()
      polling.stop()
    },
  }
}
