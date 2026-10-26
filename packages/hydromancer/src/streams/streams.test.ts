import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryCache } from '../cache/store'
import { NotFoundError } from '../errors'
import type { HydromancerError } from '../errors'
import { Hydromancer } from '../hydromancer'
import { binary, createFakeWebSocket, FakeWebSocket, fakeFetch, frame, json, msgpack, wireCandle, zstd } from '../test/fakes'
import type { FetchRoute } from '../test/fakes'
import type { Candle } from '../types'

const MIN = 60_000
/** A minute boundary well after the 1000-candle chunk boundary at 0. */
const NOW = 1_000_000 * MIN

function setup(route: FetchRoute, { cache = new MemoryCache(), now = () => NOW } = {}) {
  const f = fakeFetch(route)
  const hm = new Hydromancer({ restUrl: 'https://x/info', wsUrl: 'wss://x/ws', fetch: f.fetch, createWebSocket: createFakeWebSocket, cache, now })
  return { hm, f, cache }
}

/** Serves `candleSnapshot` from a function of the requested range. */
const candleRoute =
  (candles: (start: number, end: number) => unknown[]): FetchRoute =>
  (body) => {
    const { startTime, endTime } = body.req as { startTime: number; endTime: number }
    return json(candles(startTime, endTime))
  }

const minutes = (start: number, end: number) => {
  const out = []
  for (let t = Math.ceil(start / MIN) * MIN; t < end; t += MIN) out.push(wireCandle(t))
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CandleHistory', () => {
  it('serves final chunks from the cache on the next load, and never caches the open tail', async () => {
    const { hm, f } = setup(candleRoute(minutes))
    const range = { coin: 'BTC', interval: '1m' as const, startTime: NOW - 1500 * MIN, endTime: NOW + MIN }
    const first = await hm.loadCandles(range)
    expect(first).toHaveLength(1501)
    const fetched = f.calls.length
    const second = await hm.loadCandles(range)
    expect(second).toEqual(first)
    // Only the still-open chunk is fetched again.
    expect(f.calls.length).toBe(fetched + 1)
    const last = f.calls.at(-1)!.req as { startTime: number }
    expect(last.startTime).toBe(NOW - 1000 * MIN)
  })

  it('returns only the requested range even when whole chunks are fetched', async () => {
    const { hm } = setup(candleRoute(minutes))
    const out = await hm.loadCandles({ coin: 'BTC', interval: '1m', startTime: NOW - 5000 * MIN, endTime: NOW - 4990 * MIN })
    expect(out.map((c) => c.t)).toEqual(Array.from({ length: 10 }, (_, i) => NOW - (5000 - i) * MIN))
  })
})

