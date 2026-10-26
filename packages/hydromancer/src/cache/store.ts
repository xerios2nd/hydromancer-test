// Caching abstraction. Stores hold JSON-compatible values under string keys,
// optionally with a TTL. The library caches what doesn't change: finalized
// candle chunks and position snapshots by id. Cache failures (quota, private
// browsing) never fail a request; use `cacheGet` / `cacheSet`.

export interface CacheSetOptions {
  /** Entry expires after this long. Omit to keep it until evicted. */
  ttlMs?: number
}

export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  /** `value` must survive `JSON.stringify` (stores may serialise it). */
  set(key: string, value: unknown, opts?: CacheSetOptions): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

export interface MemoryCacheOptions {
  /** Least recently used entries are evicted beyond this. */
  maxEntries?: number
  now?: () => number
}

/**
 * In-memory LRU. Values are kept by reference, not copied, so don't mutate
 * what you `set` or `get`.
 */
export class MemoryCache implements CacheStore {
  readonly #entries = new Map<string, { value: unknown; expires: number }>()
  readonly #maxEntries: number
  readonly #now: () => number

  constructor({ maxEntries = 500, now = Date.now }: MemoryCacheOptions = {}) {
    this.#maxEntries = maxEntries
    this.#now = now
  }

  get size(): number {
    return this.#entries.size
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= this.#now()) {
      this.#entries.delete(key)
      return undefined
    }
    // Re-insert to mark as most recently used.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value as T
  }

  async set(key: string, value: unknown, { ttlMs }: CacheSetOptions = {}): Promise<void> {
    this.#entries.delete(key)
    this.#entries.set(key, { value, expires: ttlMs === undefined ? Number.POSITIVE_INFINITY : this.#now() + ttlMs })
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break
      this.#entries.delete(oldest)
    }
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key)
  }

  async clear(): Promise<void> {
    this.#entries.clear()
  }
}

/** Caches nothing. */
export class NoCache implements CacheStore {
  async get<T>(): Promise<T | undefined> {
    return undefined
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
}

/**
 * Layers stores, fastest first (e.g. memory over the Cache API). Reads fall
 * through and copy hits into the faster layers; writes go to every layer.
 */
export class TieredCache implements CacheStore {
  readonly #layers: CacheStore[]

  constructor(layers: CacheStore[]) {
    this.#layers = layers
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.#getFrom<T>(0, key)
  }

  /** Layers are tried in order on purpose: a hit in a fast one skips the slow ones. */
  async #getFrom<T>(i: number, key: string): Promise<T | undefined> {
    const layer = this.#layers[i]
    if (!layer) return undefined
    const value = await layer.get<T>(key)
    if (value === undefined) return this.#getFrom<T>(i + 1, key)
    // The original TTL isn't known here, so promoted copies get none; the slower layer still expires.
    await Promise.all(this.#layers.slice(0, i).map((l) => l.set(key, value)))
    return value
  }

  async set(key: string, value: unknown, opts?: CacheSetOptions): Promise<void> {
    await Promise.all(this.#layers.map((l) => l.set(key, value, opts)))
  }

  async delete(key: string): Promise<void> {
    await Promise.all(this.#layers.map((l) => l.delete(key)))
  }

  async clear(): Promise<void> {
    await Promise.all(this.#layers.map((l) => l.clear()))
  }
}

/** `cache.get` that treats any failure as a miss. */
export async function cacheGet<T>(cache: CacheStore, key: string): Promise<T | undefined> {
  try {
    return await cache.get<T>(key)
  } catch {
    return undefined
  }
}

/** `cache.set` that ignores failures (quota exceeded, storage disabled). */
export async function cacheSet(cache: CacheStore, key: string, value: unknown, opts?: CacheSetOptions): Promise<void> {
  try {
    await cache.set(key, value, opts)
  } catch {
    // Caching is best-effort.
  }
}
