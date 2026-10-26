import { afterEach, describe, expect, it } from 'vitest'

import { formatAxisTime, formatDateTime, formatPrice, priceDecimals } from './format'

const T = Date.UTC(2026, 9, 23, 14, 5, 9)
const originalTz = process.env.TZ

afterEach(() => {
  process.env.TZ = originalTz
})

describe('time formatting', () => {
  it('is identical in every machine time zone', () => {
    const out = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Chatham'].map((tz) => {
      process.env.TZ = tz
      return [formatDateTime(T), formatDateTime(T, true), formatAxisTime(T, 60_000)]
    })
    for (const o of out) expect(o).toEqual(['2026-10-23 14:05', '2026-10-23 14:05:09', '14:05'])
  })

  it('labels UTC midnight with the day', () => {
    expect(formatAxisTime(Date.UTC(2026, 9, 23), 3_600_000)).toBe('23 Oct')
  })
})

describe('price formatting', () => {
  it('uses up to 5 significant figures', () => {
    expect(formatPrice(67_123.4, priceDecimals(67_123.4))).toBe('67123')
    expect(formatPrice(3456.78, priceDecimals(3456.78))).toBe('3456.8')
    expect(formatPrice(0.123456, priceDecimals(0.123456))).toBe('0.12346')
  })
})
