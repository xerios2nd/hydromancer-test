// Transport for `POST /info`: auth, timeouts, error mapping, retries that
// honour `Retry-After`, rate-limit headers and client-side window limits.
// https://docs.hydromancer.xyz/readme/rest-api
// https://docs.hydromancer.xyz/readme/rest-api/rate-limits-and-user-limits

import { DecodeError, errorFromResponse, HydromancerError, isAbortError, NetworkError, RateLimitError, RequestTimeoutError, ServerError } from '../errors'
import { backoffDelay, joinUrl, sleep } from '../util'
import { DEFAULT_WINDOW_LIMITS, WindowLimiter } from './limiter'
import type { WindowLimit } from './limiter'

/** Mainnet API origin. REST lives at `<base>/info`, the WebSocket at `<base>/ws`. */
export const DEFAULT_BASE_URL = 'https://api.hydromancer.xyz'
export const DEFAULT_REST_URL = joinUrl(DEFAULT_BASE_URL, 'info')

/** Request body: a `type` plus that request's parameters. */
export type InfoRequest = { type: string } & Record<string, unknown>

/** `X-RateLimit-*` headers of the last response that had them. */
export interface RateLimitInfo {
  /** Bucket capacity, weight points. */
  limit: number
  /** Points left after this request. A snapshot, not a reservation. */
  remaining: number
  /** Seconds until all recorded usage expires. */
  resetSecs: number
  /** Points this request cost. */
  cost: number
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number
  minDelayMs: number
  maxDelayMs: number
  /**
   * A 429 asking to wait longer than this fails straight away with a
   * {@link RateLimitError} (carrying `retryAfterMs`) instead of blocking.
   */
  maxRetryAfterMs: number
}

export interface RestClientOptions {
  /**
   * API origin or proxy prefix; requests go to `<baseUrl>/info`. Defaults to
   * {@link DEFAULT_BASE_URL}.
   */
  baseUrl?: string
  /** Full `POST /info` URL, if it isn't `<baseUrl>/info`. Overrides `baseUrl`. */
  url?: string
  /**
   * Sent as `Authorization: Bearer <key>`. Leave unset when a proxy adds it.
   */
  apiKey?: string
  fetch?: typeof fetch
  /** Per attempt, including reading the body. */
  timeoutMs?: number
  retry?: Partial<RetryOptions>
  /** Client-side windowed limits by request type. Merged over {@link DEFAULT_WINDOW_LIMITS}; `null` removes one. */
  windowLimits?: Record<string, WindowLimit | null>
  /** Longest a request waits for a window allowance before failing with {@link RateLimitError}. */
  maxWindowWaitMs?: number
  /** Every response, e.g. to sync a clock from its `Date` header. `sentAt`/`receivedAt` are `Date.now()` readings. */
  onResponse?: (response: Response, timing: { sentAt: number; receivedAt: number }) => void
}

export interface RequestOptions {
  signal?: AbortSignal
  /** Overrides the client's retry count for this request. */
  retries?: number
  timeoutMs?: number
}

export interface BinaryResponse {
  bytes: Uint8Array
  headers: Headers
}

const DEFAULT_RETRY: RetryOptions = { retries: 2, minDelayMs: 500, maxDelayMs: 8_000, maxRetryAfterMs: 15_000 }

/** Errors worth retrying unchanged: transport trouble, throttling and 5xx. 4xx needs a different request. */
const isTransient = (err: unknown) =>
  err instanceof NetworkError || err instanceof RequestTimeoutError || err instanceof RateLimitError || err instanceof ServerError

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function parseRateLimitHeaders(h: Headers): RateLimitInfo | undefined {
  const limit = h.get('X-RateLimit-Limit')
  const remaining = h.get('X-RateLimit-Remaining')
  if (limit === null || remaining === null) return undefined
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    resetSecs: Number(h.get('X-RateLimit-Reset') ?? 0),
    cost: Number(h.get('X-RateLimit-Cost') ?? 0),
  }
}

export class RestClient {
  readonly url: string
  readonly #apiKey: string | undefined
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #retry: RetryOptions
  readonly #maxWindowWaitMs: number
  readonly #onResponse: RestClientOptions['onResponse']
  readonly #limiters = new Map<string, WindowLimiter>()
  #rateLimit: RateLimitInfo | undefined

