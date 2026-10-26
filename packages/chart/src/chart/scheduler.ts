import { fiber } from '@thi.ng/fibers'
import type { Fiber, MaybeFiber } from '@thi.ng/fibers'

export interface RenderScheduler {
  /** Requests a redraw on the next animation frame. Repeated calls coalesce. */
  invalidate(): void
  /** Renders now if a redraw is pending, e.g. right after a resize cleared the canvas. */
  flush(): void
  /**
   * Runs background work (e.g. time-sliced heatmap rasterising) as a child
   * fiber, one step per frame. The loop stays awake until it finishes.
   */
  fork(work: MaybeFiber): Fiber
  stop(): void
}

/**
 * On-demand render loop. A fiber drives rendering, but the loop handler parks
 * it when nothing is dirty and no child work is active, instead of requesting
 * another frame. An unchanged chart costs nothing, not even an idle rAF.
 */
export function createRenderScheduler(
  render: () => void,
  raf: (fn: () => void) => number = requestAnimationFrame,
  caf: (id: number) => void = cancelAnimationFrame,
): RenderScheduler {
  let dirty = false
  let parked: (() => void) | undefined
  let frameId: number | undefined

  const loop = fiber(function* () {
    while (true) {
      if (dirty) {
        dirty = false
        try {
          render()
        } catch (err) {
          // A throwing generator would end the fiber, and with it all future
          // frames, so report the error asynchronously and keep the loop alive.
          queueMicrotask(() => {
            throw err
          })
        }
      }
      yield
    }
  })

  const wake = () => {
    if (!parked) return
    const next = parked
    parked = undefined
    frameId = raf(next)
  }

  loop.runWith((next) => {
    frameId = undefined
    if (dirty || loop.children.length > 0) frameId = raf(next)
    else parked = next
  })

  return {
    invalidate() {
      dirty = true
      wake()
    },
    flush() {
      if (!dirty) return
      dirty = false
      render()
    },
    fork(work) {
      const child = loop.fork(work)
      wake()
      return child
    },
    stop() {
      loop.cancel()
      parked = undefined
      if (frameId !== undefined) caf(frameId)
    },
  }
}
