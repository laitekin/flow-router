// Independent tests share a small pool, rather than locking the entire page.
export class ModelTestPool {
  private active = 0
  private waiting: Array<() => void> = []
  private limit: number

  constructor(limit = 3) { this.limit = limit }

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

export function modelTaskKey(groupID: number, model: string, routeID: number) {
  return JSON.stringify([groupID, model, routeID])
}
