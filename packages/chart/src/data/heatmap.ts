import { ChangeEmitter } from './emitter'

/**
 * Regular time × price grid of intensities, e.g. resting order book liquidity
 * per price bucket over time.
 */
export interface HeatmapGrid {
  /** Column `i` covers `[t0 + i * dt, t0 + (i + 1) * dt)`, ms. */
  t0: number
  dt: number
  cols: number
  /** Row `j` covers `[p0 + j * dp, p0 + (j + 1) * dp)`. */
  p0: number
  dp: number
  rows: number
  /** Column-major intensities: `values[col * rows + row]`. */
  values: Float32Array
  /** Value shown at full intensity. */
  max: number
}

/** Holds the current heatmap grid; replace it wholesale on each update. */
export class HeatmapSource extends ChangeEmitter {
  #grid: HeatmapGrid | undefined
  #version = 0

  get grid(): HeatmapGrid | undefined {
    return this.#grid
  }

  /** Bumped on every {@link set}; lets renderers cache derived images. */
  get version(): number {
    return this.#version
  }

  set(grid: HeatmapGrid | undefined): void {
    this.#grid = grid
    this.#version++
    this.emitChange()
  }
}
