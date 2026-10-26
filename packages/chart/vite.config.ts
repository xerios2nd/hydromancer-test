import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// Builds <hm-chart> as one self-contained ES module: Svelte, the Hydromancer
// client and the rest are bundled, so embedders need nothing but this file.
export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'hm-chart',
    },
  },
})
