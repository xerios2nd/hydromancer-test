// Test doubles: a scriptable WebSocket, a routing fetch, an in-memory
// CacheStorage, and a MessagePack encoder for building binary fixtures.
// Not exported from the package.

import zlib from 'node:zlib'

import { encode } from '@msgpack/msgpack'

import type { WebSocketLike } from '../ws/socket'

export class FakeWebSocket extends EventTarget implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  readyState = 0
  readonly url: string
  readonly sent: unknown[] = []

  constructor(url: string) {
    super()
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  static reset(): void {
    FakeWebSocket.instances = []
  }

  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error('no WebSocket created')
    return ws
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
  }

  /** Server side: accept the connection. */
  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  /** Server side: accept and send `connected`. */
  handshake(sessionId = 's1'): void {
    this.open()
    this.receive({ type: 'connected', clientId: 'c1', sessionId })
  }

  receive(msg: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }))
  }

  /** Server side: drop the connection. */
  drop(code = 1006): void {
    this.readyState = 3
    const e = new Event('close') as Event & { code: number; reason: string }
    e.code = code
    e.reason = ''
    this.dispatchEvent(e)
  }

  sentOfMethod(method: string): Record<string, unknown>[] {
    return this.sent.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && (m as { method?: unknown }).method === method)
  }
}

export const createFakeWebSocket = (url: string) => new FakeWebSocket(url)

export type FetchRoute = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>

/** `fetch` that hands the parsed JSON body to `route`, and records every call. */
export function fakeFetch(route: FetchRoute) {
  const calls: Record<string, unknown>[] = []
  const headers: Headers[] = []
  const urls: string[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push(body)
    urls.push(String(input))
    headers.push(new Headers(init?.headers))
    return route(body, init ?? {})
  }) as typeof fetch
  return { fetch: fn, calls, headers, urls, callsOfType: (type: string) => calls.filter((c) => c.type === type) }
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })

export const binary = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream', ...headers } })

class FakeCache {
  readonly entries = new Map<string, Response>()

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(String(req))?.clone()
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.entries.set(String(req), res)
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(String(req))
  }
}

/** Minimal `CacheStorage` for `CacheApiStore` tests (Node has no Cache API). */
export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>()

  async open(name: string): Promise<Cache> {
    let c = this.caches.get(name)
    if (!c) {
      c = new FakeCache()
      this.caches.set(name, c)
    }
    return c as unknown as Cache
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }

  asCacheStorage(): CacheStorage {
    return this as unknown as CacheStorage
  }
}

/** MessagePack-encodes a fixture, as the server would. */
export const msgpack = (v: unknown): Uint8Array => encode(v)

export const zstd = (b: Uint8Array) => new Uint8Array(zlib.zstdCompressSync(b))

/** Little-endian framing helper. */
export function frame(parts: (Uint8Array | { u32: number } | { u64: number })[]): Uint8Array {
  const chunks: Uint8Array[] = parts.map((p) => {
    if (p instanceof Uint8Array) return p
    if ('u32' in p) {
      const d = new DataView(new ArrayBuffer(4))
      d.setUint32(0, p.u32, true)
      return new Uint8Array(d.buffer)
    }
    const d = new DataView(new ArrayBuffer(8))
    d.setBigUint64(0, BigInt(p.u64), true)
    return new Uint8Array(d.buffer)
  })
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Raw candle as the wire sends it (decimal strings). */
export const wireCandle = (t: number, { coin = 'BTC', interval = '1m', c = '100', n = 1, x = true, ms = 60_000 } = {}) => ({
  s: coin,
  i: interval,
  t,
  T: t + ms - 1,
  o: '100',
  h: '101',
  l: '99',
  c,
  v: '1.5',
  q: '150',
  n,
  x,
})
