import type { HeatmapGrid } from './heatmap'

/** A price and the quantity there (book size, notional, …). */
export interface Level {
  px: number
  sz: number
}

export interface LevelHeatmapOptions {
  /** Width of one time column, ms. */
  columnMs: number
  /** Price bucket size. Levels are expected on multiples of it. */
  tick: number
  /** Columns kept. Older ones are dropped. */
  maxColumns?: number
}

/** Price step of a book aggregated to `nSigFigs` significant figures around `price`. */
export function sigFigStep(price: number, nSigFigs: number): number {
  return 10 ** (Math.floor(Math.log10(price)) + 1 - nSigFigs)
}

/** JSON-compatible state of a {@link LevelHeatmap}. */
export interface LevelHeatmapSnapshot {
  columnMs: number
  tick: number
  /** One `[column, samples, row, sum, row, sum, …]` per column. */
  columns: number[][]
}

interface Column {
  /** Summed size per price row (`round(px / tick)`). */
  sums: Map<number, number>
  samples: number
}

/**
 * Turns samples of a price → quantity state (order book, liquidation levels,
 * TP/SL orders) into a time × price heatmap. Each cell is the quantity in its
 * price bucket, averaged over every sample in its time column. A level missing
 * from a sample counts as zero for that sample.
 */
export class LevelHeatmap {
  readonly columnMs: number
  readonly tick: number
  readonly maxColumns: number
  #columns = new Map<number, Column>()
  #latest = Number.NEGATIVE_INFINITY

  constructor({ columnMs, tick, maxColumns = 960 }: LevelHeatmapOptions) {
    this.columnMs = columnMs
    this.tick = tick
    this.maxColumns = maxColumns
  }

  add(time: number, levels: Iterable<Level>): void {
    const column = this.#column(Math.floor(time / this.columnMs))
    if (!column) return
    column.samples++
    for (const { px, sz } of levels) {
      const row = Math.round(px / this.tick)
      column.sums.set(row, (column.sums.get(row) ?? 0) + sz)
    }
  }

  /** The column at index `col`, created if needed, or `undefined` if it's too old to keep. */
  #column(col: number): Column | undefined {
    if (col <= this.#latest - this.maxColumns) return undefined
    let column = this.#columns.get(col)
    if (!column) {
      column = { sums: new Map(), samples: 0 }
      this.#columns.set(col, column)
      if (col > this.#latest) {
        this.#latest = col
        for (const c of this.#columns.keys()) if (c <= col - this.maxColumns) this.#columns.delete(c)
      }
    }
    return column
  }

  /** The accumulated columns as JSON-compatible data, for {@link restore}. */
  snapshot(): LevelHeatmapSnapshot {
    const columns = Array.from(this.#columns, ([col, { sums, samples }]) => {
      const entry = [col, samples]
      for (const [row, sum] of sums) entry.push(row, sum)
      return entry
    })
    return { columnMs: this.columnMs, tick: this.tick, columns }
  }

  /**
   * Merges columns from a {@link snapshot}. Sums and sample counts add up, so a
   * column present in both stays a correct average. Returns `false`, changing
   * nothing, if the snapshot's column width or tick differs.
   */
  restore({ columnMs, tick, columns }: LevelHeatmapSnapshot): boolean {
    if (columnMs !== this.columnMs || tick !== this.tick || !Array.isArray(columns)) return false
    for (const entry of columns) {
      if (!Array.isArray(entry)) continue
      const [col, samples] = entry
      if (!Number.isInteger(col) || !(samples! > 0)) continue
      const column = this.#column(col!)
      if (!column) continue
      column.samples += samples!
      for (let i = 2; i + 1 < entry.length; i += 2) {
        const row = entry[i]!
        column.sums.set(row, (column.sums.get(row) ?? 0) + entry[i + 1]!)
      }
    }
    return true
  }

  toGrid(): HeatmapGrid | undefined {
    if (this.#columns.size === 0) return undefined
    let minCol = Number.POSITIVE_INFINITY
    let minRow = Number.POSITIVE_INFINITY
    let maxRow = Number.NEGATIVE_INFINITY
    for (const [col, { sums }] of this.#columns) {
      minCol = Math.min(minCol, col)
      for (const row of sums.keys()) {
        minRow = Math.min(minRow, row)
        maxRow = Math.max(maxRow, row)
      }
    }
    if (!Number.isFinite(minRow)) return undefined

    const cols = this.#latest - minCol + 1
    const rows = maxRow - minRow + 1
    const values = new Float32Array(cols * rows)
    let max = 0
    for (const [col, { sums, samples }] of this.#columns) {
      const offset = (col - minCol) * rows - minRow
      for (const [row, sum] of sums) {
        const v = sum / samples
        values[offset + row] = v
        if (v > max) max = v
      }
    }
    return {
      t0: minCol * this.columnMs,
      dt: this.columnMs,
      cols,
      // Rows are centered on their level price.
      p0: (minRow - 0.5) * this.tick,
      dp: this.tick,
      rows,
      values,
      max,
    }
  }
}
