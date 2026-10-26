// Transport only: keeps one WebSocket connected. Protocol (handshake,
// subscriptions, pings) belongs to `Connection`.

import { backoffDelay } from '../util'
import type { BackoffOptions } from '../util'

/** The subset of the WebSocket API used here, so tests and Node polyfills can stand in. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: Event) => void, options?: { signal?: AbortSignal }): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

const OPEN = 1

export interface SocketTiming {
  /** Reconnect if nothing arrives for this long. Server pings every 60s, so this catches half-open connections. */
  idleTimeoutMs: number
  backoff: BackoffOptions
}

export const DEFAULT_SOCKET_TIMING: SocketTiming = {
  idleTimeoutMs: 90_000,
  backoff: { minMs: 500, maxMs: 30_000 },
}

export interface SocketEvents {
  onOpen(): void
  onText(text: string): void
  /** The connection is gone. `willRetry` is false once stopped. */
  onClose(info: { code: number | undefined; reason: string; willRetry: boolean; delayMs: number }): void
  /** About to dial; `attempt` is 0 for the first try after a healthy connection. */
  onConnecting(attempt: number): void
}

/**
 * Reconnects with exponential backoff and jitter, runs a receive watchdog, and
 * redials immediately when the browser comes back online. The backoff only
 * resets on {@link markHealthy}, so a server that accepts and then drops
 * connections (e.g. a bad key) is not hammered.
 */
export class ReconnectingSocket {
  readonly #url: () => string
  readonly #factory: WebSocketFactory
  readonly #timing: SocketTiming
  readonly #events: SocketEvents
  #ws: WebSocketLike | undefined
  #detach: AbortController | undefined
  #attempt = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #running = false

  constructor(url: () => string, factory: WebSocketFactory, timing: SocketTiming, events: SocketEvents) {
    this.#url = url
    this.#factory = factory
    this.#timing = timing
    this.#events = events
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === OPEN
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#attempt = 0
    globalThis.addEventListener?.('online', this.#onOnline)
    this.#dial()
  }

  stop(): void {
    if (!this.#running) return
    this.#running = false
    globalThis.removeEventListener?.('online', this.#onOnline)
    clearTimeout(this.#retryTimer)
    clearTimeout(this.#idleTimer)
    this.#retryTimer = undefined
    this.#drop()
  }

  /** Sends if open; returns false otherwise (state is re-sent after reconnecting). */
  send(text: string): boolean {
    if (!this.isOpen) return false
    this.#ws!.send(text)
    return true
  }

  /** The session is confirmed; the next drop reconnects from the shortest backoff. */
  markHealthy(): void {
    this.#attempt = 0
  }

  /** Drops the current connection and reconnects with backoff. */
  reconnect(): void {
    if (this.#running) this.#scheduleReconnect(undefined, 'client reconnect')
  }

  #dial(): void {
    this.#retryTimer = undefined
    this.#events.onConnecting(this.#attempt)
    let ws: WebSocketLike
    try {
      ws = this.#factory(this.#url())
    } catch {
      // e.g. a malformed URL. Treat like a failed connection.
      this.#scheduleReconnect(undefined, 'could not create WebSocket')
      return
    }
    const detach = new AbortController()
    const { signal } = detach
    this.#ws = ws
    this.#detach = detach
    this.#touch()
    ws.addEventListener(
      'open',
      () => {
        this.#touch()
        this.#events.onOpen()
      },
      { signal },
    )
    ws.addEventListener(
      'message',
      (e) => {
        this.#touch()
        const data = (e as MessageEvent).data
        if (typeof data === 'string') this.#events.onText(data)
      },
      { signal },
    )
    // `error` is always followed by `close`.
    ws.addEventListener(
      'close',
      (e) => {
        const ce = e as CloseEvent
        this.#scheduleReconnect(ce.code, ce.reason ?? '')
      },
      { signal },
    )
  }

  /** Detaches and closes the current socket without waiting for the close handshake. */
  #drop(): void {
    const ws = this.#ws
    if (!ws) return
    this.#ws = undefined
    this.#detach?.abort()
    try {
      ws.close()
    } catch {
      // Already closing.
    }
  }

  #scheduleReconnect(code: number | undefined, reason: string): void {
    clearTimeout(this.#idleTimer)
    this.#drop()
    if (this.#retryTimer) return
    if (!this.#running) {
      this.#events.onClose({ code, reason, willRetry: false, delayMs: 0 })
      return
    }
    const delayMs = backoffDelay(this.#attempt++, this.#timing.backoff)
    this.#retryTimer = setTimeout(() => this.#dial(), delayMs)
    this.#events.onClose({ code, reason, willRetry: true, delayMs })
  }

  #touch(): void {
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => this.#scheduleReconnect(undefined, 'idle timeout'), this.#timing.idleTimeoutMs)
  }

  #onOnline = (): void => {
    if (!this.#running || this.isOpen) return
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#drop()
    this.#attempt = 0
    this.#dial()
  }
}
