<script lang="ts">
  import { untrack } from 'svelte'

  import type { CandleSeries } from '../data/candles'
  import { createChart } from './chart'
  import type { ChartHandle, HeatmapSpec } from './chart'

  interface Props {
    series: CandleSeries
    heatmaps: readonly HeatmapSpec[]
    intervalMs: number
    /** Ids of heatmaps to hide. */
    hidden?: readonly string[]
  }

  let { series, heatmaps, intervalMs, hidden = [] }: Props = $props()
  let canvas: HTMLCanvasElement | undefined = $state()
  let chart: ChartHandle | undefined

  $effect(() => {
    if (!canvas) return
    const c = createChart(canvas, { series, heatmaps, intervalMs, hidden: untrack(() => hidden) })
    chart = c
    return () => {
      c.destroy()
      chart = undefined
    }
  })

  // Toggling visibility only redraws. It doesn't rebuild the chart or reset the view.
  $effect(() => {
    chart?.setHidden(hidden)
  })
</script>

<div class="frame">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  /* The canvas is out of flow so its backing-store size (CSS size × dpr) can't feed back into layout. */
  .frame {
    position: relative;
    width: 100%;
    height: 100%;
  }

  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: crosshair;
  }
</style>
