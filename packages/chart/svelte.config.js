import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  preprocess: vitePreprocess(),
  // Component styles are added at runtime to the root they render into, which
  // for <hm-chart> is its shadow root. No separate stylesheet to ship.
  compilerOptions: { css: 'injected' },
}
