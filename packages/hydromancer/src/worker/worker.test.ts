import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthenticationError } from '../errors'
import type { HydromancerError } from '../errors'
import { binary, createFakeWebSocket, FakeWebSocket, fakeFetch, frame, json, msgpack, wireCandle, zstd } from '../test/fakes'
import type { FetchRoute } from '../test/fakes'
import type { Candle } from '../types'
import type { ConnectionStatus } from '../ws/connection'
import { HydromancerWorker } from './client'
import type { HydromancerWorkerOptions } from './client'
import { serveHydromancer } from './host'
import type { MessagePortLike } from './protocol'

const MIN = 60_000
const NOW = 1_000_000 * MIN

/** One end of an in-memory channel. Messages are structured-cloned, as `postMessage` would. */
class Port extends EventTarget {
  other: Port | undefined

  postMessage(msg: unknown): void {
    const data = structuredClone(msg)
    queueMicrotask(() => this.other?.dispatchEvent(new MessageEvent('message', { data })))
  }
}

function channel(): [MessagePortLike, MessagePortLike] {
  const page = new Port()
  const worker = new Port()
  page.other = worker
  worker.other = page
  // EventTarget's listener takes any `Event`, so it only fits `MessagePortLike` structurally with a cast.
  return [page as unknown as MessagePortLike, worker as unknown as MessagePortLike]
}

function setup(route: FetchRoute, opts: Partial<HydromancerWorkerOptions> = {}) {
  const f = fakeFetch(route)
  const [page, worker] = channel()
  const shutdown = serveHydromancer(worker, { fetch: f.fetch, createWebSocket: createFakeWebSocket, cache: false })
  const hm = new HydromancerWorker({ worker: page, restUrl: 'https://x/info', wsUrl: 'wss://x/ws', now: () => NOW, ...opts })
  return { hm, f, shutdown }
}

const minutes = (start: number, end: number) => {
  const out = []
  for (let t = Math.ceil(start / MIN) * MIN; t < end; t += MIN) out.push(wireCandle(t))
  return out
}

function tpslBook(height: number, oids: number[]) {
  const tuples = oids.map((oid) => [oid, 'BTC', '0xu', 'A', '100', '99', '1', 'Price below 100', 'Stop Market', true, true, 1])
  const blob = zstd(msgpack(['BTC', tuples]))
  return binary(frame([{ u32: 1 }, { u64: height }, { u64: 0 }, { u32: blob.length }, blob]))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  FakeWebSocket.reset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('HydromancerWorker', () => {
  it('streams candles through the worker, with request ranges on the page clock', async () => {
    const { hm, f, shutdown } = setup(
      (body) => {
        const { startTime, endTime } = body.req as { startTime: number; endTime: number }
        return json(minutes(startTime, endTime))
      },
      { now: () => NOW + 10 * MIN },
    )
    const got: Candle[][] = []
    const stream = hm.streamCandles({ coin: 'BTC', interval: '1m', history: 5, onCandles: (c) => got.push(c) })
    await vi.advanceTimersByTimeAsync(0)
    expect(got[0]).toHaveLength(6)
    // The worker's clock follows the page's `now`, 10 minutes ahead of `Date.now()`.
    expect((f.calls[0]!.req as { endTime: number }).endTime).toBe(NOW + 11 * MIN)
    expect(stream.newest).toBe(NOW + 10 * MIN)
    stream.stop()
    shutdown()
  })

  it('rebuilds errors as their original class, and reports status', async () => {
    const statuses: ConnectionStatus[] = []
    const errors: HydromancerError[] = []
    const { hm, shutdown } = setup(() => json({ error: 'Invalid API key' }, { status: 401 }), {
      validateApiKey: true,
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
    })
    const streamErrors: (HydromancerError | undefined)[] = []
    hm.streamCandles({ coin: 'BTC', interval: '1m', onCandles: () => {}, onError: (e) => streamErrors.push(e) })
    hm.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(hm.status).toBe('failed')
    expect(statuses.at(-1)).toBe('failed')
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(streamErrors[0]).toBeInstanceOf(AuthenticationError)
    expect(streamErrors[0]?.retryable).toBe(false)
    shutdown()
  })

  it('mirrors TP/SL orders from snapshot and live diffs', async () => {
    const { hm, shutdown } = setup((body) => (body.type === 'tpslBook' ? tpslBook(10, [1, 2]) : json([])))
    let changes = 0
    const mirror = hm.mirrorTpsl({ coin: 'BTC', onChange: () => changes++ })
    hm.connect()
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.last.handshake()
    await vi.advanceTimersByTimeAsync(10_000) // ack timeout → active → snapshot
    await vi.advanceTimersByTimeAsync(100) // flush
    expect(mirror.ready).toBe(true)
    expect(new Set([...mirror.orders()].map((o) => o.oid))).toEqual(new Set([1, 2]))

    const diffs = [
      { type: 'remove', oid: 1, coin: 'BTC' },
      {
        type: 'add',
        oid: 3,
        coin: 'BTC',
        user: '0xu',
        side: 'B',
        triggerPx: '90',
        limitPx: '89',
        sz: '2',
        orderType: 'Take Profit Market',
        isPositionTpsl: false,
        reduceOnly: true,
        timestamp: 1,
      },
    ]
    FakeWebSocket.last.receive({ type: 'tpslUpdates', channel: 'tpslUpdates', seq: 1, data: { height: 11, timestamp: 0, diffs } })
    await vi.advanceTimersByTimeAsync(100)
    expect(new Set([...mirror.orders()].map((o) => o.oid))).toEqual(new Set([2, 3]))
    expect(mirror.height).toBe(11)
    expect(changes).toBe(2)
    mirror.stop()
    shutdown()
  })
})
