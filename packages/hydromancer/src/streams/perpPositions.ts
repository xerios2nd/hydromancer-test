// Position snapshots for one market (paid add-on), following the documented
// polling pattern: poll the cheap `perpSnapshotTimestamp`, download
// `perpSnapshots` only when the id changes. Downloads are cached by snapshot
// id, so a reload within the same snapshot doesn't spend the small
// `perpSnapshots` allowance again.

import { cacheGet, cacheSet } from '../cache/store'
import { DecodeError, isAbortError, toHydromancerError } from '../errors'
import type { PerpPositions } from '../types'
import { retryDelay } from './context'
import type { ErrorCallback, Stream, StreamContext } from './context'

export interface PerpPositionsPollOptions {
  /** Market, e.g. `"BTC"` or `"xyz:BTC"`. */
  coin: string
  /** How often to check for a new snapshot, ms. The docs suggest 5–10s. */
  pollMs?: number
  onSnapshot(positions: PerpPositions): void
  onError?: ErrorCallback
  /** How long a downloaded snapshot stays cached, ms. */
  cacheTtlMs?: number
}

/** JSON-safe form of {@link PerpPositions}; NaN liquidation prices become null. */
interface CachedPositions {
  v: 1
  snapshotId: string
  market: string
  columns: Record<'size' | 'notional' | 'fundingPnl' | 'entryPx' | 'leverage' | 'liquidationPx' | 'accountValue', (number | null)[]>
  isolated: number[]
  addresses: string[]
}

const FLOAT_COLUMNS = ['size', 'notional', 'fundingPnl', 'entryPx', 'leverage', 'liquidationPx', 'accountValue'] as const

function toCached(p: PerpPositions): CachedPositions {
  const columns = {} as CachedPositions['columns']
  for (const k of FLOAT_COLUMNS) columns[k] = Array.from(p[k], (x) => (Number.isNaN(x) ? null : x))
  return { v: 1, snapshotId: p.snapshotId, market: p.market, columns, isolated: Array.from(p.isolated), addresses: p.addresses }
}

function fromCached(c: CachedPositions | undefined): PerpPositions | undefined {
  if (c?.v !== 1 || !c.columns) return undefined
  const col = (k: (typeof FLOAT_COLUMNS)[number]) => Float64Array.from(c.columns[k] ?? [], (x) => x ?? Number.NaN)
  return {
    snapshotId: c.snapshotId,
    market: c.market,
    size: col('size'),
    notional: col('notional'),
    fundingPnl: col('fundingPnl'),
    entryPx: col('entryPx'),
    leverage: col('leverage'),
    liquidationPx: col('liquidationPx'),
    accountValue: col('accountValue'),
    isolated: Uint8Array.from(c.isolated ?? []),
    addresses: c.addresses ?? [],
  }
}

export function pollPerpPositions(
  ctx: StreamContext,
  { coin, pollMs = 5_000, onSnapshot, onError, cacheTtlMs = 60 * 60_000 }: PerpPositionsPollOptions,
): Stream {
  const abort = new AbortController()
  const cacheKey = `hydromancer:perpPositions:v1:${coin}`
  let seenId: string | undefined
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function download(snapshotId: string): Promise<PerpPositions> {
    const cached = fromCached(await cacheGet<CachedPositions>(ctx.cache, cacheKey))
    if (cached?.snapshotId === snapshotId) return cached
    const markets = await ctx.info.perpSnapshots([coin], { signal: abort.signal })
    const positions = markets.find((m) => m.market === coin) ?? (markets.length === 1 ? markets[0] : undefined)
    if (!positions) throw new DecodeError(`perpSnapshots: response has no market ${coin}`)
    await cacheSet(ctx.cache, cacheKey, toCached(positions), { ttlMs: cacheTtlMs })
    return positions
  }

  async function poll(): Promise<void> {
    let next = pollMs
    try {
      const { snapshotId } = await ctx.info.perpSnapshotTimestamp({ signal: abort.signal })
      if (snapshotId !== seenId) {
        onSnapshot(await download(snapshotId))
        seenId = snapshotId
      }
      failures = 0
      onError?.(undefined)
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) return
      const error = toHydromancerError(err)
      onError?.(error)
      next = Math.max(pollMs, retryDelay(error, failures++, pollMs, 5 * 60_000))
    }
    if (!abort.signal.aborted) timer = setTimeout(() => void poll(), next)
  }
  void poll()

  return {
    stop() {
      abort.abort()
      clearTimeout(timer)
    },
  }
}
