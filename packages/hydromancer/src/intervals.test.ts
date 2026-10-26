import { describe, expect, it } from 'vitest'

import { addIntervals, intervalStart, isInterval } from './intervals'

const utc = (s: string) => Date.parse(`${s}Z`)

describe('intervals', () => {
  it('aligns fixed intervals to multiples of their length', () => {
    expect(intervalStart('15m', utc('2026-03-04T10:22:33'))).toBe(utc('2026-03-04T10:15:00'))
    expect(addIntervals('1h', utc('2026-03-04T10:22:33'), -2)).toBe(utc('2026-03-04T08:00:00'))
  })

  it('aligns 1w to Monday 00:00 UTC', () => {
    // 2026-03-04 is a Wednesday.
    expect(intervalStart('1w', utc('2026-03-04T10:00:00'))).toBe(utc('2026-03-02T00:00:00'))
    expect(intervalStart('1w', utc('2026-03-02T00:00:00'))).toBe(utc('2026-03-02T00:00:00'))
    expect(addIntervals('1w', utc('2026-03-04T10:00:00'), 1)).toBe(utc('2026-03-09T00:00:00'))
  })

  it('aligns 1M to calendar months', () => {
    expect(intervalStart('1M', utc('2026-03-31T23:59:59'))).toBe(utc('2026-03-01T00:00:00'))
    expect(addIntervals('1M', utc('2026-01-31T00:00:00'), 1)).toBe(utc('2026-02-01T00:00:00'))
    expect(addIntervals('1M', utc('2026-01-15T00:00:00'), -2)).toBe(utc('2025-11-01T00:00:00'))
  })

  it('recognises the documented intervals', () => {
    expect(['1s', '15s', '30s', '1m', '3d', '1w', '1M'].every(isInterval)).toBe(true)
    expect(isInterval('2m')).toBe(false)
  })
})
