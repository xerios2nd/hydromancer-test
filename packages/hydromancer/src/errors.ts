// Error hierarchy. Every error the library raises or reports is a
// `HydromancerError`, so callers can `instanceof`-check one base class and
// branch on the subclass (or `code`) for handling.
//
//   HydromancerError
//   ├─ ApiError              server rejected the request (REST status or WebSocket error frame)
//   │  ├─ BadRequestError       400, or a WebSocket validation error
//   │  ├─ AuthenticationError   401, invalid API key
//   │  ├─ PermissionError       403, plan or add-on doesn't cover it
//   │  ├─ NotFoundError         404, e.g. no perp snapshot yet
//   │  ├─ RateLimitError        429, `message_rate_limit`, or the local window limiter
//   │  ├─ ServerError           5xx
//   │  └─ SubscriptionError     WebSocket subscribe rejected
//   ├─ NetworkError          fetch or WebSocket transport failure
//   ├─ RequestTimeoutError   no response within the timeout
//   └─ DecodeError           payload doesn't match the documented format

export interface HydromancerErrorOptions {
  cause?: unknown
  /** Machine-readable code. Server codes (`rate_limited`, `invalid_request_id`, …) are passed through. */
  code?: string
}

export class HydromancerError extends Error {
  override name = 'HydromancerError'
  readonly code: string

  constructor(message: string, { cause, code = 'hydromancer_error' }: HydromancerErrorOptions = {}) {
    super(message, { cause })
    this.code = code
  }

  /** Whether the same request may succeed if retried later. */
  get retryable(): boolean {
    return false
  }
}

export interface ApiErrorOptions extends HydromancerErrorOptions {
  /** HTTP status. Absent for WebSocket errors. */
  status?: number
  /** REST `type` or WebSocket subscription type the error belongs to. */
  requestType?: string
  /** Server `correlationId`, worth quoting to Hydromancer support. */
  correlationId?: string
  /** Server `details`, as sent. */
  details?: unknown
}

export class ApiError extends HydromancerError {
  override name = 'ApiError'
  readonly status: number | undefined
  readonly requestType: string | undefined
  readonly correlationId: string | undefined
  readonly details: unknown

  constructor(message: string, { status, requestType, correlationId, details, code = 'api_error', cause }: ApiErrorOptions = {}) {
    super(message, { code, cause })
    this.status = status
    this.requestType = requestType
    this.correlationId = correlationId
    this.details = details
  }
}

export class BadRequestError extends ApiError {
  override name = 'BadRequestError'

  constructor(message: string, opts: ApiErrorOptions = {}) {
    super(message, { code: 'bad_request', ...opts })
  }
}

export class AuthenticationError extends ApiError {
  override name = 'AuthenticationError'

  constructor(message = 'Invalid API key', opts: ApiErrorOptions = {}) {
    super(message, { code: 'unauthenticated', ...opts })
  }
}

export class PermissionError extends ApiError {
  override name = 'PermissionError'

  constructor(message = 'Permission denied', opts: ApiErrorOptions = {}) {
    super(message, { code: 'permission_denied', ...opts })
  }
}

export class NotFoundError extends ApiError {
  override name = 'NotFoundError'

  constructor(message = 'Not found', opts: ApiErrorOptions = {}) {
    super(message, { code: 'not_found', ...opts })
  }

  /** e.g. `perpSnapshots` answers 404 until the first snapshot exists. */
  override get retryable(): boolean {
    return true
  }
}

export interface RateLimitErrorOptions extends ApiErrorOptions {
  /** How long to wait before retrying, ms, if the server (or local limiter) said. */
  retryAfterMs?: number
  /** Weight points left in the bucket. */
  remaining?: number
  /** Weight points the rejected request needed. */
  required?: number
  /** Bucket capacity. */
  limit?: number
}

export class RateLimitError extends ApiError {
  override name = 'RateLimitError'
  readonly retryAfterMs: number | undefined
  readonly remaining: number | undefined
  readonly required: number | undefined
  readonly limit: number | undefined

