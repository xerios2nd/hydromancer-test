import type { CandleSeries } from '../../data/candles'
import type { Layer } from '../frame'
import { theme } from '../theme'

/** OHLC candles. Up and down candles are each filled in a single path. */
export function candleLayer(series: CandleSeries): Layer {
  return {
    clip: true,
    draw(f) {
      const { ctx, intervalMs } = f
      const items = series.items
      const from = series.lowerBound(f.t0 - intervalMs)
      const to = series.lowerBound(f.t1)
      const barPx = (f.plot.w * intervalMs) / (f.t1 - f.t0)
      const bodyW = Math.max(1, Math.round(barPx * 0.7))
      const half = Math.floor(bodyW / 2)

      for (const up of [true, false]) {
        ctx.beginPath()
        for (let i = from; i < to; i++) {
          const c = items[i]!
          if (c.c >= c.o !== up) continue
          const cx = Math.round(f.x(c.t + intervalMs / 2))
          const yh = Math.round(f.y(c.h))
          const yl = Math.round(f.y(c.l))
          const yo = Math.round(f.y(c.o))
          const yc = Math.round(f.y(c.c))
          const top = Math.min(yo, yc)
          ctx.rect(cx, yh, 1, Math.max(1, yl - yh))
          ctx.rect(cx - half, top, bodyW, Math.max(1, Math.max(yo, yc) - top))
        }
        ctx.fillStyle = up ? theme.up : theme.down
        ctx.fill()
      }
    },
  }
}
