import { describe, expect, it } from 'vitest'

import { LevelHeatmap, sigFigStep } from './levelHeatmap'

const levels = (...l: [number, number][]) => l.map(([px, sz]) => ({ px, sz }))

describe('sigFigStep', () => {
  it('matches 5 significant figure aggregation', () => {
    expect(sigFigStep(104_321, 5)).toBe(10)
    expect(sigFigStep(3_456.7, 5)).toBeCloseTo(0.1)
  })
})

describe('LevelHeatmap', () => {
  it('averages size per bucket over the snapshots in a column', () => {
    const h = new LevelHeatmap({ columnMs: 1000, tick: 10 })
    h.add(0, levels([100, 4], [110, 2]))
    h.add(500, levels([100, 2]))
    const g = h.toGrid()!
    expect(g).toMatchObject({ t0: 0, cols: 1, rows: 2, p0: 95, dp: 10 })
    // Size at 100 averaged over 2 samples. 110 was missing from the second sample, so it counts as 0.
    expect([...g.values]).toEqual([3, 1])
    expect(g.max).toBe(3)
  })

  it('lays columns out by time, keeping empty columns', () => {
    const h = new LevelHeatmap({ columnMs: 1000, tick: 10 })
    h.add(0, levels([100, 1]))
    h.add(2500, levels([120, 5]))
    const g = h.toGrid()!
    expect(g.cols).toBe(3)
    expect(g.rows).toBe(3)
    // Column-major: col * rows + row.
    expect(g.values[0]).toBe(1)
    expect(g.values[2 * 3 + 2]).toBe(5)
  })

  it('drops columns beyond maxColumns', () => {
    const h = new LevelHeatmap({ columnMs: 1000, tick: 10, maxColumns: 2 })
    for (const t of [0, 1000, 2000]) h.add(t, levels([100, 1]))
    expect(h.toGrid()).toMatchObject({ t0: 1000, cols: 2 })
  })

  it('restores a JSON round-tripped snapshot, merging columns present in both', () => {
    const a = new LevelHeatmap({ columnMs: 1000, tick: 10 })
    a.add(0, levels([100, 4]))
    a.add(1000, levels([100, 2]))
    const snapshot = JSON.parse(JSON.stringify(a.snapshot()))

    const b = new LevelHeatmap({ columnMs: 1000, tick: 10 })
    b.add(1500, levels([100, 6]))
    expect(b.restore(snapshot)).toBe(true)
    const g = b.toGrid()!
    expect(g).toMatchObject({ t0: 0, cols: 2, rows: 1 })
    // Column 1 averages the cached sample (2) and the live one (6).
    expect([...g.values]).toEqual([4, 4])
  })

  it('rejects a snapshot with another tick, and drops restored columns beyond maxColumns', () => {
    const a = new LevelHeatmap({ columnMs: 1000, tick: 10 })
    a.add(0, levels([100, 1]))
    expect(new LevelHeatmap({ columnMs: 1000, tick: 1 }).restore(a.snapshot())).toBe(false)

    const b = new LevelHeatmap({ columnMs: 1000, tick: 10, maxColumns: 2 })
    b.add(5000, levels([100, 1]))
    b.restore(a.snapshot())
    expect(b.toGrid()).toMatchObject({ t0: 5000, cols: 1 })
  })
})
