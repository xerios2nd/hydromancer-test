import type { Hydromancer, Interval } from '@local/hydromancer'

import type { CandleSeries } from './candles'

export interface CandleFeedOptions {
  coin: string
  interval: Interval
  series: CandleSeries
  /** Candles to load when the series is empty or too stale to patch. */
  history?: number
}

export interface CandleFeed {
  /** Last backfill error, if any. */
  readonly error: string | undefined
  destroy(): void
}

/**
 * Keeps `series` in sync with Hydromancer's candle stream. The stream does the
 * reconnect backfill. The series does the order-independent merge.
 */
export function createCandleFeed(hm: Hydromancer, { coin, interval, series, history }: CandleFeedOptions): CandleFeed {
  let error = $state<string>()

  const stream = hm.streamCandles({
    coin,
    interval,
    history,
    onCandles: (candles) => series.merge(candles),
    onError: (err) => (error = err?.message),
  })

  return {
    get error() {
      return error
    },
    destroy: () => stream.stop(),
  }
}
