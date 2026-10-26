export const theme = {
  background: '#0d1117',
  grid: 'rgba(240, 246, 252, 0.06)',
  axisText: '#8b949e',
  text: '#e6edf3',
  labelBg: '#30363d',
  crosshair: 'rgba(240, 246, 252, 0.35)',
  up: '#26a69a',
  down: '#ef5350',
  font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const

export type Rgb = readonly [number, number, number]

/** Heatmap colour ramp, from faint (`low`) to strongest (`high`). */
export interface Palette {
  low: Rgb
  high: Rgb
}

export const palettes = {
  book: { low: [30, 60, 200], high: [250, 220, 60] },
  liqSmall: { low: [0, 110, 160], high: [90, 220, 255] },
  liqMedium: { low: [170, 90, 0], high: [255, 190, 50] },
  liqLarge: { low: [160, 0, 80], high: [255, 70, 200] },
  tp: { low: [0, 120, 70], high: [80, 255, 160] },
  sl: { low: [140, 20, 20], high: [255, 100, 90] },
} as const satisfies Record<string, Palette>

export const cssRgb = ([r, g, b]: Rgb): string => `rgb(${r} ${g} ${b})`
