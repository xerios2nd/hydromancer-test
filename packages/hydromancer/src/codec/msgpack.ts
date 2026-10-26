// MessagePack decoding for Hydromancer's binary endpoints (Rust `rmp_serde`),
// via @msgpack/msgpack. 64-bit integers decode to numbers, exact up to 2^53
// (order ids and timestamps fit). Unknown extension types decode to `ExtData`.

import { Decoder } from '@msgpack/msgpack'

import { DecodeError } from '../errors'

// One shared instance: it caches decoded map keys across calls.
const decoder = new Decoder({ mapKeyConverter: (key) => (typeof key === 'number' ? key : String(key)) })

/** Decodes exactly one value; truncated input, invalid bytes or trailing bytes throw {@link DecodeError}. */
export function decodeMsgpack(bytes: Uint8Array): unknown {
  try {
    return decoder.decode(bytes)
  } catch (err) {
    throw new DecodeError(`msgpack: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}
