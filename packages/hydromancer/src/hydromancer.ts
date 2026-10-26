import { CacheApiStore } from './cache/cacheApi'
import { MemoryCache, NoCache, TieredCache } from './cache/store'
import type { CacheStore } from './cache/store'
import { AuthenticationError, isAbortError, PermissionError, toHydromancerError } from './errors'
import type { HydromancerError } from './errors'
import { RestClient } from './rest/client'
import type { RequestOptions, RestClientOptions } from './rest/client'
import { InfoApi } from './rest/info'
import type { CandleRange } from './rest/info'
import { CandleHistory } from './streams/candleHistory'
import type { CandleHistoryOptions } from './streams/candleHistory'
import { streamCandles } from './streams/candles'
import type { CandleStream, CandleStreamOptions } from './streams/candles'
import type { Stream, StreamContext } from './streams/context'
import { streamL2Book } from './streams/l2Book'
import type { L2BookStreamOptions } from './streams/l2Book'
import { pollPerpPositions } from './streams/perpPositions'
import type { PerpPositionsPollOptions } from './streams/perpPositions'
import { mirrorTpsl } from './streams/tpsl'
import type { TpslMirror, TpslMirrorOptions } from './streams/tpsl'
import type { Candle } from './types'
import { Connection } from './ws/connection'
import type { ConnectionOptions, ConnectionStatus } from './ws/connection'
import type { WebSocketFactory } from './ws/socket'

/** API origins. REST is `<base>/info`, the WebSocket `<base>/ws` (as `wss:`). */
export const BASE_URLS = {
  mainnet: 'https://api.hydromancer.xyz',
  testnet: 'https://api-testnet.hydromancer.xyz',
} as const

export interface HydromancerOptions {
  /**
   * API key, sent as a Bearer header (REST) and `token` parameter (WebSocket).
   * In a browser it's visible to the page's user and scripts, so let users
   * bring their own key rather than shipping one. Leave unset when `baseUrl`
   * is a proxy that adds it.
   */
  apiKey?: string
  /** Picks the base URL from {@link BASE_URLS}. Default `mainnet`. */
  network?: keyof typeof BASE_URLS
  /**
   * API origin, for a self-hosted gateway, peering endpoint or proxy (e.g.
   * `https://hm.internal.example` or the same-origin prefix `/hydromancer`).
   * REST goes to `<baseUrl>/info`, the WebSocket to `<baseUrl>/ws`. Overrides `network`.
   */
  baseUrl?: string
  /** Full `POST /info` URL, absolute or same-origin path, when it doesn't follow `baseUrl`. */
  restUrl?: string
  /** Full WebSocket URL, absolute or same-origin path, when it doesn't follow `baseUrl`. */
  wsUrl?: string
  fetch?: typeof fetch
  createWebSocket?: WebSocketFactory
  /**
   * Where to cache candle history and position snapshots. Defaults to memory
   * in front of the Cache API where available, memory alone elsewhere.
   * `false` disables caching.
   */
  cache?: CacheStore | false
  /** Clock for request ranges, ideally synced to the server. Defaults to `Date.now`. */
  now?: () => number
  /** Check the key over REST before connecting, and stay disconnected if it's rejected. */
  validateApiKey?: boolean
  rest?: Omit<RestClientOptions, 'baseUrl' | 'url' | 'apiKey' | 'fetch'>
  ws?: Omit<ConnectionOptions, 'baseUrl' | 'url' | 'apiKey' | 'createWebSocket' | 'onStatus' | 'onError'>
  history?: Omit<CandleHistoryOptions, 'info' | 'cache' | 'now'>
  onStatus?: (status: ConnectionStatus) => void
  /** Connection-level errors. Streams report their own through their `onError`. */
  onError?: (error: HydromancerError) => void
}

export function defaultCache(): CacheStore {
  const memory = new MemoryCache()
  return CacheApiStore.isSupported() ? new TieredCache([memory, new CacheApiStore()]) : memory
}

