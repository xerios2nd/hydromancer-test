import { clamp01, mix } from '@thi.ng/math'

import type { HeatmapGrid, HeatmapSource } from '../../data/heatmap'
import type { Layer } from '../frame'
import type { Palette } from '../theme'

/**
 * Draws a {@link HeatmapGrid} under the candles. The grid is rasterised once
 * per source version at one pixel per cell, then scaled into place. Pan and
 * zoom only redraw the cached image.
 */
export function heatmapLayer(id: string, source: HeatmapSource, palette: Palette): Layer {
  let cache: { version: number; image: OffscreenCanvas } | undefined

  return {
    id,
    clip: true,
    draw(f) {
      const grid = source.grid
      if (!grid || grid.cols === 0 || grid.rows === 0 || grid.max <= 0) return
      if (cache?.version !== source.version) {
        cache = { version: source.version, image: rasterize(grid, palette) }
      }
      const x0 = f.x(grid.t0)
      const x1 = f.x(grid.t0 + grid.cols * grid.dt)
      const yTop = f.y(grid.p0 + grid.rows * grid.dp)
      const yBottom = f.y(grid.p0)
      f.ctx.imageSmoothingEnabled = false
      f.ctx.drawImage(cache.image, x0, yTop, x1 - x0, yBottom - yTop)
    },
  }
}

function rasterize(grid: HeatmapGrid, { low, high }: Palette): OffscreenCanvas {
  const { cols, rows, values, max } = grid
  const canvas = new OffscreenCanvas(cols, rows)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const image = ctx.createImageData(cols, rows)
  const px = image.data
  // Log scale. Liquidity is heavy-tailed, and on a linear scale one large wall
  // would wash out everything else.
  const norm = 1 / Math.log1p(max)
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const v = clamp01(Math.log1p(values[col * rows + row] ?? 0) * norm)
      if (v === 0) continue
      // Row 0 is the lowest price, so it goes at the bottom of the image.
      const i = ((rows - 1 - row) * cols + col) * 4
      px[i] = mix(low[0], high[0], v)
      px[i + 1] = mix(low[1], high[1], v)
      px[i + 2] = mix(low[2], high[2], v)
      px[i + 3] = v * 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}
