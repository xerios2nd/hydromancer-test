// Worker side of `HydromancerWorker`: owns the real `Hydromancer` (WebSocket,
// REST, decoding, cache) and forwards stream events to the page.
//
//   // hydromancer.worker.ts
//   import { serveHydromancer } from '@local/hydromancer'
//   serveHydromancer(self)

import { Hydromancer } from '../hydromancer'
import type { HydromancerOptions } from '../hydromancer'
import type { Stream } from '../streams/context'
import type { TpslMirror } from '../streams/tpsl'
import type { TpslOrder } from '../types'
import { serializeError } from './protocol'
import type { FromWorker, MessagePortLike, StreamEvent, StreamRequest, ToWorker } from './protocol'

export interface ServeHydromancerOptions extends Pick<HydromancerOptions, 'fetch' | 'createWebSocket' | 'cache'> {
  /**
   * Coalesces TP/SL changes into one message per this many ms. Updates arrive
   * every block, and each message diffs the whole order set.
   */
  tpslFlushMs?: number
}

/** Serves one `HydromancerWorker` over `port` (usually the worker's `self`). Returns a function that shuts it down. */
export function serveHydromancer(port: MessagePortLike, { tpslFlushMs = 100, ...local }: ServeHydromancerOptions = {}): () => void {
  let hm: Hydromancer | undefined
  let offsetMs = 0
  const streams = new Map<number, Stream>()

  const post = (msg: FromWorker) => port.postMessage(msg)
  const emit = (id: number, event: StreamEvent) => post({ ...event, id })
  const reportTo = (id: number) => (err: Parameters<typeof serializeError>[0] | undefined) =>
    emit(id, { type: 'streamError', error: err && serializeError(err) })

  function start(client: Hydromancer, id: number, req: StreamRequest): Stream {
    const onError = reportTo(id)
    switch (req.kind) {
      case 'candles':
        return client.streamCandles({ ...req.options, onCandles: (candles, source) => emit(id, { type: 'candles', candles, source }), onError })
      case 'l2Book':
        return client.streamL2Book({ ...req.options, onBook: (book) => emit(id, { type: 'book', book }), onError })
      case 'perpPositions':
        // Copied, not transferred: the decoder's columns may share one buffer.
        return client.pollPerpPositions({ ...req.options, onSnapshot: (positions) => emit(id, { type: 'positions', positions }), onError })
      case 'tpsl':
        return mirrorTpsl(client, id, req.options, onError)
    }
  }

  function mirrorTpsl(client: Hydromancer, id: number, options: Extract<StreamRequest, { kind: 'tpsl' }>['options'], onError: ReturnType<typeof reportTo>): Stream {
    // What the page holds. Orders are immutable, so an identity check finds additions.
    let sent = new Map<number, TpslOrder>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      const next = new Map<number, TpslOrder>()
      const added: TpslOrder[] = []
      for (const o of mirror.orders()) {
        next.set(o.oid, o)
        if (sent.get(o.oid) !== o) added.push(o)
      }
      const removed: number[] = []
      for (const oid of sent.keys()) if (!next.has(oid)) removed.push(oid)
      sent = next
      emit(id, { type: 'tpsl', ready: mirror.ready, synced: mirror.synced, height: mirror.height, added, removed })
    }
    const mirror: TpslMirror = client.mirrorTpsl({
      ...options,
      onChange: () => {
        timer ??= setTimeout(flush, tpslFlushMs)
      },
      onError,
    })
    return {
      stop() {
        clearTimeout(timer)
        mirror.stop()
      },
    }
  }

  function handle(msg: ToWorker): void {
    if (msg.type === 'init') {
      if (hm) return
      const { cache, ...options } = msg.options
      hm = new Hydromancer({
        ...options,
        ...local,
        cache: cache === false ? false : local.cache,
        now: () => Date.now() + offsetMs,
        rest: {
          onResponse: (res, { sentAt, receivedAt }) => post({ type: 'response', date: res.headers.get('Date'), sentAt, receivedAt }),
        },
        onStatus: (status) => post({ type: 'status', status }),
        onError: (error) => post({ type: 'error', error: serializeError(error) }),
      })
      return
    }
    if (msg.type === 'clock') {
      offsetMs = msg.offsetMs
      return
    }
    if (!hm) return
    if (msg.type === 'connect') hm.connect()
    else if (msg.type === 'close') hm.close()
    else if (msg.type === 'start') {
      streams.get(msg.id)?.stop()
      streams.set(msg.id, start(hm, msg.id, msg))
    } else if (msg.type === 'stop') {
      streams.get(msg.id)?.stop()
      streams.delete(msg.id)
    }
  }

  const onMessage = (event: MessageEvent) => handle(event.data as ToWorker)
  port.addEventListener('message', onMessage)

  return () => {
    port.removeEventListener('message', onMessage)
    for (const s of streams.values()) s.stop()
    streams.clear()
    hm?.close()
  }
}
