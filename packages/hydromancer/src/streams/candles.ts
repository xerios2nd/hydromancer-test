// Live candles that lose nothing when the connection drops: every time the
// subscription becomes active (first time and after each reconnect), and
// whenever `seq` skips, the gap is backfilled over REST.

import { isAbortError, toHydromancerError } from '../errors'
import { addIntervals } from '../intervals'
import type { Interval } from '../intervals'
import { parseCandle } from '../parse'
import type { Candle } from '../types'
import type { CandleSubscription } from '../ws/protocol'
import { retryDelay, SeqTracker } from './context'
import type { ErrorCallback, Stream, StreamContext } from './context'

export type CandleSource = 'history' | 'live'

export interface CandleStreamOptions {
  coin: string
  interval: Interval
  /** Candles to load on start, and the furthest back a reconnect backfill reaches. */
  history?: number
  /**
   * Live and backfilled candles, possibly out of order and repeated. Merge so
   * that for one open time a finalized candle, or else the one with more
   * trades, wins (an open candle only grows).
   */
  onCandles(candles: Candle[], source: CandleSource): void
  onError?: ErrorCallback
}

export interface CandleStream extends Stream {
  /** Open time of the newest candle delivered so far. */
  readonly newest: number | undefined
}

export function streamCandles(ctx: StreamContext, { coin, interval, history = 500, onCandles, onError }: CandleStreamOptions): CandleStream {
  const subscription: CandleSubscription = { type: 'candle', coin, interval }
  const abort = new AbortController()
  const seq = new SeqTracker()
  let newest: number | undefined
  let syncing = false
  let syncAgain = false
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const deliver = (candles: Candle[], source: CandleSource) => {
    if (candles.length === 0) return
    for (const c of candles) if (newest === undefined || c.t > newest) newest = c.t
    onCandles(candles, source)
  }

  /** Single-flight; calls during a run coalesce into one more pass. */
  async function backfill(): Promise<void> {
    clearTimeout(retryTimer)
    if (syncing) {
      syncAgain = true
      return
    }
    syncing = true
    syncAgain = false
    try {
      const now = ctx.now()
      const end = addIntervals(interval, now, 1)
      const oldest = addIntervals(interval, now, -history)
      // Re-fetch from the newest candle we have (it may have been open), but
      // never further back than `history`. Older gaps stay gaps.
      const start = Math.max(newest ?? oldest, oldest)
      deliver(await ctx.history.load({ coin, interval, startTime: start, endTime: end }, { signal: abort.signal }), 'history')
      failures = 0
      onError?.(undefined)
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) return
      const error = toHydromancerError(err)
      onError?.(error)
      retryTimer = setTimeout(() => void backfill(), retryDelay(error, failures++))
    } finally {
      syncing = false
    }
    if (syncAgain && !abort.signal.aborted) await backfill()
  }

  const unsubscribe = ctx.ws.subscribe(subscription, {
    onActive: () => {
      // `seq` restarts with every subscription.
      seq.reset()
      void backfill()
    },
    onData: (frame) => {
      const parsed = parseCandle(frame.data)
      if (!parsed || parsed.coin !== coin || parsed.interval !== interval) return
      if (seq.gap(frame.seq)) void backfill()
      deliver([parsed.candle], 'live')
    },
    onError: (err) => onError?.(err),
  })
  // History doesn't wait for the WebSocket: it paints sooner, and still loads
  // if the subscription is rejected (e.g. plan limits).
  void backfill()

  return {
    get newest() {
      return newest
    },
    stop() {
      abort.abort()
      clearTimeout(retryTimer)
      unsubscribe()
    },
  }
}
