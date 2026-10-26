// Historical candles with a chunked cache. Time is cut into fixed chunks of
// `chunkCandles` candles; a chunk that ended long enough ago can no longer
// change, so it's stored whole and later loads skip the network for it.

import { cacheGet, cacheSet } from '../cache/store'
import type { CacheStore } from '../cache/store'
import type { Interval } from '../intervals'
import { nominalIntervalMs } from '../intervals'
import type { RequestOptions } from '../rest/client'
import type { CandleRange, InfoApi } from '../rest/info'
import type { Candle } from '../types'
import { sortByTime } from '../util'

export interface CandleHistoryOptions {
  info: InfoApi
  cache: CacheStore
  /** Server-aligned clock. */
  now: () => number
  /** Candles per cached chunk. */
  chunkCandles?: number
  /** How long after a chunk ends before it's trusted as final, ms. Covers late finalisation. */
  finalityGraceMs?: number
  /** Cached chunks expire after this long. Undefined keeps them until evicted. */
  ttlMs?: number
}

/** `[t, T, o, h, l, c, v, q | null, n, x]`. */
type CachedCandle = [number, number, number, number, number, number, number, number | null, number, 0 | 1]

const CACHE_VERSION = 1

const encode = (c: Candle): CachedCandle => [c.t, c.T, c.o, c.h, c.l, c.c, c.v, c.q ?? null, c.n, c.x ? 1 : 0]
const decode = ([t, T, o, h, l, c, v, q, n, x]: CachedCandle): Candle => ({ t, T, o, h, l, c, v, q: q ?? undefined, n, x: x === 1 })

export class CandleHistory {
  readonly #info: InfoApi
  readonly #cache: CacheStore
  readonly #now: () => number
  readonly #chunkCandles: number
  readonly #graceMs: number
  readonly #ttlMs: number | undefined

  constructor({ info, cache, now, chunkCandles = 1000, finalityGraceMs = 120_000, ttlMs = 30 * 86_400_000 }: CandleHistoryOptions) {
    this.#info = info
    this.#cache = cache
    this.#now = now
    this.#chunkCandles = chunkCandles
    this.#graceMs = finalityGraceMs
    this.#ttlMs = ttlMs
  }

  #span(interval: Interval): number {
    return this.#chunkCandles * nominalIntervalMs(interval)
  }

  #key(coin: string, interval: Interval, chunk: number): string {
    return `hydromancer:candles:v${CACHE_VERSION}:${coin}:${interval}:${chunk}`
  }

  #isFinal(chunk: number, span: number): boolean {
    return chunk + span + this.#graceMs <= this.#now()
  }

  /**
   * Candles with open time in `[startTime, endTime)`, ascending. Final chunks
   * come from the cache when present; everything else is fetched, and newly
   * fetched final chunks are cached.
   */
  async load({ coin, interval, startTime, endTime }: CandleRange, opts?: RequestOptions): Promise<Candle[]> {
    if (endTime <= startTime) return []
    const span = this.#span(interval)
    const first = Math.floor(startTime / span) * span
    const out: Candle[] = []
    /** Ranges to fetch, and the final chunks each one fully covers. */
    const fetches: { start: number; end: number; chunks: number[] }[] = []

    const chunks: number[] = []
    for (let chunk = first; chunk < endTime; chunk += span) chunks.push(chunk)
    const cachedChunks = await Promise.all(
      chunks.map((chunk) => (this.#isFinal(chunk, span) ? cacheGet<CachedCandle[]>(this.#cache, this.#key(coin, interval, chunk)) : undefined)),
    )

    for (const [i, chunk] of chunks.entries()) {
      const final = this.#isFinal(chunk, span)
      const cached = cachedChunks[i]
      if (final && Array.isArray(cached)) {
        for (const c of cached) if (c[0] >= startTime && c[0] < endTime) out.push(decode(c))
        continue
      }
      // A final chunk is fetched whole so it can be cached; the open tail only for what was asked.
      const start = final ? chunk : Math.max(chunk, startTime)
      const end = final ? chunk + span : Math.min(chunk + span, endTime)
      const prev = fetches.at(-1)
      if (prev && prev.end === start) {
        prev.end = end
        if (final) prev.chunks.push(chunk)
      } else {
        fetches.push({ start, end, chunks: final ? [chunk] : [] })
      }
    }

    const fetched = await Promise.all(fetches.map(({ start, end }) => this.#info.candles({ coin, interval, startTime: start, endTime: end }, opts)))
    const writes: Promise<void>[] = []
    for (const [i, candles] of fetched.entries()) {
      for (const c of candles) if (c.t >= startTime && c.t < endTime) out.push(c)
      for (const chunk of fetches[i]!.chunks) {
        // Re-check: the clock may have moved. Never cache the open tail.
        if (!this.#isFinal(chunk, span)) continue
        const inChunk = candles.filter((c) => c.t >= chunk && c.t < chunk + span).map(encode)
        writes.push(cacheSet(this.#cache, this.#key(coin, interval, chunk), inChunk, { ttlMs: this.#ttlMs }))
      }
    }
    await Promise.all(writes)

    return sortByTime(out)
  }
}
