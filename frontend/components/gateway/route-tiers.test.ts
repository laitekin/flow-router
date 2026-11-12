import assert from "node:assert/strict"
import test from "node:test"
import { assignRouteTiers, tierLabel } from "./route-tiers.ts"

const mk = (id: string, rate: number, weight = 1, state: "active" | "paused" | "disabled" = "active", index = 0) =>
  ({ item: id, index, rate, weight, state })

test("same rate shares a tier and splits by weight", () => {
  const out = assignRouteTiers([mk("a", 1, 3, "active", 0), mk("b", 0.5, 1, "active", 1), mk("c", 1, 1, "active", 2)])
  assert.deepEqual(out.map((x) => [x.item, x.tier]), [["b", 0], ["a", 1], ["c", 1]])
  assert.equal(out[1].share, 0.75)
  assert.equal(out[2].share, 0.25)
  assert.equal(out[1].tierSize, 2)
})

test("desc direction prefers higher rate", () => {
  const out = assignRouteTiers([mk("a", 1, 1, "active", 0), mk("b", 2, 1, "active", 1)], "desc")
  assert.equal(out[0].item, "b")
  assert.equal(tierLabel(out[0].tier), "主")
  assert.equal(tierLabel(out[1].tier), "备1")
})

test("paused and disabled routes have no tier and go last", () => {
  const out = assignRouteTiers([mk("p", 0.1, 1, "paused", 0), mk("a", 1, 1, "active", 1), mk("d", 0.1, 1, "disabled", 2)])
  assert.deepEqual(out.map((x) => [x.item, x.tier]), [["a", 0], ["p", -1], ["d", -1]])
})

test("zero weight routes are fallback-only within tier", () => {
  const out = assignRouteTiers([mk("a", 1, 0, "active", 0), mk("b", 1, 2, "active", 1)])
  assert.equal(out.find((x) => x.item === "a")?.share, 0)
  assert.equal(out.find((x) => x.item === "b")?.share, 1)
})