describe('streamCandles', () => {
  it('loads history at once, delivers live candles, and backfills on a seq gap', async () => {
    const { hm, f } = setup(candleRoute(minutes))
    const got: [Candle[], string][] = []
    const stream = hm.streamCandles({ coin: 'BTC', interval: '1m', history: 10, onCandles: (c, src) => got.push([c, src]) })
    hm.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(got[0]![1]).toBe('history')
    expect(got[0]![0]).toHaveLength(11)

    const ws = FakeWebSocket.last
    ws.handshake()
    const req = ws.sentOfMethod('subscribe')[0]!
    expect(req.subscription).toEqual({ type: 'candle', coin: 'BTC', interval: '1m' })
    ws.receive({ type: 'subscriptionUpdate', requestId: req.requestId, failed: [] })
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterActive = f.callsOfType('candleSnapshot').length

    ws.receive({ type: 'candle', channel: 'candle', seq: 1, data: wireCandle(NOW, { x: false, n: 5 }) })
    // Another market on the same channel is ignored.
    ws.receive({ type: 'candle', channel: 'candle', seq: 1, data: wireCandle(NOW, { coin: 'ETH' }) })
    expect(got.at(-1)).toEqual([[expect.objectContaining({ t: NOW, n: 5, x: false })], 'live'])
    expect(stream.newest).toBe(NOW)

    ws.receive({ type: 'candle', channel: 'candle', seq: 3, data: wireCandle(NOW, { x: false, n: 6 }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.callsOfType('candleSnapshot').length).toBe(callsAfterActive + 1)
    // The backfill resumes at the newest candle instead of reloading everything.
    expect((f.callsOfType('candleSnapshot').at(-1)!.req as { startTime: number }).startTime).toBe(NOW)
    stream.stop()
    expect(ws.sentOfMethod('unsubscribe')).toHaveLength(1)
  })

  it('reports backfill errors and retries', async () => {
    let fail = true
    const { hm } = setup((body) => (fail ? json({ error: 'Invalid interval' }, { status: 400 }) : candleRoute(minutes)(body, {})))
    const errors: (HydromancerError | undefined)[] = []
    hm.streamCandles({ coin: 'BTC', interval: '1m', history: 2, onCandles: () => {}, onError: (e) => errors.push(e) })
    await vi.advanceTimersByTimeAsync(0)
    expect(errors[0]?.name).toBe('BadRequestError')
    fail = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(errors.at(-1)).toBeUndefined()
  })
})

/** `tpslBook` response with the given orders at `height`. */
function tpslBook(height: number, orders: [oid: number, type: string][]) {
  const tuples = orders.map(([oid, type]) => [oid, 'BTC', '0xu', 'A', '100', '99', '1', 'Price below 100', type, true, true, 1])
  const blob = zstd(msgpack(['BTC', tuples]))
  return binary(frame([{ u32: 1 }, { u64: height }, { u64: 0 }, { u32: blob.length }, blob]))
}

const addDiff = (oid: number, orderType = 'Stop Market') => ({
  type: 'add',
  oid,
  coin: 'BTC',
  user: '0xu',
  side: 'B',
  triggerPx: '90',
  limitPx: '89',
  sz: '2',
  triggerCondition: 'x',
  orderType,
  isPositionTpsl: false,
  reduceOnly: true,
  timestamp: 1,
})

describe('mirrorTpsl', () => {
  it('replays only buffered updates newer than the snapshot height', async () => {
    let resolveBook!: (r: Response) => void
    const { hm } = setup((body) => (body.type === 'tpslBook' ? new Promise<Response>((r) => (resolveBook = r)) : json([])))
    const mirror = hm.mirrorTpsl({ coin: 'BTC' })
    hm.connect()
    const ws = FakeWebSocket.last
    ws.handshake()
    vi.advanceTimersByTime(10_000) // ack timeout → active → snapshot requested
    await vi.advanceTimersByTimeAsync(0)
    expect(mirror.ready).toBe(false)

    // Arrive while the snapshot is in flight.
    ws.receive({ type: 'tpslUpdates', channel: 'tpslUpdates', seq: 1, data: { height: 100, timestamp: 0, diffs: [addDiff(50)] } })
    ws.receive({
      type: 'tpslUpdates',
      channel: 'tpslUpdates',
      seq: 2,
      data: { height: 101, timestamp: 0, diffs: [addDiff(51), { type: 'remove', oid: 1, coin: 'BTC' }] },
    })
    resolveBook(
      tpslBook(100, [
        [1, 'Stop Market'],
        [2, 'Take Profit Market'],
      ]),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(mirror.ready).toBe(true)
    expect(mirror.height).toBe(101)
    // 50 is at the snapshot height (already included); 51 is newer; 1 was removed.
    expect(new Set([...mirror.orders()].map((o) => o.oid))).toEqual(new Set([2, 51]))

    ws.receive({ type: 'tpslUpdates', channel: 'tpslUpdates', seq: 3, data: { height: 102, timestamp: 0, diffs: [{ type: 'remove', oid: 2, coin: 'BTC' }] } })
    expect(mirror.size).toBe(1)
    mirror.stop()
  })

  it('resyncs from a new snapshot when seq skips, respecting the minimum interval', async () => {
    const { hm, f } = setup((body) => (body.type === 'tpslBook' ? tpslBook(10, [[1, 'Stop Market']]) : json([])))
    const mirror = hm.mirrorTpsl({ coin: 'BTC', minSnapshotIntervalMs: 30_000 })
    hm.connect()
    const ws = FakeWebSocket.last
    ws.handshake()
    vi.advanceTimersByTime(10_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.callsOfType('tpslBook')).toHaveLength(1)
    ws.receive({ type: 'tpslUpdates', channel: 'tpslUpdates', seq: 1, data: { height: 11, timestamp: 0, diffs: [] } })
    ws.receive({ type: 'tpslUpdates', channel: 'tpslUpdates', seq: 5, data: { height: 15, timestamp: 0, diffs: [] } })
    expect(mirror.synced).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.callsOfType('tpslBook')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.callsOfType('tpslBook')).toHaveLength(2)
    expect(mirror.synced).toBe(true)
    mirror.stop()
  })
})

/** Single-market `perpSnapshots` response with one position (liquidation price 90). */
const snapshot = (id: string) => binary(zstd(msgpack([id, 'BTC', [[1, 100, 0, 100, 0, 5, 90, 10]], ['0x1']])), { 'x-payload-format': 'msgpack' })

describe('pollPerpPositions', () => {
  it('downloads only when the snapshot id changes, and reuses the cache across instances', async () => {
    let id = 'snap-1'
    const cache = new MemoryCache()
    const route: FetchRoute = (body) => (body.type === 'perpSnapshotTimestamp' ? json({ snapshot_id: id, timestamp: 1 }) : snapshot(id))
    const a = setup(route, { cache })
    const seen: string[] = []
    const poller = a.hm.pollPerpPositions({ coin: 'BTC', pollMs: 1000, onSnapshot: (p) => seen.push(p.snapshotId) })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(seen).toEqual(['snap-1'])
    expect(a.f.callsOfType('perpSnapshots')).toHaveLength(1)
    id = 'snap-2'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual(['snap-1', 'snap-2'])
    poller.stop()

    // A new client (e.g. after a reload) with the same cache doesn't download again.
    const b = setup(route, { cache })
    const seenB: number[] = []
    const pollerB = b.hm.pollPerpPositions({ coin: 'BTC', onSnapshot: (p) => seenB.push(p.liquidationPx[0]!) })
    await vi.advanceTimersByTimeAsync(0)
    expect(seenB).toEqual([90])
    expect(b.f.callsOfType('perpSnapshots')).toHaveLength(0)
    pollerB.stop()
  })

  it('reports 404 (no snapshot yet) and keeps polling', async () => {
    let ready = false
    const route: FetchRoute = (body) => {
      if (body.type === 'perpSnapshotTimestamp')
        return ready ? json({ snapshot_id: 's', timestamp: 1 }) : json({ error: 'No snapshots available' }, { status: 404 })
      return snapshot('s')
    }
    const { hm } = setup(route)
    const errors: (HydromancerError | undefined)[] = []
    const seen: string[] = []
    hm.pollPerpPositions({ coin: 'BTC', pollMs: 1000, onSnapshot: (p) => seen.push(p.snapshotId), onError: (e) => errors.push(e) })
    await vi.advanceTimersByTimeAsync(0)
    expect(errors[0]).toBeInstanceOf(NotFoundError)
    ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(seen).toEqual(['s'])
    expect(errors.at(-1)).toBeUndefined()
  })
})

describe('Hydromancer.connect with validateApiKey', () => {
  it('does not open the WebSocket when the key is rejected', async () => {
    const f = fakeFetch(() => json({ error: 'Invalid API key' }, { status: 401 }))
    const errors: HydromancerError[] = []
    const hm = new Hydromancer({
      restUrl: 'https://x/info',
      wsUrl: 'wss://x/ws',
      fetch: f.fetch,
      createWebSocket: createFakeWebSocket,
      cache: false,
      validateApiKey: true,
      onError: (e) => errors.push(e),
    })
    hm.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(hm.status).toBe('failed')
    expect(errors[0]?.name).toBe('AuthenticationError')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('Hydromancer base URL', () => {
  it('derives the REST and WebSocket endpoints from baseUrl', async () => {
    const f = fakeFetch(() => json([]))
    const hm = new Hydromancer({ baseUrl: 'https://gateway.example/hm/', fetch: f.fetch, createWebSocket: createFakeWebSocket, cache: false })
    await hm.validateApiKey()
    expect(f.urls).toEqual(['https://gateway.example/hm/info'])
    hm.connect()
    expect(FakeWebSocket.last.url).toBe('wss://gateway.example/hm/ws')
    hm.close()
  })

  it('lets restUrl / wsUrl override it, and defaults to mainnet', () => {
    const custom = new Hydromancer({ baseUrl: 'https://gateway.example', restUrl: 'https://other.example/rpc', createWebSocket: createFakeWebSocket, cache: false })
    expect(custom.rest.url).toBe('https://other.example/rpc')
    expect(new Hydromancer({ cache: false }).rest.url).toBe('https://api.hydromancer.xyz/info')
    expect(new Hydromancer({ network: 'testnet', cache: false }).rest.url).toBe('https://api-testnet.hydromancer.xyz/info')
  })
})
