// The chart page. Customers embed it as an iframe and configure it through the
// query string:
//
//   <iframe src="https://<chart host>/?apiKey=<key>&coin=BTC&interval=1m"></iframe>
//
//   apiKey     Hydromancer API key (required).
//   coin       Market, default BTC.
//   interval   Fixed candle interval (1m, 5m, 1h, ...), default 1m.
//   network    mainnet | testnet, default mainnet.
//
// The chart runs the Hydromancer client in a Web Worker. The WebSocket goes
// straight to the API. REST goes through a same-origin relay at
// /hydromancer/<network>/info, because the API sends no CORS headers. The
// relay only forwards: the key comes from the page, in the request's
// `Authorization` header. Dev and preview serve it from vite.config.ts; the
// production host needs the same two rules.

import { BASE_URLS, INTERVAL_MS } from '@local/hydromancer'
import type { FixedInterval } from '@local/hydromancer'
import { mount } from 'svelte'

import App from './App.svelte'

const DEFAULT_COIN = 'BTC'
const DEFAULT_INTERVAL: FixedInterval = '1m'

function isFixedInterval(v: string): v is FixedInterval {
  return Object.hasOwn(INTERVAL_MS, v)
}

function isNetwork(v: string): v is keyof typeof BASE_URLS {
  return Object.hasOwn(BASE_URLS, v)
}

const params = new URLSearchParams(location.search)
const interval = params.get('interval') ?? ''
const networkParam = params.get('network') ?? ''
const network = isNetwork(networkParam) ? networkParam : 'mainnet'

mount(App, {
  target: document.getElementById('app')!,
  props: {
    coin: params.get('coin') || DEFAULT_COIN,
    interval: isFixedInterval(interval) ? interval : DEFAULT_INTERVAL,
    connection: {
      apiKey: params.get('apiKey') || undefined,
      network,
      restUrl: `/hydromancer/${network}/info`,
    },
  },
})
