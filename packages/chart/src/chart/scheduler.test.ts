import { describe, expect, it } from 'vitest'

import { createRenderScheduler } from './scheduler'

function setup() {
  const frames: (() => void)[] = []
  let renders = 0
  const scheduler = createRenderScheduler(
    () => renders++,
    (fn) => frames.push(fn),
    () => {},
  )
  const tick = () => frames.shift()?.()
  return { scheduler, frames, tick, renders: () => renders }
}

describe('createRenderScheduler', () => {
  it('requests no frames while nothing is invalidated', () => {
    const { frames, renders } = setup()
    expect(frames).toHaveLength(0)
    expect(renders()).toBe(0)
  })

  it('coalesces invalidations into one render, then parks', () => {
    const { scheduler, frames, tick, renders } = setup()
    scheduler.invalidate()
    scheduler.invalidate()
    expect(frames).toHaveLength(1)
    tick()
    expect(renders()).toBe(1)
    expect(frames).toHaveLength(0)
  })

  it('stays awake while forked work runs', () => {
    const { scheduler, frames, tick } = setup()
    let steps = 0
    scheduler.fork(function* () {
      for (; steps < 3; steps++) yield
    })
    while (frames.length > 0) tick()
    expect(steps).toBe(3)
  })

  it('flush renders synchronously and leaves nothing pending', () => {
    const { scheduler, tick, renders } = setup()
    scheduler.invalidate()
    scheduler.flush()
    expect(renders()).toBe(1)
    tick()
    expect(renders()).toBe(1)
  })
})
