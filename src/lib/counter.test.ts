import { describe, expect, it } from 'vitest'

import { createCounter } from './counter.svelte'

describe('createCounter', () => {
  it('starts at the initial value', () => {
    expect(createCounter(3).count).toBe(3)
  })

  it('increments by one by default', () => {
    const counter = createCounter()
    counter.increment()
    expect(counter.count).toBe(1)
  })

  it('resets back to the initial value', () => {
    const counter = createCounter(5)
    counter.increment(10)
    counter.reset()
    expect(counter.count).toBe(5)
  })
})
