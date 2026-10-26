import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// Tests only. The chart page has its own config in packages/chart.
export default defineConfig(({ mode }) => ({
  test: {
    include: ['packages/*/src/**/*.{test,spec}.{js,ts}'],
    environment: 'node',
    // Only `pnpm test:live` hands the key to tests (packages/hydromancer/src/live.test.ts).
    // Empty prefix: read the non-VITE_ key here without exposing it to the client.
    env: process.env.HYDROMANCER_LIVE === '1' ? { HYDROMANCER_API_KEY: loadEnv(mode, process.cwd(), '').HYDROMANCER_API_KEY ?? '' } : {},
  },
}))
