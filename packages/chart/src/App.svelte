<script lang="ts">
  import { HydromancerWorker, INTERVAL_MS } from '@local/hydromancer'
  import type { ConnectionStatus, FixedInterval, HydromancerWorkerOptions } from '@local/hydromancer'
  import { untrack } from 'svelte'

  import Chart from './chart/Chart.svelte'
  import type { HeatmapSpec } from './chart/chart'
  import { cssRgb, palettes } from './chart/theme'
  import { createBookFeed } from './data/bookFeed'
  import { createCandleFeed } from './data/candleFeed.svelte'
  import { CandleSeries } from './data/candles'
  import { HeatmapSource } from './data/heatmap'
  import { createLiquidationFeed, LIQUIDATION_TIERS } from './data/liquidationFeed.svelte'
  import { createTpslFeed } from './data/tpslFeed.svelte'
  import { now, syncClockFromDateHeader } from './time/clock'

  interface Props {
    coin: string
    interval: FixedInterval
    /** Where and how to connect: `apiKey`, `network`, `baseUrl`, `restUrl`. */
    connection: Pick<HydromancerWorkerOptions, 'apiKey' | 'network' | 'baseUrl' | 'restUrl'>
  }

  const props: Props = $props()
  // Set once from the query string (main.ts), so the initial values are all this needs.
  const { coin, interval, connection } = untrack(() => props)
  const intervalMs = INTERVAL_MS[interval]
  // Four heatmap columns per candle.
  const columnMs = intervalMs / 4

  const series = new CandleSeries()
  const referencePrice = () => series.last?.c
  const sources = {
    book: new HeatmapSource(),
    tp: new HeatmapSource(),
    sl: new HeatmapSource(),
    small: new HeatmapSource(),
    medium: new HeatmapSource(),
    large: new HeatmapSource(),
  }

  // Without a key the API answers 401 to everything, so don't start at all. A `baseUrl` may be a proxy that adds it.
  const missingKey = !connection.apiKey && !connection.baseUrl

  let status = $state<ConnectionStatus>(missingKey ? 'idle' : 'connecting')
  let wsError = $state<string>()

  function start() {
    // The client (WebSocket, REST, decoding, cache) lives in the worker; the feeds get a mirror of its streams.
    const worker = new Worker(new URL('./hydromancer.worker.ts', import.meta.url), { type: 'module' })
    const hm = new HydromancerWorker({
      ...connection,
      worker,
      now,
      validateApiKey: true,
      onResponse: (date, { sentAt, receivedAt }) => syncClockFromDateHeader(date, sentAt, receivedAt),
      onStatus: (s) => {
        status = s
        // Connection errors (drops, rate limits) are stale once it's back.
        if (s === 'open') wsError = undefined
      },
      onError: (err) => (wsError = err.message),
    })
    const candles = createCandleFeed(hm, { coin, interval, series })
    const book = createBookFeed(hm, { coin, heatmap: sources.book, columnMs })
    const tpsl = createTpslFeed(hm, { coin, sources, columnMs, referencePrice })
    const liquidations = createLiquidationFeed(hm, { coin, sources, columnMs, referencePrice })
    hm.connect()

    return {
      errors: () => [candles.error, tpsl.error, liquidations.error],
      destroy() {
        candles.destroy()
        book.destroy()
        tpsl.destroy()
        liquidations.destroy()
        hm.close()
        worker.terminate()
      },
    }
  }

  const session = missingKey ? undefined : start()
  $effect(() => () => session?.destroy())

  interface Group {
    id: string
    label: string
    items: (HeatmapSpec & { label: string })[]
  }

  const liqPalettes = { small: palettes.liqSmall, medium: palettes.liqMedium, large: palettes.liqLarge }

  // Bottom to top. Liquidations are drawn last so they stay readable.
  const groups: Group[] = [
    {
      id: 'book',
      label: 'Order book',
      items: [{ id: 'book', label: 'resting size', source: sources.book, palette: palettes.book }],
    },
    {
      id: 'tpsl',
      label: 'TP/SL',
      items: [
        { id: 'tp', label: 'TP', source: sources.tp, palette: palettes.tp },
        { id: 'sl', label: 'SL', source: sources.sl, palette: palettes.sl },
      ],
    },
    {
      id: 'liq',
      label: 'Liquidations',
      items: LIQUIDATION_TIERS.map((t) => ({
        id: `liq-${t.id}`,
        label: t.label,
        source: sources[t.id],
        palette: liqPalettes[t.id],
      })),
    },
  ]
  const heatmaps = groups.flatMap((g) => g.items)

  let shown = $state<Record<string, boolean>>({ book: true, tpsl: true, liq: true })
  const hidden = $derived(groups.filter((g) => !shown[g.id]).flatMap((g) => g.items.map((i) => i.id)))
  const errors = $derived(
    [missingKey ? 'No API key: set the api-key attribute or the apiKey property' : wsError, ...(session?.errors() ?? [])].filter((e) => e !== undefined),
  )
</script>

<main>
  <header>
    <strong>{coin}</strong>
    <span>{interval} · UTC</span>
    <span class="status" data-status={status}>{status}</span>
    {#each groups as group (group.id)}
      <label class="toggle">
        <input type="checkbox" bind:checked={shown[group.id]} />
        {group.label}
        {#each group.items as item (item.id)}
          <span class="swatch" style:background={cssRgb(item.palette.high)}></span>
          {#if group.items.length > 1}<span class="muted">{item.label}</span>{/if}
        {/each}
      </label>
    {/each}
    {#each errors as error (error)}
      <span class="error">{error}</span>
    {/each}
  </header>
  <div class="chart">
    <Chart {series} {heatmaps} {intervalMs} {hidden} />
  </div>
</main>

<style>
  main {
    position: absolute;
    inset: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    color: #e6edf3;
    font:
      12px ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #21262d;
  }

  .status {
    color: #d29922;
  }

  .status[data-status='open'] {
    color: #3fb950;
  }

  .error {
    color: #f85149;
  }

  .toggle {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    cursor: pointer;
  }

  .swatch {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
  }

  .muted {
    color: #8b949e;
  }

  .chart {
    flex: 1;
    min-height: 0;
  }
</style>
