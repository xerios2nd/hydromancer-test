// Candle intervals. Everything up to `3d` has a fixed length. `1w` starts on
// Monday 00:00 UTC and `1M` on the 1st of the month, so those are calendar math.

export const INTERVAL_MS = {
  '1s': 1_000,
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
} as const satisfies Record<string, number>

export type FixedInterval = keyof typeof INTERVAL_MS
export type Interval = FixedInterval | '1w' | '1M'

export const INTERVALS: readonly Interval[] = [...(Object.keys(INTERVAL_MS) as FixedInterval[]), '1w', '1M']

const DAY = 86_400_000
const WEEK = 7 * DAY
/** 1970-01-05, the first Monday after the epoch. */
const MONDAY = 4 * DAY

export function isInterval(v: unknown): v is Interval {
  return typeof v === 'string' && (INTERVALS as readonly string[]).includes(v)
}

export function isFixedInterval(v: Interval): v is FixedInterval {
  return v in INTERVAL_MS
}

/** Typical length, ms. Exact for fixed intervals; 31 days for `1M`. Use for sizing, not alignment. */
export function nominalIntervalMs(interval: Interval): number {
  if (interval === '1w') return WEEK
  if (interval === '1M') return 31 * DAY
  return INTERVAL_MS[interval]
}

/** Open time of the candle containing `t`. */
export function intervalStart(interval: Interval, t: number): number {
  if (interval === '1w') return Math.floor((t - MONDAY) / WEEK) * WEEK + MONDAY
  if (interval === '1M') {
    const d = new Date(t)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }
  const ms = INTERVAL_MS[interval]
  return Math.floor(t / ms) * ms
}

/** Open time `n` candles after the one containing `t` (negative `n` goes back). */
export function addIntervals(interval: Interval, t: number, n: number): number {
  const start = intervalStart(interval, t)
  if (interval === '1M') {
    const d = new Date(start)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
  }
  return start + n * nominalIntervalMs(interval)
}
