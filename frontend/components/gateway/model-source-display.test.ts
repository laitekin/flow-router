import assert from "node:assert/strict"
import test from "node:test"
import { modelSourceLabel, modelSourceTests, resolveModelSources } from "./gateway-utils.ts"
import type { GatewayModelListItem, GatewayModelTestResult, GatewayRoute } from "../../lib/api-types.ts"

const routes: Partial<GatewayRoute>[] = [
  { id: 31, source_kind: "provider", gateway_provider_id: 21, enabled: true },
  { id: 32, source_kind: "provider", gateway_provider_id: 19, enabled: true },
  { id: 43, source_kind: "provider", gateway_provider_id: 30, enabled: true },
  { id: 44, source_kind: "provider", gateway_provider_id: 31, enabled: false },
]
const names = new Map([[21, "天枢｜DeepSeek（自部署）｜上游分组 ID：100"], [19, "超稳｜Deepseek｜上游分组 ID：19"], [30, "超稳｜GLM｜上游分组 ID：18"]])
const resolve = (m: GatewayModelListItem) => resolveModelSources(m, routes, new Map(), names)

test("custom DeepSeek entries display only their real bindings in saved order", () => {
  const actual = resolve({ id: "deepseek-v4-pro", source: "custom", sources: [{ route_id: 31, channel_id: 0 }, { route_id: 32, channel_id: 0 }] })
  assert.deepEqual(actual.map((s) => s.route_id), [31, 32])
  assert.deepEqual(actual.map((s) => s.label), ["天枢 · DeepSeek（自部署）", "超稳 · Deepseek"])
})

test("a GLM model with one binding displays one channel, not every provider", () => {
  assert.deepEqual(resolve({ id: "glm", source: "custom", sources: [{ route_id: 43, channel_id: 0 }] }).map((s) => s.label), ["超稳 · GLM"])
})

test("deleted and disabled explicit bindings never fall back to unrelated providers", () => {
  for (const route_id of [44, 999]) {
    assert.deepEqual(resolve({ id: "stale", source: "custom", sources: [{ route_id, channel_id: 0 }] }), [])
  }
})

test("unbound legacy custom models keep their actual all-route behavior", () => {
  assert.deepEqual(resolve({ id: "legacy", source: "custom" }).map((s) => s.route_id), [31, 32, 43])
})

test("a disabled provider is omitted even if its bound route is still enabled", () => {
  const model: GatewayModelListItem = { id: "deepseek", source: "custom", sources: [{ route_id: 31, channel_id: 0 }, { route_id: 32, channel_id: 0 }] }
  assert.deepEqual(resolveModelSources(model, routes, new Map(), new Map([[21, "天枢"]])).map((s) => s.route_id), [31])
})

test("labels remove administrative IDs while preserving pool distinctions", () => {
  assert.equal(modelSourceLabel("天枢 | GLM（官方） | 上游分组 ID: 101"), "天枢 · GLM（官方）")
  assert.equal(modelSourceLabel("团队 ID: 7"), "团队 ID: 7")
})

test("status counts ignore tests from sources no longer bound to the model", () => {
  const sources = resolve({ id: "glm", source: "custom", sources: [{ route_id: 43, channel_id: 0 }] })
  const stale = { route_id: 32, channel_id: 0, ok: false } as GatewayModelTestResult
  const current = { route_id: 43, channel_id: 0, ok: true } as GatewayModelTestResult
  assert.deepEqual(modelSourceTests(sources, [stale, current]), [current])
})
