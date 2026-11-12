import assert from "node:assert/strict"
import test from "node:test"
import { failedRoutePulls, filterBenchModels, mergeBenchModels } from "./model-bench-catalog.ts"

test("saved models come first and keep their bindings; reported-only models are deduped and bound to reporters", () => {
  const list = mergeBenchModels(
    [
      { id: "gpt-5", source: "sync", sources: [{ route_id: 1, channel_id: 9 }] },
      { id: "my-custom", source: "custom" },
    ],
    [
      { id: "gpt-5", sources: [{ route_id: 1, channel_id: 9 }, { route_id: 2, channel_id: 0 }] },
      { id: "zeta", sources: [{ route_id: 2, channel_id: 0 }] },
      { id: "alpha", sources: [{ route_id: 3, channel_id: 7 }, { route_id: 3, channel_id: 7 }] },
    ],
  )
  assert.deepEqual(list.map((m) => [m.item.id, m.saved]), [
    ["gpt-5", true], ["my-custom", true], ["alpha", false], ["zeta", false],
  ])
  // saved binding untouched even though route 2 also reports it
  assert.deepEqual(list[0].item.sources, [{ route_id: 1, channel_id: 9 }])
  assert.deepEqual(list[0].reportedBy, [1, 2])
  assert.deepEqual(list[2].reportedBy, [3])
  assert.deepEqual(list[3].item.sources, [{ route_id: 2, channel_id: 0 }])
})

test("search matches all terms case-insensitively", () => {
  const list = mergeBenchModels([], [
    { id: "claude-sonnet-4-5" }, { id: "Claude-Opus-4" }, { id: "gpt-5-mini" },
  ])
  assert.deepEqual(filterBenchModels(list, "CLAUDE 4").map((m) => m.item.id), ["Claude-Opus-4", "claude-sonnet-4-5"])
  assert.deepEqual(filterBenchModels(list, "  ").length, 3)
  assert.deepEqual(filterBenchModels(list, "opus mini").length, 0)
})

test("failed pulls exclude disabled routes", () => {
  const base = { source_kind: "monitor", label: "x", model_count: 0 }
  const got = failedRoutePulls([
    { ...base, route_id: 1, ok: true, skipped: false },
    { ...base, route_id: 2, ok: false, skipped: true, skip_reason: "路由已禁用" },
    { ...base, route_id: 3, ok: false, skipped: true, skip_reason: "未确保上游密钥" },
    { ...base, route_id: 4, ok: false, skipped: false, error: "GET x: 401" },
  ])
  assert.deepEqual(got.map((r) => r.route_id), [3, 4])
})
