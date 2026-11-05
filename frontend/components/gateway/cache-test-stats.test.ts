import assert from "node:assert/strict"
import test from "node:test"
import { cacheTestStats } from "./cache-test-stats.ts"

const sample = { round: 1, case: "repeat" as const, ok: true, status_code: 200, input_tokens: 4000, cached_tokens: 3000, token_hit_rate: .75, first_text_ms: 1000, duration_ms: 1200 }
test("cache token rate uses total input, weighted across all samples", () => {
  const stats = cacheTestStats([sample, { ...sample, input_tokens: 6000, cached_tokens: 0 }])
  assert.equal(stats.tokenHitRate, .3)
  assert.equal(stats.hitRequests, 1)
  assert.equal(stats.reported, 2)
})
test("missing fields and failed samples cannot inflate a mixed test rate", () => {
  assert.equal(cacheTestStats([sample, { ...sample, cached_tokens: null }]).tokenHitRate, null)
  assert.equal(cacheTestStats([sample, { ...sample, ok: false }]).tokenHitRate, null)
  assert.equal(cacheTestStats([]).tokenHitRate, null)
  assert.equal(cacheTestStats([{ ...sample, cached_tokens: 5000 }]).tokenHitRate, null)
})
