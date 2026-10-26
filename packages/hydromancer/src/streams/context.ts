import type { CacheStore } from '../cache/store'
import { RateLimitError } from '../errors'
import type { HydromancerError } from '../errors'
import type { InfoApi } from '../rest/info'
import { backoffDelay } from '../util'
import type { Connection } from '../ws/connection'
import type { CandleHistory } from './candleHistory'

/** What a stream needs from the client. */
export interface StreamContext {
  ws: Connection
  info: InfoApi
  history: CandleHistory
  cache: CacheStore
  /** Server-aligned clock, ms since epoch. */
  now: () => number
}

/** Receives a stream's errors; `undefined` means the last one has cleared. */
export type ErrorCallback = (error: HydromancerError | undefined) => void

export interface Stream {
  stop(): void
}

/** Delay before retrying after `err`: the server's `retryAfterMs` if it gave one, else backoff. */
export function retryDelay(err: HydromancerError, attempt: number, minMs = 2_000, maxMs = 60_000): number {
  if (err instanceof RateLimitError && err.retryAfterMs !== undefined) return Math.max(err.retryAfterMs, 250)
  return backoffDelay(attempt, { minMs, maxMs })
}

/**
 * Tracks a per-subscription `seq`. Returns true when messages were skipped,
 * which means the local state may be missing updates and needs a resync.
 */
export class SeqTracker {
  #expected: number | undefined

  reset(): void {
    this.#expected = undefined
  }

  gap(seq: number | undefined): boolean {
    if (seq === undefined) return false
    const gap = this.#expected !== undefined && seq > this.#expected
    this.#expected = Math.max(this.#expected ?? 0, seq + 1)
    return gap
  }
}
