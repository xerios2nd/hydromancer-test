// Typed `POST /info` endpoints the chart needs.

import { decodePerpSnapshots } from '../codec/perpSnapshot'
import { decodeTpslBook } from '../codec/tpslBook'
import { DecodeError } from '../errors'
import type { Interval } from '../intervals'
import { parseApiUsage, parseCandle, parsePerpSnapshotId } from '../parse'
import type { ApiUsageEntry, Candle, PerpPositions, PerpSnapshotId, TpslBook } from '../types'
import { sortByTime } from '../util'
import type { RequestOptions, RestClient } from './client'

/** Maximum (and default) `limit` of one `candleSnapshot` request. */
export const CANDLE_SNAPSHOT_LIMIT = 5000

export interface CandleRange {
  coin: string
  interval: Interval
  /** Open time, inclusive, ms. */
  startTime: number
  /** Open time, exclusive, ms. */
  endTime: number
}

export class InfoApi {
  readonly client: RestClient

  constructor(client: RestClient) {
    this.client = client
  }

  /**
   * One `candleSnapshot` request: up to `limit` candles with open time in
   * `[startTime, endTime)`, ascending. Weight 20. See {@link candles} for ranges
   * of any length.
   */
  async candleSnapshot(
    { coin, interval, startTime, endTime, limit = CANDLE_SNAPSHOT_LIMIT }: CandleRange & { limit?: number },
    opts?: RequestOptions,
  ): Promise<Candle[]> {
    const body = await this.client.json({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime, limit } }, opts)
    if (!Array.isArray(body)) throw new DecodeError('candleSnapshot: expected an array')
    const out: Candle[] = []
    for (const raw of body) {
      const parsed = parseCandle(raw)
      if (parsed && parsed.candle.t >= startTime && parsed.candle.t < endTime) out.push(parsed.candle)
    }
    return sortByTime(out)
  }

  /**
   * Every candle with open time in `[startTime, endTime)`, ascending, in as
   * many `candleSnapshot` pages as it takes. A full page doesn't say which end
   * of the range it came from, so both remainders are fetched.
   */
  async candles(range: CandleRange, opts?: RequestOptions): Promise<Candle[]> {
    const byTime = new Map<number, Candle>()
    await this.#page(range, byTime, opts)
    return sortByTime([...byTime.values()])
  }

  async #page(range: CandleRange, into: Map<number, Candle>, opts: RequestOptions | undefined): Promise<void> {
    if (range.endTime <= range.startTime) return
    const page = await this.candleSnapshot(range, opts)
    for (const c of page) into.set(c.t, c)
    if (page.length < CANDLE_SNAPSHOT_LIMIT) return
    // Sequential on purpose: one page at a time keeps the weight spend predictable.
    await this.#page({ ...range, endTime: page[0]!.t }, into, opts)
    await this.#page({ ...range, startTime: page.at(-1)!.t + 1 }, into, opts)
  }

  /** Every active TP/SL trigger order, for `coins` or all markets. 10 requests per 5 minutes. */
  async tpslBook(coins?: string[], opts?: RequestOptions): Promise<TpslBook> {
    const { bytes } = await this.client.bytes({ type: 'tpslBook', ...(coins ? { coins } : {}) }, opts)
    return decodeTpslBook(bytes)
  }

  /** Id of the latest position snapshot. Cheap (weight 1); poll it, and download only on change. */
  async perpSnapshotTimestamp(opts?: RequestOptions): Promise<PerpSnapshotId> {
    const id = parsePerpSnapshotId(await this.client.json({ type: 'perpSnapshotTimestamp' }, opts))
    if (!id) throw new DecodeError('perpSnapshotTimestamp: missing snapshot_id')
    return id
  }

  /**
   * All positions in the given markets (`"BTC"`, `"xyz:BTC"`, `"ALL"`, …).
   * Paid add-on. 404 until the first snapshot exists.
   */
  async perpSnapshots(marketNames: string[], opts?: RequestOptions): Promise<PerpPositions[]> {
    const { bytes, headers } = await this.client.bytes({ type: 'perpSnapshots', market_names: marketNames }, opts)
    return decodePerpSnapshots(bytes, headers.get('x-payload-format'))
  }

  /** Usage per day and request type. */
  async apiUsage(days = 30, opts?: RequestOptions): Promise<ApiUsageEntry[]> {
    const usage = parseApiUsage(await this.client.json({ type: 'apiUsage', days }, opts))
    if (!usage) throw new DecodeError('apiUsage: expected an array')
    return usage
  }

  /**
   * Checks the API key with a cheap authenticated request. Resolves if it's
   * accepted; throws `AuthenticationError` (or `PermissionError`)
   * if not, and the usual transport errors if the check itself can't run.
   */
  async validateApiKey(opts?: RequestOptions): Promise<void> {
    await this.apiUsage(1, opts)
  }
}
