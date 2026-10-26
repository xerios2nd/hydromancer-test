// JSON wire formats → domain types. Parsers return `undefined` for items that
// don't match the documented shape, so one bad item never sinks a batch.
// Unknown fields are ignored, as the docs require.

import { isInterval } from './intervals'
import type { Interval } from './intervals'
import type { ApiUsageEntry, BookLevel, Candle, L2Book, PerpSnapshotId, TpslDiff, TpslKind, TpslOrder, TpslUpdate } from './types'
import { isRecord, num, str } from './util'

/** A candle with its market, as the stream and `candleSnapshot` send it (`s`, `i`). */
export interface KeyedCandle {
  coin: string
  interval: Interval
  candle: Candle
}

export function parseCandle(raw: unknown): KeyedCandle | undefined {
  if (!isRecord(raw)) return undefined
  const candle: Candle = {
    t: num(raw.t),
    T: num(raw.T),
    o: num(raw.o),
    h: num(raw.h),
    l: num(raw.l),
    c: num(raw.c),
    v: num(raw.v),
    q: raw.q === null || raw.q === undefined ? undefined : num(raw.q),
    n: num(raw.n),
    x: raw.x === true,
  }
  const { t, T, o, h, l, c, v, n } = candle
  if (![t, T, o, h, l, c, v, n].every(Number.isFinite)) return undefined
  if (candle.q !== undefined && !Number.isFinite(candle.q)) candle.q = undefined
  const coin = str(raw.s)
  const interval = raw.i
  if (coin === undefined || !isInterval(interval)) return undefined
  return { coin, interval, candle }
}

function parseLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return []
  const levels: BookLevel[] = []
  for (const l of raw) {
    if (!isRecord(l)) continue
    const level = { px: num(l.px), sz: num(l.sz), n: num(l.n) }
    if (!Number.isFinite(level.n)) level.n = 0
    if (Number.isFinite(level.px) && Number.isFinite(level.sz)) levels.push(level)
  }
  return levels
}

export function parseL2Book(raw: unknown): L2Book | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.levels)) return undefined
  const coin = str(raw.coin)
  const time = num(raw.time)
  if (coin === undefined || !Number.isFinite(time)) return undefined
  const [bids, asks] = raw.levels as unknown[]
  return { coin, time, bids: parseLevels(bids), asks: parseLevels(asks) }
}

/** `l2Book` `data`: one object for a single coin, an array of them for several. */
export function parseL2Books(data: unknown): L2Book[] {
  const items = Array.isArray(data) ? data : [data]
  return items.map(parseL2Book).filter((b) => b !== undefined)
}

/** `orderType` is e.g. "Take Profit Market" or "Stop Limit". */
export function tpslKind(orderType: string): TpslKind | undefined {
  if (orderType.startsWith('Take Profit')) return 'tp'
  if (orderType.startsWith('Stop')) return 'sl'
  return undefined
}

/** Fields in `tpslBook` tuple order. */
export type TpslOrderFields = [
  oid: unknown,
  coin: unknown,
  user: unknown,
  side: unknown,
  triggerPx: unknown,
  limitPx: unknown,
  sz: unknown,
  triggerCondition: unknown,
  orderType: unknown,
  isPositionTpsl: unknown,
  reduceOnly: unknown,
  timestamp: unknown,
]

/** Builds an order from fields in `tpslBook` tuple order. Non-TP/SL order types are dropped. */
export function tpslOrderFromFields(f: TpslOrderFields): TpslOrder | undefined {
  const [oid, coin, user, side, triggerPx, limitPx, sz, , orderType, isPositionTpsl, reduceOnly, timestamp] = f
  const type = str(orderType) ?? ''
  const kind = tpslKind(type)
  const c = str(coin)
  if (!kind || c === undefined || (side !== 'A' && side !== 'B')) return undefined
  const order: TpslOrder = {
    oid: num(oid),
    coin: c,
    user: str(user) ?? '',
    side,
    triggerPx: num(triggerPx),
    limitPx: num(limitPx),
    sz: num(sz),
    orderType: type,
    kind,
    isPositionTpsl: isPositionTpsl === true,
    reduceOnly: reduceOnly === true,
    timestamp: num(timestamp),
  }
  if (![order.oid, order.triggerPx, order.sz].every(Number.isFinite)) return undefined
  return order
}

function parseTpslDiff(d: unknown): TpslDiff | undefined {
  if (!isRecord(d)) return undefined
  if (d.type === 'remove') {
    const oid = num(d.oid)
    const coin = str(d.coin)
    return Number.isFinite(oid) && coin !== undefined ? { type: 'remove', oid, coin, reason: str(d.reason) } : undefined
  }
  if (d.type === 'add') {
    const order = tpslOrderFromFields([
      d.oid,
      d.coin,
      d.user,
      d.side,
      d.triggerPx,
      d.limitPx,
      d.sz,
      d.triggerCondition,
      d.orderType,
      d.isPositionTpsl,
      d.reduceOnly,
      d.timestamp,
    ])
    return order && { type: 'add', order }
  }
  return undefined
}

/** `tpslUpdates` `data`. */
export function parseTpslUpdate(data: unknown): TpslUpdate | undefined {
  if (!isRecord(data) || !Array.isArray(data.diffs)) return undefined
  const height = num(data.height)
  if (!Number.isFinite(height)) return undefined
  const diffs = data.diffs.map(parseTpslDiff).filter((d) => d !== undefined)
  const timestamp = num(data.timestamp)
  return { height, timestamp: Number.isFinite(timestamp) ? timestamp : Number.NaN, diffs }
}

/** `perpSnapshotTimestamp`. `timestamp` is documented in Unix seconds; ms values are accepted too. */
export function parsePerpSnapshotId(raw: unknown): PerpSnapshotId | undefined {
  if (!isRecord(raw)) return undefined
  const snapshotId = str(raw.snapshot_id)
  if (!snapshotId) return undefined
  const ts = num(raw.timestamp)
  return { snapshotId, timestamp: Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : Number.NaN }
}

export function parseApiUsage(raw: unknown): ApiUsageEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter(isRecord).map((r) => ({
    day: String(r.day ?? ''),
    requestType: String(r.request_type ?? ''),
    totalRequests: num(r.total_requests),
    successRequests: num(r.success_requests),
    failureRequests: num(r.failure_requests),
    avgProcessingTimeMs: num(r.avg_processing_time_ms),
    tokensConsumed: num(r.tokens_consumed),
  }))
}
