import { describe, expect, it } from 'vitest'

import { CandleSeries } from './candles'
import type { Candle } from './candles'

const candle = (t: number, n: number, x = false, c = 100): Candle => ({
  t,
  T: t + 59_999,
  o: 100,
  h: Math.max(100, c),
  l: Math.min(100, c),
  c,
  v: n,
  n,
  x,
})

const times = (s: CandleSeries) => s.items.map((c) => c.t)

describe('CandleSeries.merge', () => {
  it('keeps candles sorted and unique regardless of input order', () => {
    const s = new CandleSeries()
    s.merge([candle(120_000, 1), candle(0, 1)])
    s.merge([candle(60_000, 1), candle(0, 1), candle(180_000, 1)])
    expect(times(s)).toEqual([0, 60_000, 120_000, 180_000])
  })

  it('does not let a stale backfill overwrite a newer live update', () => {
    const s = new CandleSeries()
    s.merge([candle(0, 10, false, 105)])
    s.merge([candle(0, 7, false, 101)])
    expect(s.last?.c).toBe(105)
    s.merge([candle(0, 12, false, 106)])
    expect(s.last?.c).toBe(106)
  })

  it('prefers a finalized candle over any open one', () => {
    const s = new CandleSeries()
    s.merge([candle(0, 10, true, 104)])
    s.merge([candle(0, 50, false, 999)])
    expect(s.last).toMatchObject({ x: true, c: 104 })
  })

  it('notifies once per changing merge and not at all for no-ops', () => {
    const s = new CandleSeries()
    let calls = 0
    s.onChange(() => calls++)
    s.merge([candle(0, 1), candle(60_000, 1)])
    s.merge([candle(0, 0)])
    expect(calls).toBe(1)
  })

  it('drops the oldest candles beyond maxLength', () => {
    const s = new CandleSeries(2)
    s.merge([candle(0, 1), candle(60_000, 1), candle(120_000, 1)])
    expect(times(s)).toEqual([60_000, 120_000])
  })
})
