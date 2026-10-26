import { describe, expect, it } from 'vitest'

import { FakeCacheStorage } from '../test/fakes'
import { CacheApiStore } from './cacheApi'
import { cacheGet, cacheSet, MemoryCache, TieredCache } from './store'
import type { CacheStore } from './store'

describe('MemoryCache', () => {
  it('expires entries after their TTL', async () => {
    let now = 0
    const c = new MemoryCache({ now: () => now })
    await c.set('a', 1, { ttlMs: 100 })
    await c.set('b', 2)
    now = 100
    expect(await c.get('a')).toBeUndefined()
    expect(await c.get('b')).toBe(2)
  })

  it('evicts the least recently used entry', async () => {
    const c = new MemoryCache({ maxEntries: 2 })
    await c.set('a', 1)
    await c.set('b', 2)
    await c.get('a')
    await c.set('c', 3)
    expect(await c.get('b')).toBeUndefined()
    expect(await c.get('a')).toBe(1)
    expect(c.size).toBe(2)
  })
})

describe('CacheApiStore', () => {
  it('round-trips JSON values and honours TTL', async () => {
    let now = 0
    const storage = new FakeCacheStorage()
    const c = new CacheApiStore({ storage: storage.asCacheStorage(), now: () => now })
    await c.set('candles:BTC', [[1, 2, 3]], { ttlMs: 1000 })
    await c.set('forever', { a: 'x' })
    expect(await c.get('candles:BTC')).toEqual([[1, 2, 3]])
    now = 1000
    expect(await c.get('candles:BTC')).toBeUndefined()
    expect(await c.get('forever')).toEqual({ a: 'x' })
    await c.clear()
    expect(await c.get('forever')).toBeUndefined()
  })
})

describe('TieredCache', () => {
  it('falls through to slower layers and promotes hits', async () => {
    const fast = new MemoryCache()
    const slow = new MemoryCache()
    await slow.set('k', 'v')
    const c = new TieredCache([fast, slow])
    expect(await c.get('k')).toBe('v')
    expect(await fast.get('k')).toBe('v')
    await c.set('n', 1)
    expect(await slow.get('n')).toBe(1)
  })
})

describe('cacheGet / cacheSet', () => {
  it('treat store failures as misses', async () => {
    const broken: CacheStore = {
      get: () => Promise.reject(new Error('disk')),
      set: () => Promise.reject(new DOMException('full', 'QuotaExceededError')),
      delete: async () => {},
      clear: async () => {},
    }
    expect(await cacheGet(broken, 'k')).toBeUndefined()
    await expect(cacheSet(broken, 'k', 1)).resolves.toBeUndefined()
  })
})
