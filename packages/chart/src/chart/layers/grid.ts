import { formatAxisTime, formatPrice, stepDecimals } from '../../time/format'
import { crisp } from '../frame'
import type { Layer } from '../frame'
import { theme } from '../theme'
import { niceStep, ticks, timeStep } from '../ticks'

const PRICE_TICK_PX = 50
const TIME_TICK_PX = 90

/** Background, grid lines and axis labels. The bottom of the stack. */
export const gridLayer: Layer = {
  draw(f) {
    const { ctx, plot } = f
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, f.width, f.height)

    ctx.font = theme.font
    ctx.fillStyle = theme.axisText
    ctx.strokeStyle = theme.grid
    ctx.lineWidth = 1
    ctx.beginPath()

    const pStep = niceStep(f.p1 - f.p0, plot.h / PRICE_TICK_PX)
    const decimals = stepDecimals(pStep)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (const p of ticks(f.p0, f.p1, pStep)) {
      const y = crisp(f.y(p))
      ctx.moveTo(plot.x, y)
      ctx.lineTo(plot.x + plot.w, y)
      ctx.fillText(formatPrice(p, decimals), plot.x + plot.w + 6, y)
    }

    const tStep = timeStep(f.t1 - f.t0, plot.w / TIME_TICK_PX)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const t of ticks(f.t0, f.t1, tStep)) {
      const x = crisp(f.x(t))
      ctx.moveTo(x, plot.y)
      ctx.lineTo(x, plot.y + plot.h)
      ctx.fillText(formatAxisTime(t, tStep), x, plot.y + plot.h + 6)
    }

    ctx.stroke()
  },
}
