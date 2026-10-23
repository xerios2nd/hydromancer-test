<script lang="ts">
  import { createCounter } from './lib/counter.svelte'

  const counter = createCounter()
</script>

<main>
  <h1>svelte-oxc-template</h1>
  <button onclick={() => counter.increment()}>
    count is {counter.count}
  </button>
</main>

<style>
  main {
    text-align: center;
    padding: 2rem;
  }
</style>
