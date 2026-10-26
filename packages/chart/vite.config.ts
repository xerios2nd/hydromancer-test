import { fileURLToPath } from 'node:url'

import { svelte } from '@sveltejs/vite-plugin-svelte'
import type { Connect, Plugin, ProxyOptions } from 'vite'
import { defineConfig, loadEnv } from 'vite'

// `.env` lives at the repository root.
const envDir = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Local dev/preview only: opening the page without `?apiKey=` redirects to the
 * same URL with the key from `.env` added, just as a customer's iframe would
 * pass it. The key never enters the bundle.
 */
function prefillApiKey(apiKey: string): Plugin {
  const redirect: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!apiKey || (url.pathname !== '/' && url.pathname !== '/index.html') || url.searchParams.has('apiKey')) return next()
    url.searchParams.set('apiKey', apiKey)
    res.writeHead(302, { Location: url.pathname + url.search })
    res.end()
  }
  return {
    name: 'prefill-api-key',
    configureServer: (server) => void server.middlewares.use(redirect),
    configurePreviewServer: (server) => void server.middlewares.use(redirect),
  }
}

/**
 * Same-origin relay for REST: the API sends no CORS headers, so the browser
 * can't call `/info` directly. The relay adds nothing; the page's own
 * `Authorization` header is passed through. Production needs the same rule
 * (see src/main.ts). The WebSocket connects directly, since CORS doesn't
 * apply to WebSockets.
 */
const REST_RELAY: Record<string, ProxyOptions> = {
  '/hydromancer/mainnet/info': { target: 'https://api.hydromancer.xyz', changeOrigin: true, rewrite: () => '/info' },
  '/hydromancer/testnet/info': { target: 'https://api-testnet.hydromancer.xyz', changeOrigin: true, rewrite: () => '/info' },
}

export default defineConfig(({ mode }) => {
  // Empty prefix: read the non-VITE_ key here without exposing it to the client.
  const apiKey = loadEnv(mode, envDir, '').HYDROMANCER_API_KEY ?? ''

  return {
    envDir,
    plugins: [svelte(), prefillApiKey(apiKey)],
    server: { proxy: REST_RELAY },
    preview: { proxy: REST_RELAY },
  }
})
