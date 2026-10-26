// One shared Hydromancer WebSocket: handshake, pings, subscription lifecycle
// (ref-counted, acknowledged by `requestId`, re-sent after every reconnect),
// server errors mapped to typed errors, and an outbound pause when the server
// reports `message_rate_limit`.

import { ApiError, AuthenticationError, BadRequestError, HydromancerError, NetworkError, PermissionError, RateLimitError, SubscriptionError } from '../errors'
import { isRecord, joinUrl, stableKey } from '../util'
import { describeFailure, parseFrame } from './protocol'
import type { DataFrame, ServerWarning, Subscription } from './protocol'
import { DEFAULT_SOCKET_TIMING, ReconnectingSocket } from './socket'
import type { SocketTiming, WebSocketFactory } from './socket'

export const DEFAULT_WS_URL = 'wss://api.hydromancer.xyz/ws'

/**
 * `idle` before {@link Connection.connect}; `open` once the server's
 * `connected` frame arrived; `failed` after an authentication error, which
 * reconnecting can't fix.
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed'

export interface SubscriptionHandler {
  /** The server confirmed the subscription, on first subscribe and after every reconnect. Backfill here. */
  onActive?(): void
  /** Data frames on this subscription's channel. Frames of other subscriptions on the same channel arrive too; filter by coin. */
  onData(frame: DataFrame): void
  /** The server rejected the subscription. */
  onError?(error: SubscriptionError): void
}

export interface ConnectionOptions {
  /**
   * API origin or proxy prefix; connects to `<baseUrl>/ws`, with `http(s)`
   * turned into `ws(s)`. In a browser, use a same-origin proxy that adds the
   * key (see `./vite`).
   */
  baseUrl?: string
  /** Full WebSocket URL, if it isn't `<baseUrl>/ws`. Overrides `baseUrl`. Defaults to {@link DEFAULT_WS_URL}. */
  url?: string
  /** Sent as the `token` query parameter. Leave unset when a proxy adds it. */
  apiKey?: string
  createWebSocket?: WebSocketFactory
  timing?: Partial<SocketTiming>
  /** How long to wait for the `connected` frame before carrying on without it. */
  handshakeTimeoutMs?: number
  /** How long to wait for a subscribe acknowledgement before treating the subscription as active. */
  ackTimeoutMs?: number
  onStatus?(status: ConnectionStatus): void
  /** Connection-level problems: transport drops, auth, rate limits, unattributed server errors. */
  onError?(error: HydromancerError): void
  onWarning?(warning: ServerWarning, subscription: Subscription): void
}

type EntryState = 'pending' | 'active' | 'failed'

interface Entry {
  key: string
  subscription: Subscription
  handlers: Set<SubscriptionHandler>
  state: EntryState
  requestId: string | undefined
  ackTimer: ReturnType<typeof setTimeout> | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
  retries: number
}

const AUTH_RE = /invalid api key|authentication failed|unauthori[sz]ed|invalid token/i
const PERMISSION_RE = /requires permission|permission denied|not permitted/i
/** Server errors that say to try again ("l2Book snapshot not ready, please resubscribe"). */
const RETRY_RE = /resubscribe|not ready|try again/i

/** Seconds to wait, from `message_rate_limit` details (field names are not pinned down by the docs). */
function retryAfterMsFromDetails(details: unknown): number | undefined {
  if (!isRecord(details)) return undefined
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'number' && Number.isFinite(v) && /retry|reset/i.test(k)) return /ms$/i.test(k) ? v : v * 1000
  }
  return undefined
}

function serverError(code: string | undefined, message: string, details: unknown, requestType: string | undefined): HydromancerError {
  const opts = { code, details, requestType }
  if (code === 'message_rate_limit' || code === 'rate_limited' || /rate limit/i.test(message)) {
    return new RateLimitError(message, { ...opts, code: code ?? 'rate_limited', status: undefined, retryAfterMs: retryAfterMsFromDetails(details) })
  }
  if (AUTH_RE.test(message)) return new AuthenticationError(message, opts)
  if (PERMISSION_RE.test(message)) return new PermissionError(message, opts)
  if (code?.startsWith('invalid') || /^invalid/i.test(message)) return new BadRequestError(message, opts)
  return new ApiError(message, opts)
}

export class Connection {
  readonly #socket: ReconnectingSocket
  readonly #opts: ConnectionOptions
  readonly #entries = new Map<string, Entry>()
  #status: ConnectionStatus = 'idle'
  #ready = false
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined
  #pausedUntil = 0
  #queue: string[] = []
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  #nextRequestId = 1
  #sessionId: string | undefined

