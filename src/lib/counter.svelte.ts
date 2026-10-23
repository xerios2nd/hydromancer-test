export interface Counter {
  readonly count: number
  increment: (by?: number) => void
  reset: () => void
}

export function createCounter(initial = 0): Counter {
  let count = $state(initial)

  return {
    get count() {
      return count
    },
    increment(by = 1) {
      count += by
    },
    reset() {
      count = initial
    },
  }
}
