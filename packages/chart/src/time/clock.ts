let offsetMs = 0

/**
 * Current time in ms since epoch, corrected towards server time. Use this
 * instead of `Date.now()` anywhere the value is compared against market data.
 */
export function now(): number {
  return Date.now() + offsetMs
}

/** Current correction applied by {@link now}, in ms. */
export function clockOffset(): number {
  return offsetMs
}

/**
 * Updates the offset from a server timestamp observed during a request.
 * `sentAt` / `receivedAt` are local `Date.now()` readings bracketing the
 * request; the server time is assumed to sit at their midpoint. A server clock
 * with coarse `resolutionMs` (an HTTP `Date` header is whole seconds) can only
 * tell drift larger than that resolution apart from rounding, so smaller
 * corrections are ignored instead of adding jitter.
 */
export function syncClock(serverMs: number, sentAt: number, receivedAt: number, resolutionMs = 0): void {
  const candidate = serverMs + resolutionMs / 2 - (sentAt + receivedAt) / 2
  if (Math.abs(candidate - offsetMs) > resolutionMs) offsetMs = candidate
}

/** {@link syncClock} from an HTTP `Date` response header, if present. */
export function syncClockFromDateHeader(header: string | null, sentAt: number, receivedAt: number): void {
  if (!header) return
  const serverMs = Date.parse(header)
  if (Number.isFinite(serverMs)) syncClock(serverMs, sentAt, receivedAt, 1000)
}
