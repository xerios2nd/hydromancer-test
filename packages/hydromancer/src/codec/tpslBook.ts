// `tpslBook` binary format (https://docs.hydromancer.xyz/readme/rest-api/market-data/tpslbook):
//
//   [count u32][height u64][timestamp_ms u64]            20-byte header, little-endian
//   count × [blob_len u32][zstd(msgpack([coin, orders]))]
//
// Orders are 12-element tuples: oid, coin, user, side, trigger_px, limit_px,
// sz, trigger_condition, order_type, is_position_tpsl, reduce_only, timestamp.

import { DecodeError } from '../errors'
import { tpslOrderFromFields } from '../parse'
import type { TpslOrderFields } from '../parse'
import type { TpslBook, TpslOrder } from '../types'
import { ByteReader } from './binary'
import { decodeMsgpack } from './msgpack'
import { unzstd } from './zstd'

export function decodeTpslBook(bytes: Uint8Array): TpslBook {
  const r = new ByteReader(bytes, 'tpslBook')
  const count = r.u32()
  const height = r.u64()
  const timestamp = r.u64()
  const orders: TpslOrder[] = []
  for (let m = 0; m < count; m++) {
    const market = decodeMsgpack(unzstd(r.bytes(r.u32())))
    if (!Array.isArray(market) || typeof market[0] !== 'string' || !Array.isArray(market[1])) {
      throw new DecodeError(`tpslBook: market ${m} is not [coin, orders]`)
    }
    for (const t of market[1] as unknown[]) {
      if (!Array.isArray(t) || t.length < 12) continue
      const order = tpslOrderFromFields(t as TpslOrderFields)
      if (order) orders.push(order)
    }
  }
  return { height, timestamp, orders }
}
