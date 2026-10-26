import { map, range } from '@thi.ng/transducers'

/** Smallest 1, 2 or 5 × 10^k step giving at most `maxTicks` ticks across `span`. */
export function niceStep(span: number, maxTicks: number): number {
  const raw = span / Math.max(1, maxTicks)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
}

/** Multiples of `step` within `[a, b]`. Each is computed directly, so no float drift accumulates. */
export function ticks(a: number, b: number, step: number): number[] {
  return [...map((k: number) => k * step, range(Math.ceil(a / step), Math.floor(b / step) + 1))]
}

const S = 1_000
const M = 60 * S
const H = 60 * M
const D = 24 * H
const TIME_STEPS = [S, 5 * S, 15 * S, 30 * S, M, 5 * M, 15 * M, 30 * M, H, 2 * H, 4 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D]

/**
 * Time grid step giving at most `maxTicks` ticks. Multiples of these steps
 * counted from the epoch fall on UTC boundaries, which matches the UTC labels.
 */
export function timeStep(spanMs: number, maxTicks: number): number {
  return TIME_STEPS.find((s) => spanMs / s <= maxTicks) ?? TIME_STEPS.at(-1)!
}
