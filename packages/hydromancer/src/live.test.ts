// Live checks against the real API: validates the key, then checks every
// decoder and stream against real responses. Opt-in, since they need the
// network and spend rate-limit allowance (one tpslBook, one perpSnapshots):
//
//   pnpm test:live          (reads HYDROMANCER_API_KEY from .env)

import { afterAll, describe, expect, it } from 'vitest'

import { MemoryCache } from './cache/store'
import { PermissionError } from './errors'
import { Hydromancer } from './hydromancer'
import type { Candle, L2Book } from './types'

const apiKey = process.env.HYDROMANCER_API_KEY ?? ''
const enabled = process.env.HYDROMANCER_LIVE === '1' && apiKey !== ''
const COIN = 'BTC'
const MIN = 60_000

const finite = (...xs: number[]) => xs.every(Number.isFinite)

function until<T>(what: string, ms: number, start: (resolve: (v: T) => void) => () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined
    const timer = setTimeout(() => {
      stop?.()
      reject(new Error(`timed out waiting for ${what}`))
    }, ms)
    stop = start((v) => {
      clearTimeout(timer)
      // `start` may resolve before it has returned its stop function.
      queueMicrotask(() => stop?.())
      resolve(v)
    })
  })
}

describe.skipIf(!enabled)('live Hydromancer API', { timeout: 60_000 }, () => {
  const hm = new Hydromancer({ apiKey, cache: new MemoryCache() })
  afterAll(() => hm.close())

  it('accepts the API key', async () => {
    await expect(hm.validateApiKey()).resolves.toBeUndefined()
  })

  it('candleSnapshot parses into well-formed candles', async () => {
    const end = Date.now()
    const candles = await hm.info.candleSnapshot({ coin: COIN, interval: '1m', startTime: end - 60 * MIN, endTime: end })
    expect(candles.length).toBeGreaterThan(50)
    for (const c of candles) {
      expect(finite(c.t, c.T, c.o, c.h, c.l, c.c, c.v, c.n)).toBe(true)
      expect(c.t % MIN).toBe(0)
      expect(c.T).toBe(c.t + MIN - 1)
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c, c.l))
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c))
    }
    expect(candles.slice(0, -1).every((c) => c.x)).toBe(true)
  })

  it('pages ranges longer than one candleSnapshot response', async () => {
    const end = Math.floor(Date.now() / MIN) * MIN - 10 * MIN
    const candles = await hm.loadCandles({ coin: COIN, interval: '1m', startTime: end - 5200 * MIN, endTime: end })
    // BTC trades every minute.
    expect(candles.length).toBeGreaterThan(5100)
    expect(new Set(candles.map((c) => c.t)).size).toBe(candles.length)
  })

  it('streams live candles and order books over the WebSocket', async () => {
    hm.connect()
    const candle = until<Candle>('a live candle', 45_000, (resolve) => {
      const s = hm.streamCandles({ coin: COIN, interval: '1m', history: 5, onCandles: (cs, src) => src === 'live' && resolve(cs[0]!) })
      return () => s.stop()
    })
    const book = until<L2Book>('an l2Book snapshot', 45_000, (resolve) => {
      const s = hm.streamL2Book({ coin: COIN, nSigFigs: 5, nLevels: 20, onBook: resolve })
      return () => s.stop()
    })
    const [c, b] = await Promise.all([candle, book])
    expect(hm.status).toBe('open')
    expect(finite(c.t, c.c, c.n)).toBe(true)
    expect(b.coin).toBe(COIN)
    expect(b.bids.length).toBeGreaterThan(0)
    expect(b.asks.length).toBeGreaterThan(0)
    expect(b.bids[0]!.px).toBeLessThan(b.asks[0]!.px)
    expect(b.bids.every((l, i) => i === 0 || l.px < b.bids[i - 1]!.px)).toBe(true)
    expect(b.asks.every((l, i) => i === 0 || l.px > b.asks[i - 1]!.px)).toBe(true)
  })

  it('syncs the TP/SL mirror from tpslBook plus tpslUpdates', async () => {
    hm.connect()
    const mirror = await until<ReturnType<Hydromancer['mirrorTpsl']>>('the TP/SL snapshot', 45_000, (resolve) => {
      const m = hm.mirrorTpsl({ coin: COIN, onChange: () => m.ready && resolve(m) })
      return () => {}
    })
    try {
      expect(mirror.size).toBeGreaterThan(0)
      expect(mirror.height).toBeGreaterThan(0)
      for (const o of mirror.orders()) {
        expect(o.coin).toBe(COIN)
        expect(['tp', 'sl']).toContain(o.kind)
        expect(finite(o.oid, o.triggerPx, o.sz)).toBe(true)
      }
    } finally {
      mirror.stop()
    }
  })

  it('decodes perp position snapshots (paid add-on)', async (ctx) => {
    const id = await hm.info.perpSnapshotTimestamp()
    expect(id.snapshotId).not.toBe('')
    let markets
    try {
      markets = await hm.info.perpSnapshots([COIN])
    } catch (err) {
      if (err instanceof PermissionError) ctx.skip()
      throw err
    }
    const btc = markets.find((m) => m.market === COIN)!
    expect(btc.snapshotId).toBe(id.snapshotId)
    expect(btc.notional.length).toBeGreaterThan(100)
    expect(btc.addresses.length).toBe(btc.notional.length)
    const withLiq = btc.liquidationPx.filter((x) => !Number.isNaN(x))
    expect(withLiq.length).toBeGreaterThan(0)
  })
})
