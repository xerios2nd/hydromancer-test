import type { HydromancerClient, L2BookStreamOptions } from '@local/hydromancer'

import type { HeatmapSource } from './heatmap'
import { heatmapCacheKey, persistHeatmap } from './heatmapCache'
import { LevelHeatmap, sigFigStep } from './levelHeatmap'

export interface BookFeedOptions {
  coin: string
  heatmap: HeatmapSource
  /** Width of one heatmap time column, ms. */
  columnMs: number
  /** Book aggregation, which is also the heatmap's price resolution. */
  nSigFigs?: L2BookStreamOptions['nSigFigs']
  nLevels?: L2BookStreamOptions['nLevels']
  maxColumns?: number
  /** Minimum time between heatmap updates, ms. */
  publishMs?: number
}

export interface BookFeed {
  destroy(): void
}

/**
 * Feeds `l2Book` snapshots into a {@link LevelHeatmap} and publishes it to
 * `heatmap`. The order book has no history endpoint, so the heatmap is kept
 * in `hm.cache` to survive reloads. Columns stay empty while disconnected.
 */
export function createBookFeed(
  hm: HydromancerClient,
  { coin, heatmap, columnMs, nSigFigs = 5, nLevels = 50, maxColumns, publishMs = 250 }: BookFeedOptions,
): BookFeed {
  let builder: LevelHeatmap | undefined
  let publishTimer: ReturnType<typeof setTimeout> | undefined
  const persistence = persistHeatmap({ cache: hm.cache, key: heatmapCacheKey(coin, columnMs, 'book') })

  const publish = () => {
    publishTimer = undefined
    heatmap.set(builder?.toGrid())
  }

  const stream = hm.streamL2Book({
    coin,
    nSigFigs,
    nLevels,
    onBook: (book) => {
      const ref = book.bids[0]?.px ?? book.asks[0]?.px
      if (ref === undefined) return
      const tick = sigFigStep(ref, nSigFigs)
      // The aggregation step changes when the price crosses a power of ten,
      // so the rows no longer line up. Start a new heatmap.
      if (builder?.tick !== tick) {
        builder = new LevelHeatmap({ columnMs, tick, maxColumns })
        persistence.adopt(builder)
      }
      builder.add(book.time, [...book.bids, ...book.asks])
      // Books arrive every block (~70ms). Re-rasterising a few times a second is plenty.
      publishTimer ??= setTimeout(publish, publishMs)
    },
  })

  return {
    destroy() {
      clearTimeout(publishTimer)
      stream.stop()
      persistence.destroy()
    },
  }
}
