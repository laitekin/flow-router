import assert from "node:assert/strict"
import test from "node:test"
import { ModelTestPool, modelTaskKey } from "./model-test-tasks.ts"

test("different model/source jobs run concurrently, while the pool bounds load", async () => {
  const pool = new ModelTestPool(2)
  let active = 0
  let peak = 0
  const release: Array<() => void> = []
  const start = () => pool.run(new AbortController().signal, async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => release.push(resolve))
    active--
  })
  const jobs = [start(), start(), start()]
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active, 2)
  release.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active, 2)
  release.splice(0).forEach((resolve) => resolve())
  await Promise.all(jobs)
  assert.equal(peak, 2)
})

test("cancelled queued jobs never call the upstream and do not block later jobs", async () => {
  const pool = new ModelTestPool(1)
  let release!: () => void
  const first = pool.run(new AbortController().signal, () => new Promise<void>((resolve) => { release = resolve }))
  const cancel = new AbortController()
  let called = false
  const queued = pool.run(cancel.signal, async () => { called = true })
  const rejected = assert.rejects(queued, { name: "AbortError" })
  cancel.abort()
  await rejected
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await first
  assert.equal(called, false)
  assert.equal(await pool.run(new AbortController().signal, async () => "next"), "next")
})

test("group/model/route task keys cannot collide or leak across groups", () => {
  assert.notEqual(modelTaskKey(7, "deepseek#12", 3), modelTaskKey(7, "deepseek", 123))
  assert.notEqual(modelTaskKey(7, "deepseek", 3), modelTaskKey(8, "deepseek", 3))
})
