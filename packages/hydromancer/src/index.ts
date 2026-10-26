// Hydromancer client for realtime charts with historical data.
// Framework-free: WebSocket connection handling, typed REST endpoints, binary
// decoders, caching, and stream recipes that stay consistent across reconnects.

export { Hydromancer, defaultCache, BASE_URLS } from './hydromancer'
export type { HydromancerOptions } from './hydromancer'

export * from './errors'
export type * from './types'
export { INTERVAL_MS, INTERVALS, addIntervals, intervalStart, isFixedInterval, isInterval, nominalIntervalMs } from './intervals'
export type { FixedInterval, Interval } from './intervals'

export { RestClient, DEFAULT_BASE_URL, DEFAULT_REST_URL } from './rest/client'
export type { BinaryResponse, InfoRequest, RateLimitInfo, RequestOptions, RestClientOptions, RetryOptions } from './rest/client'
export { InfoApi, CANDLE_SNAPSHOT_LIMIT } from './rest/info'
export type { CandleRange } from './rest/info'
export { DEFAULT_WINDOW_LIMITS, WindowLimiter } from './rest/limiter'
export type { WindowLimit } from './rest/limiter'

export { Connection, DEFAULT_WS_URL } from './ws/connection'
export type { ConnectionOptions, ConnectionStatus, SubscriptionHandler } from './ws/connection'
export type { CandleSubscription, DataFrame, L2BookSubscription, ServerWarning, Subscription, TpslSubscription } from './ws/protocol'
export type { SocketTiming, WebSocketFactory, WebSocketLike } from './ws/socket'

export { CacheApiStore } from './cache/cacheApi'
export type { CacheApiStoreOptions } from './cache/cacheApi'
export { MemoryCache, NoCache, TieredCache, cacheGet, cacheSet } from './cache/store'
export type { CacheSetOptions, CacheStore, MemoryCacheOptions } from './cache/store'

export { CandleHistory } from './streams/candleHistory'
export type { CandleHistoryOptions } from './streams/candleHistory'
export type { CandleSource, CandleStream, CandleStreamOptions } from './streams/candles'
export type { ErrorCallback, Stream } from './streams/context'
export type { L2BookStreamOptions } from './streams/l2Book'
export type { PerpPositionsPollOptions } from './streams/perpPositions'
export type { TpslMirror, TpslMirrorOptions } from './streams/tpsl'

export { decodeMsgpack } from './codec/msgpack'
export { decodePerpSnapshots } from './codec/perpSnapshot'
export { decodeTpslBook } from './codec/tpslBook'

export { HydromancerWorker } from './worker/client'
export type { HydromancerClient, HydromancerWorkerOptions } from './worker/client'
export { serveHydromancer } from './worker/host'
export type { ServeHydromancerOptions } from './worker/host'
export { deserializeError, serializeError } from './worker/protocol'
export type { MessagePortLike, SerializedError, WorkerHydromancerOptions } from './worker/protocol'
