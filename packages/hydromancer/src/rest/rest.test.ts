import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  DecodeError,
  errorFromResponse,
  NetworkError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
} from '../errors'
import { fakeFetch, json, wireCandle } from '../test/fakes'
import { RestClient } from './client'
import { CANDLE_SNAPSHOT_LIMIT, InfoApi } from './info'
import { WindowLimiter } from './limiter'

describe('errorFromResponse', () => {
  it.each([
    [400, BadRequestError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, NotFoundError],
    [429, RateLimitError],
    [500, ServerError],
    [502, ServerError],
    [418, ApiError],
  ])('maps %i', (status, cls) => {
    const err = errorFromResponse(status, { error: 'nope' }, { requestType: 'x' })
    expect(err).toBeInstanceOf(cls)
    expect(err.status).toBe(status)
    expect(err.message).toBe('x: nope')
  })

  it('reads the 429 body, preferring the Retry-After header', () => {
    const body = { error: 'Rate limit exceeded', code: 'rate_limited', retryAfterSecs: 7, remaining: 3, required: 20, correlationId: 'abc' }
    const fromBody = errorFromResponse(429, body) as RateLimitError
    expect(fromBody).toMatchObject({ retryAfterMs: 7000, remaining: 3, required: 20, correlationId: 'abc', code: 'rate_limited' })
    expect((errorFromResponse(429, body, { retryAfterMs: 2000 }) as RateLimitError).retryAfterMs).toBe(2000)
  })

  it('marks only transient errors retryable', () => {
    expect(errorFromResponse(503, {}).retryable).toBe(true)
    expect(errorFromResponse(429, {}).retryable).toBe(true)
    expect(errorFromResponse(401, {}).retryable).toBe(false)
    expect(errorFromResponse(400, {}).retryable).toBe(false)
  })
})