  constructor({
    baseUrl = DEFAULT_BASE_URL,
    url = joinUrl(baseUrl, 'info'),
    apiKey,
    fetch: f,
    timeoutMs = 30_000,
    retry,
    windowLimits,
    maxWindowWaitMs = 60_000,
    onResponse,
  }: RestClientOptions = {}) {
    this.url = resolveHttpUrl(url)
    this.#apiKey = apiKey || undefined
    // Bound, so a bare `window.fetch` reference doesn't lose its receiver.
    this.#fetch = f ?? ((input, init) => globalThis.fetch(input, init))
    this.#timeoutMs = timeoutMs
    this.#retry = { ...DEFAULT_RETRY, ...retry }
    this.#maxWindowWaitMs = maxWindowWaitMs
    this.#onResponse = onResponse
    const limits = { ...DEFAULT_WINDOW_LIMITS, ...windowLimits }
    for (const [type, limit] of Object.entries(limits)) if (limit) this.#limiters.set(type, new WindowLimiter(limit))
  }

  /** Rate-limit headers of the latest response that carried them. */
  get rateLimit(): RateLimitInfo | undefined {
    return this.#rateLimit
  }

  /** POSTs `body` and parses the JSON response. */
  async json(body: InfoRequest, opts: RequestOptions = {}): Promise<unknown> {
    const { bytes } = await this.#request(body, opts)
    const text = new TextDecoder().decode(bytes)
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new DecodeError(`${body.type}: response is not JSON`, { cause: err })
    }
  }

  /** POSTs `body` and returns the raw response bytes and headers (binary endpoints). */
  bytes(body: InfoRequest, opts: RequestOptions = {}): Promise<BinaryResponse> {
    return this.#request(body, opts)
  }

  async #request(body: InfoRequest, { signal, retries = this.#retry.retries, timeoutMs = this.#timeoutMs }: RequestOptions, attempt = 0): Promise<BinaryResponse> {
    await this.#limiters.get(body.type)?.acquire(body.type, { signal, maxWaitMs: this.#maxWindowWaitMs })
    try {
      return await this.#attempt(body, signal, timeoutMs)
    } catch (err) {
      if (signal?.aborted || !isTransient(err) || attempt >= retries) throw err
      const retryAfter = err instanceof RateLimitError ? err.retryAfterMs : undefined
      if (retryAfter !== undefined && retryAfter > this.#retry.maxRetryAfterMs) throw err
      // Positive jitter on top of `Retry-After`, as the docs suggest.
      const delay =
        retryAfter === undefined ? backoffDelay(attempt, { minMs: this.#retry.minDelayMs, maxMs: this.#retry.maxDelayMs }) : retryAfter + Math.random() * 250
      await sleep(delay, signal)
      return this.#request(body, { signal, retries, timeoutMs }, attempt + 1)
    }
  }

  async #attempt(body: InfoRequest, signal: AbortSignal | undefined, timeoutMs: number): Promise<BinaryResponse> {
    // An already-aborted signal never fires `abort` again.
    signal?.throwIfAborted()
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`
    const sentAt = Date.now()
    try {
      const res = await this.#fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
      const bytes = new Uint8Array(await res.arrayBuffer())
      this.#onResponse?.(res, { sentAt, receivedAt: Date.now() })
      const rl = parseRateLimitHeaders(res.headers)
      if (rl) this.#rateLimit = rl
      if (!res.ok) {
        const text = new TextDecoder().decode(bytes)
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          // Plain-text error body; keep the text.
        }
        throw errorFromResponse(res.status, parsed, { requestType: body.type, retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')) })
      }
      return { bytes, headers: res.headers }
    } catch (err) {
      if (err instanceof HydromancerError) throw err
      if (timedOut) throw new RequestTimeoutError(timeoutMs, body.type)
      if (signal?.aborted || isAbortError(err)) throw signal?.reason ?? err
      throw new NetworkError(`${body.type}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** Same-origin paths become absolute in a browser; Node's `fetch` needs absolute URLs anyway. */
function resolveHttpUrl(url: string): string {
  const base = globalThis.location?.href
  return base ? new URL(url, base).href : url
}
