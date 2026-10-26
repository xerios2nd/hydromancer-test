// Persistent store on the browser Cache API
// (https://developer.mozilla.org/en-US/docs/Web/API/Cache), so cached history
// survives reloads. Needs a secure context (https or localhost).

import type { CacheSetOptions, CacheStore } from './store'

export interface CacheApiStoreOptions {
  /** Cache name. Bump it to drop everything from an older format. */
  name?: string
  /** Defaults to the global `caches`. */
  storage?: CacheStorage
  /** Origin of the synthetic request URLs entries are stored under. Never fetched. */
  baseUrl?: string
  now?: () => number
}

const EXPIRES_HEADER = 'x-hydromancer-expires'

export class CacheApiStore implements CacheStore {
  readonly #name: string
  readonly #storage: CacheStorage | undefined
  readonly #baseUrl: string
  readonly #now: () => number
  #cache: Promise<Cache> | undefined

  /** Whether the Cache API is usable here. */
  static isSupported(): boolean {
    return typeof caches !== 'undefined' && globalThis.isSecureContext !== false
  }

  constructor({ name = 'hydromancer-v1', storage, baseUrl = 'https://hydromancer.cache.invalid/', now = Date.now }: CacheApiStoreOptions = {}) {
    this.#name = name
    this.#storage = storage
    this.#baseUrl = baseUrl
    this.#now = now
  }

  #open(): Promise<Cache> {
    const storage = this.#storage ?? globalThis.caches
    this.#cache ??= storage.open(this.#name)
    return this.#cache
  }

  #url(key: string): string {
    return this.#baseUrl + encodeURIComponent(key)
  }

  async get<T>(key: string): Promise<T | undefined> {
    const cache = await this.#open()
    const res = await cache.match(this.#url(key))
    if (!res) return undefined
    const expires = Number(res.headers.get(EXPIRES_HEADER))
    if (expires && expires <= this.#now()) {
      await cache.delete(this.#url(key))
      return undefined
    }
    return (await res.json()) as T
  }

  async set(key: string, value: unknown, { ttlMs }: CacheSetOptions = {}): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ttlMs !== undefined) headers[EXPIRES_HEADER] = String(this.#now() + ttlMs)
    const cache = await this.#open()
    await cache.put(this.#url(key), new Response(JSON.stringify(value), { headers }))
  }

  async delete(key: string): Promise<void> {
    const cache = await this.#open()
    await cache.delete(this.#url(key))
  }

  async clear(): Promise<void> {
    const storage = this.#storage ?? globalThis.caches
    this.#cache = undefined
    await storage.delete(this.#name)
  }
}
