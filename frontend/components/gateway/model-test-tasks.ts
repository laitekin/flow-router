// Independent tests share a small pool, rather than locking the entire page.
export class ModelTestPool {
  private active = 0
  private waiting: Array<() => void> = []
  private limit: number

  constructor(limit = 3) { this.limit = limit }

  get concurrency() { return this.limit }

  /** Raising the limit starts queued jobs immediately; lowering it lets running jobs finish. */
  setLimit(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!()
  }

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError")
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort)
        this.active++
        resolve()
      }
      const abort = () => {
        this.waiting = this.waiting.filter((next) => next !== start)
        reject(new DOMException("Cancelled", "AbortError"))
      }
      if (this.active < this.limit) start()
      else {
        this.waiting.push(start)
        signal.addEventListener("abort", abort, { once: true })
      }
    })
    try {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError")
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

/** testID "" is the quick availability check; other IDs are probe templates. */
export function modelTaskKey(groupID: number, model: string, routeID: number, testID = "") {
  return JSON.stringify([groupID, model, routeID, testID])
}

export function parseModelTaskKey(key: string) {
  const [groupID, model, routeID, testID = ""] = JSON.parse(key) as [number, string, number, string?]
  return { groupID, model, routeID, testID }
}
