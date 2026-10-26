import { describe, expect, it } from 'vitest'

import { DecodeError } from '../errors'
import { frame, msgpack, zstd } from '../test/fakes'
import { decodeMsgpack } from './msgpack'
import { decodePerpSnapshots } from './perpSnapshot'
import { decodeTpslBook } from './tpslBook'

describe('decodeMsgpack', () => {
  it('round-trips nested values', () => {
    const value = { a: [1, -2.5, 'x', true, null], b: 4_000_000_000, c: 0.125, d: 443_601_009_265 }
    expect(decodeMsgpack(msgpack(value))).toEqual(value)
  })

  it('decodes negative fixints, int8 and str8', () => {
    expect(decodeMsgpack(new Uint8Array([0xff]))).toBe(-1)
    expect(decodeMsgpack(new Uint8Array([0xd0, 0x80]))).toBe(-128)
    const long = 'x'.repeat(40)
    expect(decodeMsgpack(msgpack(long))).toBe(long)
  })

  it('throws DecodeError on truncated input, bad type bytes and trailing bytes', () => {
    expect(() => decodeMsgpack(new Uint8Array([0xcb, 0, 0]))).toThrow(DecodeError)
    expect(() => decodeMsgpack(new Uint8Array([0xc1]))).toThrow(DecodeError)
    expect(() => decodeMsgpack(new Uint8Array([0x01, 0x02]))).toThrow(DecodeError)
  })
})

/** A `tpslBook` order tuple. */
const order = (oid: number, type: string, coin = 'BTC') => [
  oid,
  coin,
  '0xabc',
  'A',
  '100000',
  '99000',
  '0.5',
  'Price below 100000',
  type,
  true,
  true,
  1_700_000_000_000,
]

describe('decodeTpslBook', () => {
  it('reads the header, decompresses each market and maps tuples', () => {
    const btc = zstd(msgpack(['BTC', [order(7, 'Stop Market'), order(8, 'Take Profit Limit'), order(9, 'Limit')]]))
    const eth = zstd(msgpack(['ETH', [order(10, 'Stop Limit', 'ETH')]]))
    const bytes = frame([{ u32: 2 }, { u64: 123 }, { u64: 1_700_000_000_123 }, { u32: btc.length }, btc, { u32: eth.length }, eth])
    const book = decodeTpslBook(bytes)
    expect(book.height).toBe(123)
    expect(book.timestamp).toBe(1_700_000_000_123)
    // Non-TP/SL order types are dropped.
    expect(book.orders.map((o) => [o.oid, o.coin, o.kind])).toEqual([
      [7, 'BTC', 'sl'],
      [8, 'BTC', 'tp'],
      [10, 'ETH', 'sl'],
    ])
    expect(book.orders[0]).toMatchObject({ side: 'A', triggerPx: 100_000, limitPx: 99_000, sz: 0.5, user: '0xabc', reduceOnly: true, isPositionTpsl: true })
  })

  it('throws DecodeError when a blob is cut short', () => {
    const blob = zstd(msgpack(['BTC', []]))
    const bytes = frame([{ u32: 1 }, { u64: 1 }, { u64: 1 }, { u32: blob.length + 10 }, blob])
    expect(() => decodeTpslBook(bytes)).toThrow(DecodeError)
  })
})

describe('decodePerpSnapshots', () => {
  const positions = [
    [1.5, 150_000, 3, 100_000, 0, 10, 91_000, 20_000],
    [-2, -200_000, -1, 100_000, 1, 5, 0, 50_000],
  ]
  const payload = (market: string) => msgpack(['20260101_state_1', market, positions, ['0x1', '0x2']])

  it('decodes a zstd single-market payload into columns', () => {
    const [s] = decodePerpSnapshots(zstd(payload('BTC')))
    expect(s!.snapshotId).toBe('20260101_state_1')
    expect(s!.market).toBe('BTC')
    expect([...s!.notional]).toEqual([150_000, -200_000])
    expect([...s!.size]).toEqual([1.5, -2])
    expect([...s!.isolated]).toEqual([0, 1])
    expect(s!.addresses).toEqual(['0x1', '0x2'])
    expect(s!.liquidationPx[0]).toBe(91_000)
    // A liquidation price of 0 means there is none.
    expect(s!.liquidationPx[1]).toBeNaN()
  })

  it('accepts a payload the HTTP layer already decompressed', () => {
    expect(decodePerpSnapshots(payload('BTC'), 'msgpack')[0]!.market).toBe('BTC')
    expect(decodePerpSnapshots(payload('BTC'))[0]!.market).toBe('BTC')
  })

  it('decodes the multi-market framing', () => {
    const a = zstd(payload('BTC'))
    const b = zstd(payload('xyz:BTC'))
    const bytes = frame([{ u32: 2 }, { u32: a.length }, a, { u32: b.length }, b])
    expect(decodePerpSnapshots(bytes, 'multi-zstd').map((m) => m.market)).toEqual(['BTC', 'xyz:BTC'])
    expect(decodePerpSnapshots(bytes).map((m) => m.market)).toEqual(['BTC', 'xyz:BTC'])
  })

  it('throws DecodeError for an unexpected shape', () => {
    expect(() => decodePerpSnapshots(zstd(msgpack({ nope: 1 })))).toThrow(DecodeError)
  })
})
