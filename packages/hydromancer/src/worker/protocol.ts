// Messages between `HydromancerWorker` (page) and `serveHydromancer` (worker).
// Everything here must survive `postMessage`'s structured clone, so callbacks
// stay on the page and errors travel as plain data.

import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  DecodeError,
  HydromancerError,
  NetworkError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  SubscriptionError,
} from '../errors'
import type { BASE_URLS } from '../hydromancer'
import type { CandleSource, CandleStreamOptions } from '../streams/candles'
import type { L2BookStreamOptions } from '../streams/l2Book'
import type { PerpPositionsPollOptions } from '../streams/perpPositions'
import type { TpslMirrorOptions } from '../streams/tpsl'
import type { Candle, L2Book, PerpPositions, TpslOrder } from '../types'
import type { ConnectionStatus } from '../ws/connection'

/**
 * Either end of the channel: a `Worker` on the page, the worker's global scope
 * inside it. A `MessagePort` works too, once `start()`ed.
 */
export interface MessagePortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/** The `Hydromancer` options that can cross into the worker. */
export interface WorkerHydromancerOptions {
  apiKey?: string
  network?: keyof typeof BASE_URLS
  /** Absolute. Relative URLs are resolved against the page before they are sent. */
  baseUrl?: string
  restUrl?: string
  wsUrl?: string
  validateApiKey?: boolean
  /** `false` disables the worker's cache. */
  cache?: boolean
}

type Data<T> = { [K in keyof T as T[K] extends ((...args: never[]) => unknown) | undefined ? never : K]: T[K] }

export type StreamRequest =
  | { kind: 'candles'; options: Data<CandleStreamOptions> }
  | { kind: 'l2Book'; options: Data<L2BookStreamOptions> }
  | { kind: 'tpsl'; options: Data<TpslMirrorOptions> }
  | { kind: 'perpPositions'; options: Data<PerpPositionsPollOptions> }

export type ToWorker =
  | { type: 'init'; options: WorkerHydromancerOptions }
  | { type: 'connect' }
  | { type: 'close' }
  /** Page clock minus `Date.now()`, so the worker's request ranges follow the page's server-synced clock. */
  | { type: 'clock'; offsetMs: number }
  | ({ type: 'start'; id: number } & StreamRequest)
  | { type: 'stop'; id: number }

export type StreamEvent =
  | { type: 'candles'; candles: Candle[]; source: CandleSource }
  | { type: 'book'; book: L2Book }
  /** Changes since the last event. A resnapshot re-adds every order. */
  | { type: 'tpsl'; ready: boolean; synced: boolean; height: number | undefined; added: TpslOrder[]; removed: number[] }
  | { type: 'positions'; positions: PerpPositions }
  | { type: 'streamError'; error: SerializedError | undefined }

export type FromWorker =
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'error'; error: SerializedError }
  | { type: 'response'; date: string | null; sentAt: number; receivedAt: number }
  | (StreamEvent & { id: number })

/** A `HydromancerError`'s own fields, minus `cause` (which may not be cloneable). */
export type SerializedError = { name: string; message: string; stack?: string } & Record<string, unknown>

// Only the prototypes are used: rebuilding skips the constructors, whose signatures differ.
const ERROR_CLASSES: Record<string, { prototype: HydromancerError }> = {
  HydromancerError,
  ApiError,
  BadRequestError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SubscriptionError,
  NetworkError,
  RequestTimeoutError,
  DecodeError,
}

export function serializeError(error: HydromancerError): SerializedError {
  const { cause: _cause, ...fields } = error as HydromancerError & Record<string, unknown>
  return { ...fields, name: error.name, message: error.message, stack: error.stack }
}

/** Rebuilds the error on the page as an instance of its original class, so `instanceof` checks keep working. */
export function deserializeError(data: SerializedError): HydromancerError {
  const cls = ERROR_CLASSES[data.name] ?? HydromancerError
  return Object.assign(Object.create(cls.prototype) as HydromancerError, data)
}
