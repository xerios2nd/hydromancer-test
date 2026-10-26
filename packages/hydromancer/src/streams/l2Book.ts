// `l2Book`: a full book snapshot per block (~70ms) for each changed coin.
// There's no history and nothing to repair after a reconnect; the next
// snapshot replaces everything.

import { parseL2Books } from '../parse'
import type { L2Book } from '../types'
import type { L2BookSubscription } from '../ws/protocol'
import type { ErrorCallback, Stream, StreamContext } from './context'

export interface L2BookStreamOptions {
  coin: string
  nSigFigs?: L2BookSubscription['nSigFigs']
  mantissa?: L2BookSubscription['mantissa']
  nLevels?: L2BookSubscription['nLevels']
  onBook(book: L2Book): void
  onError?: ErrorCallback
}

export function streamL2Book(ctx: StreamContext, { coin, nSigFigs, mantissa, nLevels, onBook, onError }: L2BookStreamOptions): Stream {
  const subscription: L2BookSubscription = { type: 'l2Book', coins: [coin], nSigFigs, mantissa, nLevels }
  const unsubscribe = ctx.ws.subscribe(subscription, {
    onActive: () => onError?.(undefined),
    onData: (frame) => {
      // Another l2Book subscription for the same coin may use other aggregation;
      // the envelope says which, when the server includes it.
      const sig = frame.raw.nSigFigs
      if (typeof sig === 'number' && sig !== nSigFigs) return
      for (const book of parseL2Books(frame.data)) if (book.coin === coin) onBook(book)
    },
    onError: (err) => onError?.(err),
  })
  return { stop: unsubscribe }
}