  constructor(opts: ConnectionOptions = {}) {
    this.#opts = opts
    const url = () => {
      const u = new URL(opts.url ?? (opts.baseUrl ? joinUrl(opts.baseUrl, 'ws') : DEFAULT_WS_URL), globalThis.location?.href)
      // Relative URLs (a same-origin proxy path) resolve against the page.
      if (u.protocol === 'http:') u.protocol = 'ws:'
      else if (u.protocol === 'https:') u.protocol = 'wss:'
      if (opts.apiKey) u.searchParams.set('token', opts.apiKey)
      return u.href
    }
    const timing = { ...DEFAULT_SOCKET_TIMING, ...opts.timing }
    this.#socket = new ReconnectingSocket(url, opts.createWebSocket ?? ((u) => new WebSocket(u)), timing, {
      onConnecting: (attempt) => this.#setStatus(attempt === 0 && this.#status !== 'reconnecting' ? 'connecting' : 'reconnecting'),
      onOpen: () => {
        // Docs: subscribe once `connected` arrives. Carry on without it if it never does.
        this.#handshakeTimer = setTimeout(() => this.#onReady(), opts.handshakeTimeoutMs ?? 3_000)
      },
      onText: (text) => this.#onText(text),
      onClose: ({ code, reason, willRetry, delayMs }) => {
        const wasReady = this.#ready
        this.#onDisconnected()
        if (!willRetry) return
        this.#setStatus('reconnecting')
        if (wasReady) {
          const why = reason || (code === undefined ? 'connection lost' : `code ${code}`)
          this.#opts.onError?.(new NetworkError(`WebSocket closed (${why}); reconnecting in ${Math.round(delayMs)}ms`, { code: 'ws_closed' }))
        }
      },
    })
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  /** Session id from the latest `connected` frame. */
  get sessionId(): string | undefined {
    return this.#sessionId
  }

  connect(): void {
    if (this.#status === 'open' || this.#status === 'connecting' || this.#status === 'reconnecting') return
    this.#socket.start()
  }

  close(): void {
    this.#socket.stop()
    this.#onDisconnected()
    this.#setStatus('closed')
  }

  /** Stops reconnecting and reports `error`; status becomes `failed`. {@link connect} starts over. */
  fail(error: HydromancerError): void {
    this.#socket.stop()
    this.#onDisconnected()
    this.#setStatus('failed')
    this.#opts.onError?.(error)
  }

  /**
   * Subscribes `handler` to `subscription`. Identical subscriptions share one
   * server subscription. Returns an unsubscribe function.
   */
  subscribe(subscription: Subscription, handler: SubscriptionHandler): () => void {
    const key = stableKey(subscription)
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { key, subscription, handlers: new Set(), state: 'pending', requestId: undefined, ackTimer: undefined, retryTimer: undefined, retries: 0 }
      this.#entries.set(key, entry)
      if (this.#ready) this.#sendSubscribe(entry)
    } else if (entry.state === 'active') {
      // Already live: this handler joins mid-stream and backfills now.
      queueMicrotask(() => {
        if (entry!.handlers.has(handler)) handler.onActive?.()
      })
    }
    entry.handlers.add(handler)
    const e = entry
    return () => {
      if (!e.handlers.delete(handler) || e.handlers.size > 0) return
      this.#entries.delete(key)
      this.#clearEntryTimers(e)
      if (this.#ready && e.state !== 'failed') this.#send({ method: 'unsubscribe', subscription: e.subscription })
    }
  }

  #setStatus(status: ConnectionStatus): void {
    if (status === this.#status) return
    this.#status = status
    this.#opts.onStatus?.(status)
  }

  #onText(text: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    const frame = parseFrame(raw)
    switch (frame.kind) {
      case 'ping':
        // Pongs bypass the outbound pause; missing them gets the connection dropped.
        this.#socket.send('{"type":"pong"}')
        return
      case 'connected':
        this.#sessionId = frame.sessionId
        this.#onReady()
        return
      case 'ack':
        this.#onAck(frame.requestId, frame.failed, frame.warnings)
        return
      case 'error':
        this.#onServerError(frame.requestId, frame.code, frame.message, frame.details)
        return
      case 'data':
        for (const entry of this.#entries.values()) {
          if (entry.subscription.type !== frame.frame.channel || entry.state === 'failed') continue
          for (const h of entry.handlers) h.onData(frame.frame)
        }
        return
      case 'ignored':
        return
    }
  }

  #onReady(): void {
    clearTimeout(this.#handshakeTimer)
    if (this.#ready || !this.#socket.isOpen) return
    this.#ready = true
    this.#socket.markHealthy()
    this.#setStatus('open')
    for (const entry of this.#entries.values()) {
      entry.retries = 0
      this.#sendSubscribe(entry)
    }
  }

  #onDisconnected(): void {
    clearTimeout(this.#handshakeTimer)
    clearTimeout(this.#flushTimer)
    this.#flushTimer = undefined
    this.#queue = []
    this.#ready = false
    for (const entry of this.#entries.values()) {
      this.#clearEntryTimers(entry)
      entry.state = 'pending'
      entry.requestId = undefined
    }
  }

  #clearEntryTimers(entry: Entry): void {
    clearTimeout(entry.ackTimer)
    clearTimeout(entry.retryTimer)
    entry.ackTimer = entry.retryTimer = undefined
  }

  #sendSubscribe(entry: Entry): void {
    this.#clearEntryTimers(entry)
    entry.state = 'pending'
    entry.requestId = `hm-${this.#nextRequestId++}`
    this.#send({ method: 'subscribe', subscription: entry.subscription, requestId: entry.requestId })
    // Not every server build echoes `requestId`. Silence is treated as success.
    entry.ackTimer = setTimeout(() => this.#activate(entry), this.#opts.ackTimeoutMs ?? 10_000)
  }

  #activate(entry: Entry): void {
    clearTimeout(entry.ackTimer)
    entry.ackTimer = undefined
    if (entry.state !== 'pending' || this.#entries.get(entry.key) !== entry) return
    entry.state = 'active'
    entry.retries = 0
    for (const h of entry.handlers) h.onActive?.()
  }

  #entryByRequestId(requestId: string | undefined): Entry | undefined {
    if (requestId === undefined) return undefined
    for (const entry of this.#entries.values()) if (entry.requestId === requestId) return entry
    return undefined
  }

  #onAck(requestId: string | undefined, failed: unknown[], warnings: ServerWarning[]): void {
    const entry = this.#entryByRequestId(requestId)
    if (!entry) return
    for (const w of warnings) this.#opts.onWarning?.(w, entry.subscription)
    if (failed.length > 0) this.#failEntry(entry, undefined, describeFailure(failed) ?? 'Subscription failed', failed)
    else this.#activate(entry)
  }

  #onServerError(requestId: string | undefined, code: string | undefined, message: string, details: unknown): void {
    const entry = this.#entryByRequestId(requestId)
    const err = serverError(code, message, details, entry?.subscription.type)
    if (err instanceof RateLimitError) this.#pause(err.retryAfterMs ?? 60_000)
    // Reconnecting won't fix a bad key.
    if (err instanceof AuthenticationError) {
      this.fail(err)
      return
    }
    if (entry) this.#failEntry(entry, code, message, details, err)
    else this.#opts.onError?.(err)
  }

  #failEntry(entry: Entry, code: string | undefined, message: string, details: unknown, cause?: HydromancerError): void {
    this.#clearEntryTimers(entry)
    entry.state = 'failed'
    const error = new SubscriptionError(`${entry.subscription.type}: ${message}`, {
      subscription: entry.subscription,
      requestId: entry.requestId,
      code: code ?? cause?.code,
      details,
      requestType: entry.subscription.type,
      cause,
    })
    for (const h of entry.handlers) h.onError?.(error)
    // Transient rejections are retried with backoff; the rest wait for the next reconnect.
    const transient = cause instanceof RateLimitError || RETRY_RE.test(message)
    if (!transient || entry.retries >= 5) return
    const delay = cause instanceof RateLimitError ? (cause.retryAfterMs ?? 60_000) : 2_000 * 2 ** entry.retries
    entry.retries++
    entry.retryTimer = setTimeout(() => {
      if (this.#ready && this.#entries.get(entry.key) === entry) this.#sendSubscribe(entry)
    }, delay)
  }

  #pause(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + ms)
  }

  #send(msg: unknown): void {
    if (!this.#ready) return
    this.#queue.push(JSON.stringify(msg))
    this.#flush()
  }

  #flush(): void {
    clearTimeout(this.#flushTimer)
    this.#flushTimer = undefined
    const wait = this.#pausedUntil - Date.now()
    if (wait > 0) {
      this.#flushTimer = setTimeout(() => this.#flush(), wait)
      return
    }
    while (this.#queue.length > 0) {
      if (!this.#socket.send(this.#queue[0]!)) return
      this.#queue.shift()
    }
  }
}
