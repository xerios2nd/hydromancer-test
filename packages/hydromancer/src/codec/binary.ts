import { DecodeError } from '../errors'

/** Bounds-checked little-endian reader over a byte array. */
export class ByteReader {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  readonly #what: string
  #pos = 0

  constructor(bytes: Uint8Array, what: string) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.#what = what
  }

  get remaining(): number {
    return this.#bytes.length - this.#pos
  }

  #take(n: number): number {
    if (this.#pos + n > this.#bytes.length) {
      throw new DecodeError(`${this.#what}: truncated (needed ${n} bytes at offset ${this.#pos}, have ${this.remaining})`)
    }
    const p = this.#pos
    this.#pos += n
    return p
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true)
  }

  u64(): number {
    return Number(this.#view.getBigUint64(this.#take(8), true))
  }

  bytes(n: number): Uint8Array {
    const p = this.#take(n)
    return this.#bytes.subarray(p, p + n)
  }
}
