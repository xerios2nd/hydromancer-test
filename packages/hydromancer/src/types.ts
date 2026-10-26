// Domain types. Wire formats send prices and sizes as decimal strings; these
// are the parsed, numeric forms the rest of the library and its callers use.

import type { Interval } from './intervals'

export interface Candle {
  /** Open time, ms since epoch. */
  t: number
  /** Close time, ms since epoch (open time of the next candle − 1). */
  T: number
  o: number
  h: number
  l: number
  c: number
  /** Volume in the base asset. */
  v: number
  /** Quote (notional) volume. `undefined` before 2025-08-01, which Hyperliquid's history lacks. */
  q: number | undefined
  /** Number of trades. */
  n: number
  /** True once the candle is finalized. */
  x: boolean
}

export interface CandleKey {
  coin: string
  interval: Interval
}

export interface BookLevel {
  px: number
  sz: number
  /** Number of orders at the level. */
  n: number
}

export interface L2Book {
  coin: string
  /** Block time, ms since epoch. */
  time: number
  /** Best first (descending price). */
  bids: BookLevel[]
  /** Best first (ascending price). */
  asks: BookLevel[]
}

export type TpslKind = 'tp' | 'sl'

export interface TpslOrder {
  oid: number
  coin: string
  user: string
  /** `B` buy, `A` sell. */
  side: 'A' | 'B'
  triggerPx: number
  limitPx: number
  sz: number
  /** e.g. "Take Profit Market", "Stop Limit". */
  orderType: string
  kind: TpslKind
  /** Attached to a position; cancelled when it closes. */
  isPositionTpsl: boolean
  reduceOnly: boolean
  /** Creation time, ms since epoch. */
  timestamp: number
}

export type TpslDiff = { type: 'add'; order: TpslOrder } | { type: 'remove'; oid: number; coin: string; reason: string | undefined }

/** One block's worth of trigger order changes. */
export interface TpslUpdate {
  height: number
  /** Block time, ms since epoch. */
  timestamp: number
  diffs: TpslDiff[]
}

export interface TpslBook {
  height: number
  /** Block time, ms since epoch. */
  timestamp: number
  orders: TpslOrder[]
}

/**
 * Every open position in one market. Column-oriented (one typed array per
 * field, index `i` is position `i`) so 100k+ positions stay compact.
 */
export interface PerpPositions {
  snapshotId: string
  market: string
  /** Signed size; negative is short. */
  size: Float64Array
  /** Signed notional. */
  notional: Float64Array
  fundingPnl: Float64Array
  entryPx: Float64Array
  /** 1 = isolated margin, 0 = cross. */
  isolated: Uint8Array
  leverage: Float64Array
  /** NaN when there is none (the wire sends 0). */
  liquidationPx: Float64Array
  accountValue: Float64Array
  addresses: string[]
}

export interface PerpSnapshotId {
  snapshotId: string
  /** Snapshot time, ms since epoch. */
  timestamp: number
}

export interface ApiUsageEntry {
  /** `YYYY-MM-DD`. */
  day: string
  requestType: string
  totalRequests: number
  successRequests: number
  failureRequests: number
  avgProcessingTimeMs: number
  tokensConsumed: number
}
