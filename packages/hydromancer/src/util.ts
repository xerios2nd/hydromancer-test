export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Prices and sizes arrive as decimal strings. Anything unparsable becomes NaN. */
export const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return Number.NaN
}

/** Sorts candles (or anything with `t`) by time, in place, and returns them. Only for arrays the caller owns. */
export function sortByTime<T extends { t: number }>(items: T[]): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- `toSorted` isn't in the project's ES2022 lib; callers pass arrays they built.
  return items.sort((a, b) => a.t - b.t)
}

/**
 * `base` + `path` with exactly one slash between them. Works for absolute URLs
 * (`https://api.hydromancer.xyz`) and same-origin prefixes (`/hydromancer`).
 */
export const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Resolves after `ms`, or rejects with the signal's reason when it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface BackoffOptions {
  minMs: number
  maxMs: number
}

/**
 * Exponential backoff with jitter (50–100% of the step), so clients don't
 * retry in lockstep after an outage. `attempt` starts at 0.
 */
export function backoffDelay(attempt: number, { minMs, maxMs }: BackoffOptions, random = Math.random): number {
  const base = Math.min(maxMs, minMs * 2 ** attempt)
  return base * (0.5 + random() * 0.5)
}

/** Stable key for a JSON value: object keys sorted, `undefined` members dropped. */
export function stableKey(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) => {
    if (!isRecord(value)) return value
    const sorted: Record<string, unknown> = {}
    // oxlint-disable-next-line unicorn/no-array-sort -- `toSorted` isn't in the project's ES2022 lib; `Object.keys` returns a fresh array.
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) sorted[k] = value[k]
    return sorted
  })
}
