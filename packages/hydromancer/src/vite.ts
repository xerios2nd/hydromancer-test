// Node-side entry (`@local/hydromancer/vite`). It must stay free of relative
// imports, because the Vite config loader may run it with Node's type stripping.

import type { ProxyOptions } from 'vite'

/** Default same-origin paths the browser uses. Pass them to `Hydromancer` and the proxy. */
export const PROXY_PATHS = {
  ws: '/hydromancer/ws',
  info: '/hydromancer/info',
} as const

export interface HydromancerProxyOptions {
  apiKey: string
  host?: string
  paths?: { ws: string; info: string }
}

/**
 * Vite dev/preview proxy that adds the API key. Hydromancer authenticates
 * WebSockets with a `token` query parameter, so any key in client code would be
 * public. The browser talks to same-origin paths, and this adds the key
 * server-side.
 */
export function hydromancerProxy({ apiKey, host = 'api.hydromancer.xyz', paths = PROXY_PATHS }: HydromancerProxyOptions): Record<string, ProxyOptions> {
  return {
    [paths.ws]: {
      target: `wss://${host}`,
      ws: true,
      changeOrigin: true,
      rewrite: () => `/ws?token=${encodeURIComponent(apiKey)}`,
    },
    [paths.info]: {
      target: `https://${host}`,
      changeOrigin: true,
      rewrite: () => '/info',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  }
}
