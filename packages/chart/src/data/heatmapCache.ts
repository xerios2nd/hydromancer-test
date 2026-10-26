import { cacheGet, cacheSet } from '@local/hydromancer'
import type { CacheStore } from '@local/hydromancer'

import type { LevelHeatmap, LevelHeatmapSnapshot } from './levelHeatmap'

// Bump when LevelHeatmapSnapshot changes shape.
const CACHE_VERSION = 1

export function heatmapCacheKey(coin: string, columnMs: number, id: string): string {
  return `chart:heatmap:v${CACHE_VERSION}:${coin}:${columnMs}:${id}`
}

export interface HeatmapPersistenceOptions {
  cache: CacheStore
  key: string
  /** How often the heatmap is written back, ms. */
  saveMs?: number
}

export interface HeatmapPersistence {
  /** Hands over the builder to persist. The cached columns are merged into the first one, if its tick matches. */
  adopt(builder: LevelHeatmap): void
  /** Saves one last time and stops. */
  destroy(): void
}

/**
 * Keeps a {@link LevelHeatmap} in the cache, so heatmaps of data without a
 * history endpoint survive reloads. The cached columns are loaded once and
 * merged in. After that the builder is written back periodically and when the
 * page is hidden, since unload can't be relied on to finish an async write.
 */
export function persistHeatmap({ cache, key, saveMs = 10_000 }: HeatmapPersistenceOptions): HeatmapPersistence {
  let builder: LevelHeatmap | undefined
  let cached: LevelHeatmapSnapshot | undefined
  let loaded = false

  const merge = () => {
    if (!builder || !cached) return
    // A different tick doesn't line up with the builder's rows, so the cached columns are dropped.
    builder.restore(cached)
    cached = undefined
  }

  void cacheGet<LevelHeatmapSnapshot>(cache, key).then((snapshot) => {
    loaded = true
    cached = snapshot
    merge()
  })

  const save = () => {
    // Saving before the load finished would overwrite the cached columns before they were merged.
    if (!loaded || !builder) return
    // Every column is past maxColumns by then, so the entry is useless.
    void cacheSet(cache, key, builder.snapshot(), { ttlMs: builder.maxColumns * builder.columnMs })
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') save()
  }
  const timer = setInterval(save, saveMs)
  document.addEventListener('visibilitychange', onVisibilityChange)

  return {
    adopt(b) {
      builder = b
      merge()
    },
    destroy() {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      save()
    },
  }
}
