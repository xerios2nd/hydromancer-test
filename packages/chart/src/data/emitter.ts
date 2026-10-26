/** Minimal change notification for data sources the chart redraws from. */
export class ChangeEmitter {
  #listeners = new Set<() => void>()

  /** Returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  protected emitChange(): void {
    for (const fn of this.#listeners) fn()
  }
}