describe('RestClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts JSON with the Bearer key and reads rate-limit headers', async () => {
    const f = fakeFetch(() =>
      json([1], { headers: { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': '4980', 'X-RateLimit-Reset': '60', 'X-RateLimit-Cost': '20' } }),
    )
    const client = new RestClient({ url: 'https://x/info', apiKey: 'k', fetch: f.fetch })
    expect(await client.json({ type: 'apiUsage' })).toEqual([1])
    expect(f.headers[0]!.get('Authorization')).toBe('Bearer k')
    expect(f.headers[0]!.get('Content-Type')).toBe('application/json')
    expect(client.rateLimit).toEqual({ limit: 5000, remaining: 4980, resetSecs: 60, cost: 20 })
  })

  it('sends no Authorization header without a key (proxy mode)', async () => {
    const f = fakeFetch(() => json({}))
    await new RestClient({ fetch: f.fetch }).json({ type: 'x' })
    expect(f.headers[0]!.has('Authorization')).toBe(false)
  })

  it('retries 5xx with backoff, then succeeds', async () => {
    let n = 0
    const f = fakeFetch(() => (n++ < 2 ? json({ error: 'Timeout error' }, { status: 502 }) : json('ok')))
    const p = new RestClient({ fetch: f.fetch }).json({ type: 'x' })
    await vi.runAllTimersAsync()
    expect(await p).toBe('ok')
    expect(f.calls).toHaveLength(3)
  })

  it('waits Retry-After on 429 before retrying', async () => {
    let n = 0
    const f = fakeFetch(() => (n++ === 0 ? json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '3' } }) : json('ok')))
    const p = new RestClient({ fetch: f.fetch }).json({ type: 'x' })
    await vi.advanceTimersByTimeAsync(2_900)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(await p).toBe('ok')
  })

  it('fails fast when Retry-After is longer than maxRetryAfterMs', async () => {
    const f = fakeFetch(() => json({ error: 'slow down' }, { status: 429, headers: { 'Retry-After': '120' } }))
    const err = await new RestClient({ fetch: f.fetch }).json({ type: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfterMs).toBe(120_000)
    expect(f.calls).toHaveLength(1)
  })

  it('does not retry client errors', async () => {
    const f = fakeFetch(() => json({ error: 'Invalid API key' }, { status: 401 }))
    await expect(new RestClient({ fetch: f.fetch }).json({ type: 'x' })).rejects.toBeInstanceOf(AuthenticationError)
    expect(f.calls).toHaveLength(1)
  })

  it('maps fetch failures to NetworkError and timeouts to RequestTimeoutError', async () => {
    const failing = new RestClient({ fetch: async () => Promise.reject(new TypeError('fetch failed')), retry: { retries: 0 } })
    await expect(failing.json({ type: 'x' })).rejects.toBeInstanceOf(NetworkError)

    const hanging = new RestClient({
      timeoutMs: 1000,
      retry: { retries: 0 },
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    })
    const p = hanging.json({ type: 'x' }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toBeInstanceOf(RequestTimeoutError)
  })

  it('rejects with the abort reason, not a library error, when the caller aborts', async () => {
    const ctrl = new AbortController()
    const client = new RestClient({
      fetch: (_url, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    })
    const p = client.json({ type: 'x' }, { signal: ctrl.signal }).catch((e: unknown) => e)
    ctrl.abort()
    expect(((await p) as Error).name).toBe('AbortError')
  })

  it('throws DecodeError for a non-JSON body', async () => {
    const f = fakeFetch(() => new Response('<html>'))
    await expect(new RestClient({ fetch: f.fetch }).json({ type: 'x' })).rejects.toBeInstanceOf(DecodeError)
  })

  it('applies client-side window limits per request type', async () => {
    const f = fakeFetch(() => json({}))
    const client = new RestClient({ fetch: f.fetch, windowLimits: { tpslBook: { limit: 2, windowMs: 60_000 } }, maxWindowWaitMs: 10_000 })
    await client.json({ type: 'tpslBook' })
    await client.json({ type: 'tpslBook' })
    const err = await client.json({ type: 'tpslBook' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).code).toBe('local_rate_limit')
    expect(f.calls).toHaveLength(2)
    // Other types are unaffected.
    await client.json({ type: 'candleSnapshot' })
    expect(f.calls).toHaveLength(3)
  })
})

describe('WindowLimiter', () => {
  it('waits for the oldest request to leave the window', async () => {
    let now = 0
    const l = new WindowLimiter({ limit: 2, windowMs: 1000 }, () => now)
    await l.acquire('x')
    now = 100
    await l.acquire('x')
    expect(l.waitTime()).toBe(900)
    now = 1000
    expect(l.waitTime()).toBe(0)
  })
})

describe('InfoApi', () => {
  it('parses candleSnapshot strings into numbers, keeping null quote volume as undefined', async () => {
    const f = fakeFetch(() => json([{ ...wireCandle(60_000), q: null }, wireCandle(0)]))
    const info = new InfoApi(new RestClient({ fetch: f.fetch }))
    const candles = await info.candleSnapshot({ coin: 'BTC', interval: '1m', startTime: 0, endTime: 120_000 })
    expect(f.calls[0]).toEqual({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: 0, endTime: 120_000, limit: CANDLE_SNAPSHOT_LIMIT } })
    expect(candles.map((c) => c.t)).toEqual([0, 60_000])
    expect(candles[0]).toEqual({ t: 0, T: 59_999, o: 100, h: 101, l: 99, c: 100, v: 1.5, q: 150, n: 1, x: true })
    expect(candles[1]!.q).toBeUndefined()
  })

  it('pages through ranges longer than one response', async () => {
    const all = Array.from({ length: CANDLE_SNAPSHOT_LIMIT + 10 }, (_, i) => wireCandle(i * 60_000))
    // Behaves like an API that returns the newest `limit` candles of the range.
    const f = fakeFetch((body) => {
      const { startTime, endTime } = body.req as { startTime: number; endTime: number }
      return json(all.filter((c) => c.t >= startTime && c.t < endTime).slice(-CANDLE_SNAPSHOT_LIMIT))
    })
    const info = new InfoApi(new RestClient({ fetch: f.fetch }))
    const candles = await info.candles({ coin: 'BTC', interval: '1m', startTime: 0, endTime: all.length * 60_000 })
    expect(candles).toHaveLength(all.length)
    expect(candles.every((c, i) => c.t === i * 60_000)).toBe(true)
  })

  it('parses perpSnapshotTimestamp seconds into ms', async () => {
    const f = fakeFetch(() => json({ snapshot_id: '20240915_state_1', timestamp: 1_694_764_800 }))
    const info = new InfoApi(new RestClient({ fetch: f.fetch }))
    expect(await info.perpSnapshotTimestamp()).toEqual({ snapshotId: '20240915_state_1', timestamp: 1_694_764_800_000 })
  })

  it('validateApiKey resolves for a good key and throws AuthenticationError for a bad one', async () => {
    const ok = new InfoApi(new RestClient({ fetch: fakeFetch(() => json([])).fetch }))
    await expect(ok.validateApiKey()).resolves.toBeUndefined()
    const bad = new InfoApi(new RestClient({ fetch: fakeFetch(() => json({ error: 'Invalid API key' }, { status: 401 })).fetch }))
    await expect(bad.validateApiKey()).rejects.toBeInstanceOf(AuthenticationError)
  })
})
