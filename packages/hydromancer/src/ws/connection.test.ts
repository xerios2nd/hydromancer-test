import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthenticationError, NetworkError, SubscriptionError } from '../errors'
import type { HydromancerError } from '../errors'
import { createFakeWebSocket, FakeWebSocket } from '../test/fakes'
import { Connection } from './connection'
import type { ConnectionStatus } from './connection'
import type { DataFrame } from './protocol'

const candleSub = { type: 'candle', coin: 'BTC', interval: '1m' } as const

function setup(opts: { apiKey?: string } = {}) {
  const statuses: ConnectionStatus[] = []
  const errors: HydromancerError[] = []
  const conn = new Connection({
    url: 'wss://example.test/ws',
    createWebSocket: createFakeWebSocket,
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    ...opts,
  })
  return { conn, statuses, errors }
}

function handler() {
  const frames: DataFrame[] = []
  const errors: SubscriptionError[] = []
  let active = 0
  return {
    frames,
    errors,
    get active() {
      return active
    },
    onActive: () => active++,
    onData: (f: DataFrame) => frames.push(f),
    onError: (e: SubscriptionError) => errors.push(e),
  }
}

/** Acknowledges the latest subscribe request. */
function ack(ws: FakeWebSocket, extra: Record<string, unknown> = {}) {
  const req = ws.sentOfMethod('subscribe').at(-1)!
  ws.receive({
    type: 'subscriptionUpdate',
    requestId: req.requestId,
    operation: 'subscribe',
    subscription: req.subscription,
    subscribed: ['candle'],
    failed: [],
    ...extra,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Connection', () => {
  it('adds the token to the URL and goes open on `connected`', () => {
    const { conn, statuses } = setup({ apiKey: 'secret key' })
    conn.connect()
    expect(FakeWebSocket.last.url).toBe('wss://example.test/ws?token=secret+key')
    FakeWebSocket.last.open()
    expect(conn.status).toBe('connecting')
    FakeWebSocket.last.receive({ type: 'connected', clientId: 'c', sessionId: 'sess' })
    expect(statuses).toEqual(['connecting', 'open'])
    expect(conn.sessionId).toBe('sess')
  })

  it('subscribes only after the handshake, and activates on the matching ack', () => {
    const { conn } = setup()
    const h = handler()
    conn.subscribe(candleSub, h)
    conn.connect()
    const ws = FakeWebSocket.last
    ws.open()
    expect(ws.sent).toEqual([])
    ws.receive({ type: 'connected' })
    const [req] = ws.sentOfMethod('subscribe')
    expect(req).toMatchObject({ subscription: candleSub, requestId: expect.any(String) })
    // An ack for some other request changes nothing.
    ws.receive({ type: 'subscriptionUpdate', requestId: 'other', failed: [] })
    expect(h.active).toBe(0)
    ack(ws)
    expect(h.active).toBe(1)
  })

  it('carries on without `connected` after the handshake timeout', () => {
    const { conn } = setup()
    conn.subscribe(candleSub, handler())
    conn.connect()
    FakeWebSocket.last.open()
    vi.advanceTimersByTime(3_000)
    expect(conn.status).toBe('open')
    expect(FakeWebSocket.last.sentOfMethod('subscribe')).toHaveLength(1)
  })

  it('treats a missing ack as success after the ack timeout', () => {
    const { conn } = setup()
    const h = handler()
    conn.subscribe(candleSub, h)
    conn.connect()
    FakeWebSocket.last.handshake()
    vi.advanceTimersByTime(10_000)
    expect(h.active).toBe(1)
  })

  it('answers pings with pongs', () => {
    const { conn } = setup()
    conn.connect()
    FakeWebSocket.last.handshake()
    FakeWebSocket.last.receive({ type: 'ping' })
    expect(FakeWebSocket.last.sent).toContainEqual({ type: 'pong' })
  })

  it('routes data frames by channel', () => {
    const { conn } = setup()
    const candles = handler()
    const books = handler()
    conn.subscribe(candleSub, candles)
    conn.subscribe({ type: 'l2Book', coins: ['BTC'] }, books)
    conn.connect()
    FakeWebSocket.last.handshake()
    FakeWebSocket.last.receive({ type: 'candle', channel: 'candle', seq: 1, cursor: '0', data: { s: 'BTC' } })
    expect(candles.frames).toHaveLength(1)
    expect(candles.frames[0]).toMatchObject({ channel: 'candle', seq: 1, data: { s: 'BTC' } })
    expect(books.frames).toHaveLength(0)
  })

  it('shares one server subscription between identical subscriptions', async () => {
    const { conn } = setup()
    conn.connect()
    const ws = FakeWebSocket.last
    ws.handshake()
    const a = handler()
    const b = handler()
    const offA = conn.subscribe(candleSub, a)
    ack(ws)
    // Key order doesn't matter.
    const offB = conn.subscribe({ interval: '1m', coin: 'BTC', type: 'candle' }, b)
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.sentOfMethod('subscribe')).toHaveLength(1)
    // A late joiner is told the subscription is live, so it can backfill.
    expect(b.active).toBe(1)
    offA()
    expect(ws.sentOfMethod('unsubscribe')).toHaveLength(0)
    offB()
    expect(ws.sentOfMethod('unsubscribe')).toEqual([{ method: 'unsubscribe', subscription: candleSub }])
  })

  it('reconnects with backoff, resubscribes and re-activates', () => {
    const { conn, statuses, errors } = setup()
    const h = handler()
    conn.subscribe(candleSub, h)
    conn.connect()
    FakeWebSocket.last.handshake()
    ack(FakeWebSocket.last)
    FakeWebSocket.last.drop()
    expect(conn.status).toBe('reconnecting')
    expect(errors[0]).toBeInstanceOf(NetworkError)
    vi.advanceTimersByTime(1_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.last.handshake()
    ack(FakeWebSocket.last)
    expect(h.active).toBe(2)
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open'])
  })

  it('reconnects when nothing arrives for the idle timeout', () => {
    const { conn } = setup()
    conn.connect()
    FakeWebSocket.last.handshake()
    vi.advanceTimersByTime(90_000)
    expect(conn.status).toBe('reconnecting')
  })

  it('reports a rejected subscription to its handlers as SubscriptionError', () => {
    const { conn } = setup()
    const h = handler()
    conn.subscribe(candleSub, h)
    conn.connect()
    const ws = FakeWebSocket.last
    ws.handshake()
    const req = ws.sentOfMethod('subscribe')[0]!
    ws.receive({
      type: 'error',
      requestId: req.requestId,
      operation: 'subscribe',
      code: 'invalid_interval',
      message: 'Invalid interval',
      subscription: candleSub,
    })
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toBeInstanceOf(SubscriptionError)
    expect(h.errors[0]).toMatchObject({ code: 'invalid_interval', requestId: req.requestId })
    expect(h.active).toBe(0)
    // Not transient, so not retried.
    vi.advanceTimersByTime(60_000)
    expect(ws.sentOfMethod('subscribe')).toHaveLength(1)
  })

  it('retries a subscription the server asks to resubscribe', () => {
    const { conn } = setup()
    const h = handler()
    conn.subscribe({ type: 'l2Book', coins: ['BTC'] }, h)
    conn.connect()
    const ws = FakeWebSocket.last
    ws.handshake()
    const req = ws.sentOfMethod('subscribe')[0]!
    ws.receive({ type: 'error', requestId: req.requestId, message: 'l2Book snapshot not ready, please resubscribe' })
    vi.advanceTimersByTime(2_000)
    expect(ws.sentOfMethod('subscribe')).toHaveLength(2)
  })

  it('stops reconnecting after an authentication error', () => {
    const { conn, errors } = setup()
    conn.connect()
    FakeWebSocket.last.handshake()
    FakeWebSocket.last.receive({ type: 'error', message: 'Invalid API key' })
    expect(conn.status).toBe('failed')
    expect(errors.at(-1)).toBeInstanceOf(AuthenticationError)
    vi.advanceTimersByTime(120_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('pauses outbound messages after message_rate_limit', () => {
    const { conn } = setup()
    conn.connect()
    const ws = FakeWebSocket.last
    ws.handshake()
    ws.receive({
      type: 'error',
      code: 'message_rate_limit',
      message: 'Message rate limit exceeded (300/300 messages per 60 seconds)',
      details: { retryAfterSecs: 5 },
    })
    conn.subscribe(candleSub, handler())
    expect(ws.sentOfMethod('subscribe')).toHaveLength(0)
    vi.advanceTimersByTime(5_000)
    expect(ws.sentOfMethod('subscribe')).toHaveLength(1)
  })

  it('close() stops everything', () => {
    const { conn } = setup()
    conn.connect()
    FakeWebSocket.last.handshake()
    conn.close()
    expect(conn.status).toBe('closed')
    vi.advanceTimersByTime(120_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
