import type { Candle, CandleSeries } from '../../data/candles'
import { formatDateTime, formatPrice, priceDecimals } from '../../time/format'
import { contains, crisp } from '../frame'
import type { Frame, Layer } from '../frame'
import { theme } from '../theme'

/** Last price line, crosshair with axis labels, and OHLC legend. The top of the stack. */
export function overlayLayer(series: CandleSeries): Layer {
  return {
    draw(f) {
      const { ctx, plot } = f
      ctx.font = theme.font
      ctx.lineWidth = 1
      const last = series.last
      let legend = last

      if (last) {
        const y = crisp(f.y(last.c))
        const color = last.c >= last.o ? theme.up : theme.down
        ctx.strokeStyle = color
        ctx.setLineDash([2, 3])
        hLine(f, y)
        ctx.setLineDash([])
        label(ctx, formatPrice(last.c, priceDecimals(last.c)), plot.x + plot.w, y, 'left', color)
      }

      const p = f.pointer
      if (p && contains(plot, p)) {
        const t = f.timeAt(p.x)
        const hovered = candleAt(series, t, f.intervalMs)
        if (hovered) legend = hovered
        const slot = hovered?.t ?? t

        ctx.strokeStyle = theme.crosshair
        ctx.setLineDash([4, 4])
        hLine(f, crisp(p.y))
        ctx.beginPath()
        ctx.moveTo(crisp(p.x), plot.y)
        ctx.lineTo(crisp(p.x), plot.y + plot.h)
        ctx.stroke()
        ctx.setLineDash([])

        const price = f.priceAt(p.y)
        label(ctx, formatPrice(price, priceDecimals(price)), plot.x + plot.w, p.y, 'left', theme.labelBg)
        label(ctx, `${formatDateTime(slot, f.intervalMs < 60_000)} UTC`, p.x, plot.y + plot.h, 'center', theme.labelBg)
      }

      if (legend) drawLegend(f, legend)
    },
  }
}

/** The candle whose slot contains `t`, if loaded. */
function candleAt(series: CandleSeries, t: number, intervalMs: number): Candle | undefined {
  const c = series.items[series.lowerBound(t + 1) - 1]
  return c && t < c.t + intervalMs ? c : undefined
}

function hLine(f: Frame, y: number): void {
  f.ctx.beginPath()
  f.ctx.moveTo(f.plot.x, y)
  f.ctx.lineTo(f.plot.x + f.plot.w, y)
  f.ctx.stroke()
}

/** Text in a filled box. `left` boxes start at `x`; `center` boxes hang below `y`, centered on `x`. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: 'left' | 'center', bg: string): void {
  const w = Math.ceil(ctx.measureText(text).width) + 10
  const h = 18
  const bx = align === 'left' ? x : x - w / 2
  const by = align === 'left' ? y - h / 2 : y
  ctx.fillStyle = bg
  ctx.fillRect(Math.round(bx), Math.round(by), w, h)
  ctx.fillStyle = theme.text
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, Math.round(bx) + 5, Math.round(by) + h / 2)
}

function drawLegend(f: Frame, c: Candle): void {
  const { ctx, plot } = f
  const d = priceDecimals(c.c)
  const fields: [string, number][] = [
    ['O', c.o],
    ['H', c.h],
    ['L', c.l],
    ['C', c.c],
  ]
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let x = plot.x + 8
  const y = plot.y + 8
  for (const [name, value] of fields) {
    ctx.fillStyle = theme.axisText
    ctx.fillText(name, x, y)
    x += ctx.measureText(name).width + 4
    const text = formatPrice(value, d)
    ctx.fillStyle = c.c >= c.o ? theme.up : theme.down
    ctx.fillText(text, x, y)
    x += ctx.measureText(text).width + 10
  }
}
