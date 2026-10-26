// Page side of a `Hydromancer` running in a Web Worker. The worker holds the
// WebSocket, does the REST calls and the decoding; this mirrors the stream API
// on the page with the callbacks kept here.

import { defaultCache } from '../hydromancer'
import type { Hydromancer, HydromancerOptions } from '../hydromancer'
import type { CacheStore } from '../cache/store'
import type { CandleStream, CandleStreamOptions } from '../streams/candles'
import type { Stream } from '../streams/context'
import type { L2BookStreamOptions } from '../streams/l2Book'
import type { PerpPositionsPollOptions } from '../streams/perpPositions'
import type { TpslMirror, TpslMirrorOptions } from '../streams/tpsl'
import type { TpslOrder } from '../types'
import type { ConnectionStatus } from '../ws/connection'
import { deserializeError } from './protocol'
import type { FromWorker, MessagePortLike, StreamEvent, StreamRequest, ToWorker, WorkerHydromancerOptions } from './protocol'

/** The part of {@link Hydromancer} that works the same in-process or through a worker. */
export type HydromancerClient = Pick<
  Hydromancer,
  'status' | 'cache' | 'connect' | 'close' | 'streamCandles' | 'streamL2Book' | 'mirrorTpsl' | 'pollPerpPositions'
>

export interface HydromancerWorkerOptions extends Omit<WorkerHydromancerOptions, 'cache'>, Pick<HydromancerOptions, 'onStatus' | 'onError'> {
  /** A worker running {@link serveHydromancer}. */
  worker: MessagePortLike
  /** Page-side cache, e.g. for data derived from the streams. Defaults to {@link defaultCache}. */
  cache?: CacheStore
  /** `false` disables the worker's own cache (candle history, position snapshots). */
  workerCache?: boolean
  /** Server-aligned clock. Its offset from `Date.now()` is passed to the worker after every response. */
  now?: () => number
  /** Every REST response the worker receives, e.g. to sync `now` from its `Date` header. */
  onResponse?: (date: string | null, timing: { sentAt: number; receivedAt: number }) => void
}

/** Relative URLs would resolve against the worker's script URL (a `blob:` for inlined workers), so resolve them here. */
const resolveUrl = (url: string | undefined) => (url && globalThis.location ? new URL(url, globalThis.location.href).href : url)

/**
 * {@link Hydromancer} in a Web Worker: the connection, REST calls, decoding
 * and caching run off the main thread, and the streams look the same here.
 */
export class HydromancerWorker implements HydromancerClient {
  readonly cache: CacheStore
  readonly #port: MessagePortLike
  readonly #now: (() => number) | undefined
  readonly #onStatus: HydromancerWorkerOptions['onStatus']
  readonly #onError: HydromancerWorkerOptions['onError']
  readonly #onResponse: HydromancerWorkerOptions['onResponse']
  readonly #listeners = new Map<number, (event: StreamEvent) => void>()
  #status: ConnectionStatus = 'idle'
  #offsetMs = 0
  #nextId = 1

  constructor({ worker, cache, workerCache, now, onStatus, onError, onResponse, baseUrl, restUrl, wsUrl, ...options }: HydromancerWorkerOptions) {
    this.#port = worker
    this.cache = cache ?? defaultCache()
    this.#now = now
    this.#onStatus = onStatus
    this.#onError = onError
    this.#onResponse = onResponse
    worker.addEventListener('message', (event) => this.#receive(event.data as FromWorker))
    this.#post({
      type: 'init',
      options: { ...options, baseUrl: resolveUrl(baseUrl), restUrl: resolveUrl(restUrl), wsUrl: resolveUrl(wsUrl), cache: workerCache },
    })
    this.#syncClock()
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  connect(): void {
    this.#post({ type: 'connect' })
  }

  /** Closes the connection. The worker itself is the caller's to terminate. */
  close(): void {
    this.#post({ type: 'close' })
  }

  streamCandles({ onCandles, onError, ...options }: CandleStreamOptions): CandleStream {
    let newest: number | undefined
    const stream = this.#start({ kind: 'candles', options }, (event) => {
      if (event.type === 'streamError') onError?.(event.error && deserializeError(event.error))
      else if (event.type === 'candles') {
        for (const c of event.candles) if (newest === undefined || c.t > newest) newest = c.t
        onCandles(event.candles, event.source)
      }
    })
    return {
      get newest() {
        return newest
      },
      stop: stream.stop,
    }
  }

  streamL2Book({ onBook, onError, ...options }: L2BookStreamOptions): Stream {
    return this.#start({ kind: 'l2Book', options }, (event) => {
      if (event.type === 'streamError') onError?.(event.error && deserializeError(event.error))
      else if (event.type === 'book') onBook(event.book)
    })
  }

  /** `synced` and `height` follow the worker's mirror with a short delay (see `tpslFlushMs`). */
  mirrorTpsl({ onChange, onError, ...options }: TpslMirrorOptions): TpslMirror {
    const orders = new Map<number, TpslOrder>()
    let ready = false
    let synced = false
    let height: number | undefined
    const stream = this.#start({ kind: 'tpsl', options }, (event) => {
      if (event.type === 'streamError') onError?.(event.error && deserializeError(event.error))
      else if (event.type === 'tpsl') {
        for (const oid of event.removed) orders.delete(oid)
        for (const o of event.added) orders.set(o.oid, o)
        ;({ ready, synced, height } = event)
        onChange?.()
      }
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
      stop: stream.stop,
    }
  }

  pollPerpPositions({ onSnapshot, onError, ...options }: PerpPositionsPollOptions): Stream {
    return this.#start({ kind: 'perpPositions', options }, (event) => {
      if (event.type === 'streamError') onError?.(event.error && deserializeError(event.error))
      else if (event.type === 'positions') onSnapshot(event.positions)
    })
  }

  #start(req: StreamRequest, listener: (event: StreamEvent) => void): Stream {
    const id = this.#nextId++
    this.#listeners.set(id, listener)
    this.#post({ type: 'start', id, ...req })
    return {
      stop: () => {
        if (!this.#listeners.delete(id)) return
        this.#post({ type: 'stop', id })
      },
    }
  }

  #receive(msg: FromWorker): void {
    switch (msg.type) {
      case 'status':
        this.#status = msg.status
        this.#onStatus?.(msg.status)
        return
      case 'error':
        this.#onError?.(deserializeError(msg.error))
        return
      case 'response':
        this.#onResponse?.(msg.date, { sentAt: msg.sentAt, receivedAt: msg.receivedAt })
        this.#syncClock()
        return
      default:
        // Events for a stopped stream may still be in flight.
        this.#listeners.get(msg.id)?.(msg)
    }
  }

  #syncClock(): void {
    if (!this.#now) return
    const offsetMs = this.#now() - Date.now()
    // `now` and `Date.now` are read a moment apart; ignore that jitter.
    if (Math.abs(offsetMs - this.#offsetMs) < 5) return
    this.#offsetMs = offsetMs
    this.#post({ type: 'clock', offsetMs })
  }

  #post(msg: ToWorker): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin; that's Window's.
    this.#port.postMessage(msg)
  }
}
