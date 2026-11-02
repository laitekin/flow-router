import assert from "node:assert/strict"
import test from "node:test"
import { resolveModelSources } from "./gateway-utils.ts"
import type { GatewayModelListItem, GatewayRoute } from "../../lib/api-types.ts"

const routes: Partial<GatewayRoute>[] = [
  { id: 11, source_kind: "provider", gateway_provider_id: 1, enabled: true },
  { id: 12, source_kind: "provider", gateway_provider_id: 2, enabled: true },
  { id: 13, source_kind: "provider", gateway_provider_id: 3, enabled: false },
]
const providers = new Map([[1, "渠道 A"], [2, "渠道 B"], [3, "渠道 C"]])
const channels = new Map<number, string>()

test("explicit custom bindings do not expose unrelated routes as preference choices", () => {
  const model: GatewayModelListItem = {
    id: "model-a", source: "custom", preferred_route_id: 11,
    sources: [{ route_id: 11, channel_id: 0 }],
  }
  assert.deepEqual(resolveModelSources(model, routes, channels, providers).map((s) => s.route_id), [11])
  assert.equal(model.preferred_route_id, 11)
})

test("a disabled or deleted bound route does not fall back to every group route", () => {
  for (const id of [13, 404]) {
    const model: GatewayModelListItem = { id: "stale", source: "custom", preferred_route_id: id, sources: [{ route_id: id, channel_id: 0 }] }
    assert.deepEqual(resolveModelSources(model, routes, channels, providers), [])
  }
})

test("a disabled provider cannot be selected even when its route is enabled", () => {
  const model: GatewayModelListItem = { id: "model-a", source: "sync", sources: [{ route_id: 11, channel_id: 0 }, { route_id: 12, channel_id: 0 }] }
  assert.deepEqual(resolveModelSources(model, routes, channels, new Map([[1, "渠道 A"]])).map((s) => s.route_id), [11])
})

test("legacy unbound custom models retain enabled group-route choices", () => {
  const model: GatewayModelListItem = { id: "legacy", source: "custom" }
  assert.deepEqual(resolveModelSources(model, routes, channels, providers).map((s) => s.route_id), [11, 12])
})
