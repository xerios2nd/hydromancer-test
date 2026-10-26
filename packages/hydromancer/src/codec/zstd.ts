import { decompress } from 'fzstd'

import { DecodeError } from '../errors'

export const isZstdFrame = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd

/**
 * Decompresses a zstd frame. Bytes without the zstd magic number are returned
 * as is: single-market `perpSnapshots` is sent with `Content-Encoding: zstd`,
 * which browsers (and Node's fetch) may already have decoded.
 */
export function unzstd(bytes: Uint8Array): Uint8Array {
  if (!isZstdFrame(bytes)) return bytes
  try {
    return decompress(bytes)
  } catch (err) {
    throw new DecodeError('zstd: corrupt frame', { cause: err })
  }
}