  constructor(message = 'Rate limit exceeded', { retryAfterMs, remaining, required, limit, ...opts }: RateLimitErrorOptions = {}) {
    super(message, { code: 'rate_limited', status: 429, ...opts })
    this.retryAfterMs = retryAfterMs
    this.remaining = remaining
    this.required = required
    this.limit = limit
  }

  override get retryable(): boolean {
    return true
  }
}

export class ServerError extends ApiError {
  override name = 'ServerError'

  constructor(message = 'Server error', opts: ApiErrorOptions = {}) {
    super(message, { code: 'server_error', ...opts })
  }

  override get retryable(): boolean {
    return true
  }
}

export interface SubscriptionErrorOptions extends ApiErrorOptions {
  subscription?: unknown
  requestId?: string
}

/** The server rejected a subscribe request. The subscription stays inactive until the next reconnect. */
export class SubscriptionError extends ApiError {
  override name = 'SubscriptionError'
  readonly subscription: unknown
  readonly requestId: string | undefined

  constructor(message: string, { subscription, requestId, ...opts }: SubscriptionErrorOptions = {}) {
    super(message, { code: 'subscription_failed', ...opts })
    this.subscription = subscription
    this.requestId = requestId
  }
}

export class NetworkError extends HydromancerError {
  override name = 'NetworkError'

  constructor(message = 'Network error', opts: HydromancerErrorOptions = {}) {
    super(message, { code: 'network_error', ...opts })
  }

  override get retryable(): boolean {
    return true
  }
}

export class RequestTimeoutError extends HydromancerError {
  override name = 'RequestTimeoutError'
  readonly timeoutMs: number

  constructor(timeoutMs: number, what = 'Request') {
    super(`${what} timed out after ${timeoutMs}ms`, { code: 'timeout' })
    this.timeoutMs = timeoutMs
  }

  override get retryable(): boolean {
    return true
  }
}

export class DecodeError extends HydromancerError {
  override name = 'DecodeError'

  constructor(message: string, opts: HydromancerErrorOptions = {}) {
    super(message, { code: 'decode_error', ...opts })
  }
}

/** True for the `AbortError` a cancelled `fetch` or `AbortSignal` produces. Aborts are not errors to report. */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError'
}

/** Wraps anything thrown into a `HydromancerError`, keeping it as `cause`. */
export function toHydromancerError(err: unknown): HydromancerError {
  if (err instanceof HydromancerError) return err
  if (err instanceof Error) return new HydromancerError(err.message, { cause: err })
  return new HydromancerError(String(err), { cause: err })
}

const nonEmpty = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const finiteOrUndef = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Maps an HTTP error status and body (`{ error, code?, message?, retryAfterSecs?, … }`)
 * to the matching error class.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  { requestType, retryAfterMs }: { requestType?: string; retryAfterMs?: number } = {},
): ApiError {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const serverMessage = nonEmpty(b.message) ?? nonEmpty(b.error) ?? (typeof body === 'string' ? nonEmpty(body.trim()) : undefined)
  const message = `${requestType ? `${requestType}: ` : ''}${serverMessage ?? `HTTP ${status}`}`
  const opts: ApiErrorOptions = {
    status,
    requestType,
    correlationId: nonEmpty(b.correlationId),
    details: b.details,
    ...(nonEmpty(b.code) ? { code: nonEmpty(b.code) } : {}),
  }
  if (status === 400) return new BadRequestError(message, opts)
  if (status === 401) return new AuthenticationError(message, opts)
  if (status === 403) return new PermissionError(message, opts)
  if (status === 404) return new NotFoundError(message, opts)
  if (status === 429) {
    const bodyRetry = finiteOrUndef(b.retryAfterSecs)
    return new RateLimitError(message, {
      ...opts,
      // The header wins; the body is the documented fallback.
      retryAfterMs: retryAfterMs ?? (bodyRetry === undefined ? undefined : bodyRetry * 1000),
      remaining: finiteOrUndef(b.remaining),
      required: finiteOrUndef(b.required),
    })
  }
  if (status >= 500) return new ServerError(message, opts)
  return new ApiError(message, opts)
}
