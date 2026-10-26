// WebSocket frames. https://docs.hydromancer.xyz/readme/websocket
//
// Control frames: connected, reconnected, ping, subscriptionUpdate /
// subscriptionResponse, error, replay. Data frames carry `type` and `channel`
// (both the subscription type), a per-subscription `seq`, a `cursor`, and `data`.

import type { Interval } from '../intervals'
import { isRecord, num, str } from '../util'

export interface CandleSubscription {
  type: 'candle'
  coin: string
  interval: Interval
}

export interface L2BookSubscription {
  type: 'l2Book'
  coins: string[]
  /** 2–5. Bids round down, asks round up. */
  nSigFigs?: 2 | 3 | 4 | 5
  /** 2 or 5, only with `nSigFigs: 5`. */
  mantissa?: 2 | 5
  /** Levels per side. Default 20. */
  nLevels?: 1 | 10 | 20 | 50
}

export interface TpslSubscription {
  type: 'tpslUpdates'
  coins: string[]
}

/** Subscriptions the library has typed streams for. Any other `{ type, … }` object can be sent too. */
export type Subscription = CandleSubscription | L2BookSubscription | TpslSubscription | ({ type: string } & Record<string, unknown>)

export interface ServerWarning {
  code: string
  message: string
  coins?: string[]
}

export interface DataFrame {
  channel: string
  /** Per subscription, from 1, reset on every connection. */
  seq: number | undefined
  cursor: string | undefined
  data: unknown
  /** The whole frame, for envelope fields such as `l2Book`'s `nSigFigs`. */
  raw: Record<string, unknown>
}

export type InboundFrame =
  | { kind: 'connected'; clientId: string | undefined; sessionId: string | undefined; resumed: boolean }
  | { kind: 'ping' }
  | { kind: 'ack'; requestId: string | undefined; operation: string | undefined; failed: unknown[]; warnings: ServerWarning[]; raw: Record<string, unknown> }
  | { kind: 'error'; requestId: string | undefined; code: string | undefined; message: string; details: unknown; subscription: unknown }
  | { kind: 'data'; frame: DataFrame }
  | { kind: 'ignored' }

const CONTROL_TYPES = new Set(['connected', 'reconnected', 'ping', 'pong', 'subscriptionUpdate', 'subscriptionResponse', 'error', 'replay'])

const IGNORED: InboundFrame = { kind: 'ignored' }

function parseWarnings(raw: unknown): ServerWarning[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map((w) => {
    const warning: ServerWarning = { code: String(w.code ?? ''), message: String(w.message ?? '') }
    if (Array.isArray(w.coins)) warning.coins = w.coins.map(String)
    return warning
  })
}

/** Text of a `failed` entry, which may be a string or an object with a message. */
export function describeFailure(failed: unknown[]): string | undefined {
  const first = failed[0]
  if (typeof first === 'string') return first
  if (isRecord(first)) return str(first.message) ?? str(first.error) ?? JSON.stringify(first)
  return undefined
}

/** Classifies a parsed frame. Unknown types and fields are ignored, as the docs require. */
export function parseFrame(raw: unknown): InboundFrame {
  if (!isRecord(raw)) return IGNORED
  const type = str(raw.type)
  switch (type) {
    case 'ping':
      return { kind: 'ping' }
    case 'connected':
    case 'reconnected':
      return { kind: 'connected', clientId: str(raw.clientId), sessionId: str(raw.sessionId), resumed: type === 'reconnected' }
    case 'subscriptionUpdate':
    case 'subscriptionResponse':
      return {
        kind: 'ack',
        requestId: str(raw.requestId),
        operation: str(raw.operation),
        failed: Array.isArray(raw.failed) ? raw.failed : [],
        warnings: parseWarnings(raw.warnings),
        raw,
      }
    case 'error':
      return {
        kind: 'error',
        requestId: str(raw.requestId),
        code: str(raw.code),
        message: str(raw.message) ?? str(raw.error) ?? 'WebSocket error',
        details: raw.details,
        subscription: raw.subscription,
      }
  }
  // Session resume isn't used (gaps are filled from REST), so replays aren't expected.
  if (type !== undefined && CONTROL_TYPES.has(type)) return IGNORED
  const channel = str(raw.channel) ?? type
  if (channel === undefined || !('data' in raw)) return IGNORED
  const seq = num(raw.seq)
  return { kind: 'data', frame: { channel, seq: Number.isFinite(seq) ? seq : undefined, cursor: str(raw.cursor), data: raw.data, raw } }
}
