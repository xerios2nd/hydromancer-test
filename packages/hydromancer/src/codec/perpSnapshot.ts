// `perpSnapshots` binary formats (https://docs.hydromancer.xyz/readme/rest-api/market-data/perpsnapshot):
//
//   single market   zstd(msgpack([snapshotId, market, positions, addresses]))
//                   (`x-payload-format: msgpack`, sent with `Content-Encoding: zstd`)
//   multi-market    [count u32] count × [len u32][zstd(msgpack(...))], little-endian
//                   (`x-payload-format: multi-zstd`)
//
// Positions are 8-tuples: size, notional, fundingPnl, entryPx, leverageType
// (0 cross, 1 isolated), leverage, liquidationPx, accountValue.

import { DecodeError } from '../errors'
import type { PerpPositions } from '../types'
import { ByteReader } from './binary'
import { decodeMsgpack } from './msgpack'
import { isZstdFrame, unzstd } from './zstd'

export type PerpPayloadFormat = 'msgpack' | 'multi-zstd'

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Decodes one market: `msgpack([snapshotId, market, positions, addresses])`, zstd or not. */
export function decodePerpMarket(bytes: Uint8Array): PerpPositions {
  const decoded = decodeMsgpack(unzstd(bytes))
  if (!Array.isArray(decoded) || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string' || !Array.isArray(decoded[2])) {
    throw new DecodeError('perpSnapshots: payload is not [snapshotId, market, positions, addresses]')
  }
  const positions = decoded[2] as unknown[]
  const addrs = Array.isArray(decoded[3]) ? (decoded[3] as unknown[]) : []
  const len = positions.length
  const out: PerpPositions = {
    snapshotId: decoded[0],
    market: decoded[1],
    size: new Float64Array(len),
    notional: new Float64Array(len),
    fundingPnl: new Float64Array(len),
    entryPx: new Float64Array(len),
    isolated: new Uint8Array(len),
    leverage: new Float64Array(len),
    liquidationPx: new Float64Array(len),
    accountValue: new Float64Array(len),
    addresses: Array.from({ length: len }, (_, i) => (typeof addrs[i] === 'string' ? (addrs[i] as string) : '')),
  }
  for (let i = 0; i < len; i++) {
    const p = positions[i]
    if (!Array.isArray(p)) {
      out.liquidationPx[i] = Number.NaN
      continue
    }
    out.size[i] = finite(p[0])
    out.notional[i] = finite(p[1])
    out.fundingPnl[i] = finite(p[2])
    out.entryPx[i] = finite(p[3])
    out.isolated[i] = p[4] === 1 ? 1 : 0
    out.leverage[i] = finite(p[5])
    // 0 means there is no liquidation price (e.g. fully collateralised).
    const liq = p[6]
    out.liquidationPx[i] = typeof liq === 'number' && liq > 0 ? liq : Number.NaN
    out.accountValue[i] = finite(p[7])
  }
  return out
}

/** `[count u32] count × [len u32][blob]`. */
function decodeMulti(bytes: Uint8Array): PerpPositions[] {
  const r = new ByteReader(bytes, 'perpSnapshots')
  const count = r.u32()
  const out: PerpPositions[] = []
  for (let i = 0; i < count; i++) out.push(decodePerpMarket(r.bytes(r.u32())))
  return out
}

/**
 * Decodes a `perpSnapshots` response into one entry per market. Uses the
 * `x-payload-format` header when given, otherwise sniffs: a payload that
 * starts with a zstd frame, or with a msgpack fixarray, is single-market.
 */
export function decodePerpSnapshots(bytes: Uint8Array, format?: string | null): PerpPositions[] {
  if (format === 'multi-zstd') return decodeMulti(bytes)
  if (format === 'msgpack') return [decodePerpMarket(bytes)]
  // 0x94: msgpack fixarray of 4, the already-decompressed single-market payload.
  if (isZstdFrame(bytes) || bytes[0] === 0x94) return [decodePerpMarket(bytes)]
  return decodeMulti(bytes)
}
