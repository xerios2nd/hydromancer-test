// Local mirror of every TP/SL trigger order in one market, following
// Hydromancer's recipe (https://docs.hydromancer.xyz/readme/builder-guides/tpsl-heatmap-streaming):
// buffer `tpslUpdates`, load a `tpslBook` snapshot, apply the buffered updates
// newer than the snapshot's block height, then apply live updates. Repeated
// after every reconnect and whenever `seq` skips.

import { isAbortError, toHydromancerError } from '../errors'
import { parseTpslUpdate } from '../parse'
import type { TpslOrder, TpslUpdate } from '../types'
import type { TpslSubscription } from '../ws/protocol'
import { retryDelay, SeqTracker } from './context'
import type { ErrorCallback, Stream, StreamContext } from './context'

export interface TpslMirrorOptions {
  coin: string
  /** After each change to the order set. */
  onChange?: () => void
  onError?: ErrorCallback
  /**
   * Minimum time between snapshots, ms. `tpslBook` allows 10 requests per 5
   * minutes, shared by everything using the key.
   */
  minSnapshotIntervalMs?: number
}

export interface TpslMirror extends Stream {
  /** False until the first snapshot has loaded. */
  readonly ready: boolean
  /** False while a resync is pending; `orders()` is then the last known state. */
  readonly synced: boolean
  /** Block height the mirror reflects. */
  readonly height: number | undefined
  readonly size: number
  /** Active orders. A live view, valid until the next update. */
  orders(): IterableIterator<TpslOrder>
}

/** Bound on updates buffered while a snapshot loads. Past it, the buffer is dropped and the sync restarts. */
const MAX_BUFFER = 50_000

export function mirrorTpsl(ctx: StreamContext, { coin, onChange, onError, minSnapshotIntervalMs = 30_000 }: TpslMirrorOptions): TpslMirror {
  const subscription: TpslSubscription = { type: 'tpslUpdates', coins: [coin] }
  const orders = new Map<number, TpslOrder>()
  const abort = new AbortController()
  const seq = new SeqTracker()
  let ready = false
  let synced = false
  let syncing = false
  let syncAgain = false
  let height: number | undefined
  let buffer: TpslUpdate[] = []
  let lastSnapshotAt = Number.NEGATIVE_INFINITY
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const apply = (update: TpslUpdate): boolean => {
    let changed = false
    for (const d of update.diffs) {
      if (d.type === 'remove') changed = orders.delete(d.oid) || changed
      else if (d.order.coin === coin) {
        orders.set(d.order.oid, d.order)
        changed = true
      }
    }
    height = Math.max(height ?? 0, update.height)
    return changed
  }

  function resync(delayMs = 0): void {
    synced = false
    if (syncing) {
      syncAgain = true
      return
    }
    clearTimeout(timer)
    const wait = Math.max(delayMs, lastSnapshotAt + minSnapshotIntervalMs - Date.now())
    if (wait > 0) timer = setTimeout(() => void loadSnapshot(), wait)
    else void loadSnapshot()
  }

  async function loadSnapshot(): Promise<void> {
    syncing = true
    syncAgain = false
    // Updates from here on are buffered and replayed over the snapshot.
    buffer = []
    lastSnapshotAt = Date.now()
    let retryIn = 0
    try {
      const book = await ctx.info.tpslBook([coin], { signal: abort.signal })
      orders.clear()
      for (const o of book.orders) if (o.coin === coin) orders.set(o.oid, o)
      height = book.height
      for (const u of buffer) if (u.height > book.height) apply(u)
      buffer = []
      synced = ready = true
      failures = 0
      onError?.(undefined)
      onChange?.()
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) return
      const error = toHydromancerError(err)
      onError?.(error)
      syncAgain = true
      retryIn = retryDelay(error, failures++, minSnapshotIntervalMs, 5 * 60_000)
    } finally {
      syncing = false
    }
    if (syncAgain && !abort.signal.aborted) resync(retryIn)
  }

  const unsubscribe = ctx.ws.subscribe(subscription, {
    onActive: () => {
      seq.reset()
      resync()
    },
    onData: (frame) => {
      const update = parseTpslUpdate(frame.data)
      if (!update) return
      if (seq.gap(frame.seq)) resync()
      if (synced) {
        if (apply(update)) onChange?.()
        return
      }
      buffer.push(update)
      if (buffer.length > MAX_BUFFER) {
        buffer = []
        resync()
      }
    },
    onError: (err) => onError?.(err),
  })

  return {
    get ready() {
      return ready
    },
    get synced() {
      return synced
    },
    get height() {
      return height
    },
    get size() {
      return orders.size
    },
    orders: () => orders.values(),
    stop() {
      abort.abort()
      clearTimeout(timer)
      unsubscribe()
    },
  }
}