/**
 * Hydromancer client for realtime charts: one shared WebSocket, a REST client,
 * a cache, and stream recipes that keep live data consistent across
 * disconnects.
 */
export class Hydromancer {
  readonly rest: RestClient
  readonly info: InfoApi
  readonly ws: Connection
  readonly cache: CacheStore
  readonly history: CandleHistory
  readonly now: () => number
  readonly #validate: boolean
  readonly #onError: HydromancerOptions['onError']
  readonly #ctx: StreamContext
  #connectAbort: AbortController | undefined

  constructor(opts: HydromancerOptions = {}) {
    const baseUrl = opts.baseUrl ?? BASE_URLS[opts.network ?? 'mainnet']
    this.now = opts.now ?? Date.now
    this.#validate = opts.validateApiKey ?? false
    this.#onError = opts.onError
    this.rest = new RestClient({ ...opts.rest, baseUrl, url: opts.restUrl, apiKey: opts.apiKey, fetch: opts.fetch })
    this.info = new InfoApi(this.rest)
    this.ws = new Connection({
      ...opts.ws,
      baseUrl,
      url: opts.wsUrl,
      apiKey: opts.apiKey,
      createWebSocket: opts.createWebSocket,
      onStatus: opts.onStatus,
      onError: opts.onError,
    })
    this.cache = opts.cache === false ? new NoCache() : (opts.cache ?? defaultCache())
    this.history = new CandleHistory({ ...opts.history, info: this.info, cache: this.cache, now: this.now })
    this.#ctx = { ws: this.ws, info: this.info, history: this.history, cache: this.cache, now: this.now }
  }

  get status(): ConnectionStatus {
    return this.ws.status
  }

  /** Opens the WebSocket (after validating the key, if enabled). Streams can be created before or after. */
  connect(): void {
    if (!this.#validate) {
      this.ws.connect()
      return
    }
    this.#connectAbort?.abort()
    const abort = new AbortController()
    this.#connectAbort = abort
    this.info.validateApiKey({ signal: abort.signal }).then(
      () => {
        if (!abort.signal.aborted) this.ws.connect()
      },
      (err: unknown) => {
        if (abort.signal.aborted || isAbortError(err)) return
        const error = toHydromancerError(err)
        if (error instanceof AuthenticationError || error instanceof PermissionError) {
          this.ws.fail(error)
          return
        }
        // The check itself failed (network, 5xx). Connect anyway; the WebSocket reports auth problems too.
        this.#onError?.(error)
        this.ws.connect()
      },
    )
  }

  close(): void {
    this.#connectAbort?.abort()
    this.ws.close()
  }

  /** Resolves if the API key is accepted; throws `AuthenticationError` if not. */
  validateApiKey(opts?: RequestOptions): Promise<void> {
    return this.info.validateApiKey(opts)
  }

  /** Candles in `[startTime, endTime)`, from cache where possible. For scrolling back through history. */
  loadCandles(range: CandleRange, opts?: RequestOptions): Promise<Candle[]> {
    return this.history.load(range, opts)
  }

  /** History plus live candles, backfilled after every disconnect. */
  streamCandles(opts: CandleStreamOptions): CandleStream {
    return streamCandles(this.#ctx, opts)
  }

  /** Live order book snapshots. */
  streamL2Book(opts: L2BookStreamOptions): Stream {
    return streamL2Book(this.#ctx, opts)
  }

  /** A synced local copy of a market's TP/SL trigger orders. */
  mirrorTpsl(opts: TpslMirrorOptions): TpslMirror {
    return mirrorTpsl(this.#ctx, opts)
  }

  /** Position snapshots (liquidation prices, notionals, …) whenever a new one is published. */
  pollPerpPositions(opts: PerpPositionsPollOptions): Stream {
    return pollPerpPositions(this.#ctx, opts)
  }
}
