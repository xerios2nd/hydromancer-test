// All display formatting is explicit UTC with fixed patterns. No `Intl`,
// `toLocaleString` or local-time getters, so output never depends on the
// machine's time zone or locale.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `HH:MM` or `HH:MM:SS` (UTC). */
export function formatTimeOfDay(ms: number, withSeconds = false): string {
  const d = new Date(ms)
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  return withSeconds ? `${hm}:${pad2(d.getUTCSeconds())}` : hm
}

/** `23 Oct` (UTC). */
export function formatDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** `2026-10-23 14:05` (UTC), seconds included for sub-minute data. */
export function formatDateTime(ms: number, withSeconds = false): string {
  const d = new Date(ms)
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  return `${date} ${formatTimeOfDay(ms, withSeconds)}`
}

/** Axis label for a tick at `ms` on a grid of `stepMs`: day at UTC midnight, else time. */
export function formatAxisTime(ms: number, stepMs: number): string {
  if (ms % DAY_MS === 0) return formatDay(ms)
  return formatTimeOfDay(ms, stepMs < 60_000)
}

/** Fixed-point price. `toFixed` is locale-independent by spec. */
export function formatPrice(price: number, decimals: number): string {
  return price.toFixed(decimals)
}

/** Decimals needed to show multiples of `step` exactly (`step` is 1, 2 or 5 × 10^k). */
export function stepDecimals(step: number): number {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
}

/**
 * Decimals for a quoted price: Hyperliquid prices carry at most 5 significant
 * figures (integers always allowed).
 */
export function priceDecimals(price: number): number {
  const magnitude = Math.floor(Math.log10(Math.abs(price) || 1)) + 1
  return Math.min(6, Math.max(0, 5 - magnitude))
}
