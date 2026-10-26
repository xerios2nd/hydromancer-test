import { hydromancerProxy } from '@local/hydromancer/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  // Empty prefix: read the non-VITE_ key here without exposing it to the client.
  const apiKey = loadEnv(mode, process.cwd(), '').HYDROMANCER_API_KEY ?? ''
  if (!apiKey && mode !== 'test') {
    console.warn('HYDROMANCER_API_KEY is not set (.env). The chart will not receive data.')
  }
  const proxy = hydromancerProxy({ apiKey })

  return {
    server: { proxy },
    preview: { proxy },
    test: {
      include: ['packages/*/src/**/*.{test,spec}.{js,ts}'],
      environment: 'node',
      // Only `pnpm test:live` hands the key to tests (packages/hydromancer/src/live.test.ts).
      env: process.env.HYDROMANCER_LIVE === '1' ? { HYDROMANCER_API_KEY: apiKey } : {},
    },
  }
})
