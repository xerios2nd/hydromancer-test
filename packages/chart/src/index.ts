// <hm-chart>: the chart as a custom element. Importing this module registers it.
//
//   <hm-chart coin="BTC" interval="1m" base-url="/hydromancer"></hm-chart>
//
// Attributes:
//   coin       Market, default BTC.
//   interval   Fixed candle interval (1m, 5m, 1h, ...), default 1m.
//   base-url   API origin or same-origin proxy prefix. REST goes to <base-url>/info, the WebSocket to <base-url>/ws.
//   network    mainnet | testnet, used when base-url is absent. Default mainnet.
//   api-key    Hydromancer API key (`apikey` works too). Anything in the page is public, so prefer a
//              proxy that adds the key server-side (see @local/hydromancer/vite) and leave this unset.

import { BASE_URLS, INTERVAL_MS } from '@local/hydromancer'
import type { FixedInterval } from '@local/hydromancer'
import { mount, unmount } from 'svelte'

import App from './App.svelte'

export const TAG = 'hm-chart'

const DEFAULT_COIN = 'BTC'
const DEFAULT_INTERVAL: FixedInterval = '1m'

// Outer page styles override these, so embedders size the element as usual.
const HOST_STYLE = ':host { display: block; position: relative; height: 480px; user-select: none; }'

function isFixedInterval(v: string): v is FixedInterval {
  return Object.hasOwn(INTERVAL_MS, v)
}

function isNetwork(v: string): v is keyof typeof BASE_URLS {
  return Object.hasOwn(BASE_URLS, v)
}

export class HmChartElement extends HTMLElement {
  static observedAttributes = ['coin', 'interval', 'base-url', 'network', 'api-key', 'apikey']

  readonly #root: ShadowRoot
  #app: ReturnType<typeof mount> | undefined
  #remountQueued = false

  constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = HOST_STYLE
    this.#root.append(style)
  }

  connectedCallback(): void {
    this.#mount()
  }

  disconnectedCallback(): void {
    this.#unmount()
  }

  // Every attribute feeds the connection or the streams, so a change rebuilds the chart.
  // Changes made in the same task are coalesced into one rebuild.
  attributeChangedCallback(): void {
    if (!this.#app || this.#remountQueued) return
    this.#remountQueued = true
    queueMicrotask(() => {
      this.#remountQueued = false
      if (this.isConnected) this.#mount()
    })
  }

  #mount(): void {
    this.#unmount()
    const interval = this.getAttribute('interval') ?? ''
    const network = this.getAttribute('network') ?? ''
    this.#app = mount(App, {
      target: this.#root,
      props: {
        coin: this.getAttribute('coin') || DEFAULT_COIN,
        interval: isFixedInterval(interval) ? interval : DEFAULT_INTERVAL,
        connection: {
          apiKey: this.getAttribute('api-key') ?? this.getAttribute('apikey') ?? undefined,
          baseUrl: this.getAttribute('base-url') ?? undefined,
          network: isNetwork(network) ? network : undefined,
        },
      },
    })
  }

  #unmount(): void {
    if (!this.#app) return
    void unmount(this.#app)
    this.#app = undefined
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, HmChartElement)

declare global {
  interface HTMLElementTagNameMap {
    [TAG]: HmChartElement
  }
}
