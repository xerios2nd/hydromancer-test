import { RateLimitError } from '../errors'
import { sleep } from '../util'

export interface WindowLimit {
  /** Requests allowed per window. */
  limit: number
  windowMs: number
}

/**
 * Documented windowed limits. These endpoints don't draw from the per-minute
 * weight budget; they have their own small allowance, which a chart reloading
 * or resyncing can easily exhaust.
 */
export const DEFAULT_WINDOW_LIMITS: Readonly<Record<string, WindowLimit>> = {
  tpslBook: { limit: 10, windowMs: 5 * 60_000 },
  l4Book: { limit: 10, windowMs: 5 * 60_000 },
  l2Book: { limit: 60, windowMs: 5 * 60_000 },
  l2BookDiffSnapshot: { limit: 300, windowMs: 5 * 60_000 },
  // "Snapshot-style endpoints: 5 requests per 10 minutes."
  perpSnapshots: { limit: 5, windowMs: 10 * 60_000 },
}

/**
 * Client-side sliding window, so the library waits for an allowance instead
 * of spending it on requests the server would reject. It only knows about
 * this page's requests; the server's 429s remain the source of truth.
 */
export class WindowLimiter {
  readonly limit: number
  readonly windowMs: number
  readonly #now: () => number
  #stamps: number[] = []

  constructor({ limit, windowMs }: WindowLimit, now: () => number = Date.now) {
    this.limit = limit
    this.windowMs = windowMs
    this.#now = now
  }

  /** Ms until a request would be admitted (0 = now). */
  waitTime(): number {
    const now = this.#now()
    this.#stamps = this.#stamps.filter((t) => t > now - this.windowMs)
    if (this.#stamps.length < this.limit) return 0
    return this.#stamps[0]! + this.windowMs - now
  }

  /**
   * Waits for an allowance and records the request. Throws a
   * {@link RateLimitError} straight away if that would take over `maxWaitMs`.
   */
  async acquire(requestType: string, opts: { signal?: AbortSignal; maxWaitMs?: number } = {}): Promise<void> {
    const wait = this.waitTime()
    if (wait > (opts.maxWaitMs ?? Number.POSITIVE_INFINITY)) {
      throw new RateLimitError(`${requestType}: local limit of ${this.limit} requests per ${Math.round(this.windowMs / 1000)}s reached`, {
        requestType,
        retryAfterMs: wait,
        limit: this.limit,
        code: 'local_rate_limit',
      })
    }
    if (wait > 0) {
      await sleep(wait, opts.signal)
      // Someone else may have taken the slot meanwhile; check again.
      return this.acquire(requestType, opts)
    }
    this.#stamps.push(this.#now())
  }
}
