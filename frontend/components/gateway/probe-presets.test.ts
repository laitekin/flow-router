import assert from "node:assert/strict"
import test from "node:test"
import type { GatewayProbeSample } from "../../lib/api-types"
import {
  BUILTIN_TEMPLATES,
  buildProbePlan,
  buildProbeRequest,
  cacheGroup,
  cacheTestStats,
  evaluateSample,
  extractHtml,
  extractJson,
  extractSvg,
  matchExpect,
  needlePassphrase,
  normalizeTemplate,
  runVerdict,
  speedStats,
} from "./probe-presets.ts"
import { exportTemplates, importTemplates, loadUserTemplates, saveUserTemplates, upsertUserTemplate } from "./probe-template-store.ts"

const tpl = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id)!
const sample = (over: Partial<GatewayProbeSample> = {}): GatewayProbeSample => ({
  round: 1, label: "样本", ok: true, status_code: 200, input_tokens: 4000, cached_tokens: 3000, token_hit_rate: 0.75,
  output_tokens: 100, reasoning_tokens: null, first_token_ms: 500, first_text_ms: 600, duration_ms: 2500, output_tps: 50,
  text: "", reasoning_chars: 0, ...over,
})

test("cache plan: identical prefix, cold/repeat/changed rounds, fresh seed per run", () => {
  const t = { ...tpl("builtin:cache"), repeatRounds: 2, changedRounds: 3, prefixTokens: 2000 }
  const plan = buildProbePlan(t, "seed1")
  assert.deepEqual(plan.rounds.map((r) => cacheGroup(r.label)), ["cold", "repeat", "repeat", "changed", "changed", "changed"])
  const text = plan.rounds.map((r) => r.messages.at(-1)!.content)
  assert.equal(text[0], text[1])
  assert.notEqual(text[3], text[4])
  assert.ok(text[3].startsWith(text[0].slice(0, text[0].indexOf("End of document"))))
  assert.ok(plan.estimatedInputTokens > 1500 && plan.estimatedInputTokens < 6 * 3000)
  assert.notEqual(buildProbePlan(t, "seed2").rounds[0].messages[0].content, text[0])
})

test("needle plan hides a seed-derived passphrase at the requested depth and checks it", () => {
  const t = { ...tpl("builtin:needle"), haystackTokens: 2000, needleDepth: 0 }
  const plan = buildProbePlan(t, "abcdef0123")
  const pass = needlePassphrase("abcdef0123")
  assert.equal(plan.expect, pass)
  const doc = plan.rounds[0].messages[0].content
  assert.ok(doc.indexOf(pass) < 200, "depth 0 puts the needle at the start")
  const deep = buildProbePlan({ ...t, needleDepth: 100 }, "abcdef0123").rounds[0].messages[0].content
  assert.ok(deep.indexOf(pass) > deep.length * 0.8)
  assert.equal(evaluateSample("text", sample({ text: `The passphrase is ${pass.toUpperCase()}` }), plan.expect, "").at(-1)!.status, "pass")
})

test("prompt plan repeats samples and includes the system prompt; request maps params", () => {
  const t = { ...tpl("builtin:json"), repeat: 3 }
  const plan = buildProbePlan(t, "s")
  assert.equal(plan.rounds.length, 3)
  assert.deepEqual(plan.rounds[0].messages.map((m) => m.role), ["system", "user"])
  const req = buildProbeRequest(t, plan, "gpt", 9)
  assert.equal(req.route_id, 9)
  assert.equal(req.temperature, 0)
  assert.equal(req.rounds.length, 3)
  assert.equal(buildProbePlan(tpl("builtin:pelican"), "s").rounds[0].messages.length, 1)
})

test("extractors handle fences, chatter and invalid output", () => {
  assert.equal(extractSvg('Sure!\n```svg\n<svg viewBox="0 0 1 1"><circle/></svg>\n```'), '<svg viewBox="0 0 1 1"><circle/></svg>')
  assert.equal(extractSvg("<svg><g>"), null)
  assert.ok(extractHtml("```html\n<!DOCTYPE html><html><body>x</body></html>\n```")!.startsWith("<!DOCTYPE"))
  assert.equal(extractHtml("just words"), null)
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } })
  assert.deepEqual(extractJson('prefix {"a":[1,2]} suffix'), { ok: true, value: { a: [1, 2] } })
  assert.equal(extractJson("{nope").ok, false)
})

test("expectations support contains and /regex/flags, invalid regex is unknown", () => {
  assert.equal(matchExpect("Hello World", "world"), true)
  assert.equal(matchExpect("Hello", "/^h.l+o$/i"), true)
  assert.equal(matchExpect("Hello", "/^x/"), false)
  assert.equal(matchExpect("Hello", "/(/"), null)
  assert.equal(matchExpect("Hello", "  "), null)
})

test("checks: json keys, truncated output, failed request and verdicts", () => {
  const good = sample({ text: '{"name":"Mars","moons":[],"distance_au":1.5,"facts":[]}' })
  assert.ok(evaluateSample("json", good, "", "name,moons,facts").every((c) => c.status === "pass"))
  const missing = evaluateSample("json", sample({ text: '{"name":"Mars"}' }), "", "name, moons")
  assert.equal(missing.find((c) => c.label === "必需字段")!.detail, "缺少 moons")
  assert.equal(evaluateSample("svg", sample({ text: "<svg>", finish_reason: "length" }), "", "").some((c) => c.label === "输出完整"), true)
  assert.equal(evaluateSample("text", sample({ ok: false, error: "upstream HTTP 500" }), "", "")[0].detail, "upstream HTTP 500")
  assert.equal(runVerdict("svg", [sample({ text: "<svg></svg>" }), sample({ text: "no" })], "", ""), "partial")
  assert.equal(runVerdict("text", [], "", ""), "pending")
})

test("speed stats use medians and ignore failures", () => {
  const s = speedStats([sample({ first_token_ms: 100, output_tps: 40 }), sample({ first_token_ms: 300, output_tps: 60 }), sample({ ok: false, first_token_ms: 9999, output_tps: 1 })])
  assert.equal(s.firstTokenMS, 200)
  assert.equal(s.tps, 50)
  assert.equal(s.tpsMin, 40)
  assert.equal(s.ok, 2)
})

test("cache token rate uses total input and never treats unknown as a miss", () => {
  const stats = cacheTestStats([sample(), sample({ input_tokens: 6000, cached_tokens: 0 })])
  assert.equal(stats.tokenHitRate, 0.3)
  assert.equal(stats.hitRequests, 1)
  assert.equal(cacheTestStats([sample(), sample({ cached_tokens: null })]).tokenHitRate, null)
  assert.equal(cacheTestStats([sample(), sample({ ok: false })]).tokenHitRate, null)
  assert.equal(cacheTestStats([sample({ cached_tokens: 5000 })]).tokenHitRate, null)
})

test("normalizeTemplate clamps hostile or stale imports", () => {
  const t = normalizeTemplate({ kind: "cache", view: "svg", maxTokens: 1e9, temperature: 9, reasoning: "max" as never, repeat: -3, name: "" })
  assert.equal(t.view, "cache")
  assert.equal(t.maxTokens, 64000)
  assert.equal(t.temperature, 2)
  assert.equal(t.reasoning, "default")
  assert.equal(t.repeat, 1)
  assert.equal(t.name, "未命名模板")
  assert.equal(normalizeTemplate({ temperature: null }).temperature, null)
})

test("template store: save copies of built-ins, update in place, import with fresh IDs", () => {
  const mem = new Map<string, string>()
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  const first = upsertUserTemplate([], { ...tpl("builtin:pelican"), prompt: "Draw a cat" }, "我的猫")
  const saved = first.saved
  let list = first.list
  assert.ok(saved.id.startsWith("user:"))
  assert.equal(saved.builtin, undefined)
  ;({ list } = upsertUserTemplate(list, { ...saved, maxTokens: 2000 }))
  assert.equal(list.length, 1)
  assert.equal(list[0].maxTokens, 2000)
  saveUserTemplates(list, storage)
  assert.deepEqual(loadUserTemplates(storage), list)
  const imported = importTemplates(list, exportTemplates(list))
  assert.equal(imported.added, 1)
  assert.notEqual(imported.list[1].id, imported.list[0].id)
  assert.throws(() => importTemplates([], "[]"))
  assert.deepEqual(loadUserTemplates({ getItem: () => "{bad", setItem: () => {} }), [])
  assert.deepEqual(loadUserTemplates({ getItem: () => { throw new Error("blocked") }, setItem: () => {} }), [])
})

test("built-ins are flagged and have unique IDs", () => {
  assert.ok(BUILTIN_TEMPLATES.every((t) => t.builtin === true))
  assert.equal(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size, BUILTIN_TEMPLATES.length)
})

test("cache verdict judges warm rounds: unreported is unknown, zero hits fail", () => {
  const cold = sample({ label: "首次", cached_tokens: 0 })
  const warm = (cached: number | null) => sample({ label: "重复 #1", cached_tokens: cached })
  assert.equal(runVerdict("cache", [cold, warm(3000)], "", ""), "pass")
  assert.equal(runVerdict("cache", [cold, warm(null)], "", ""), "unknown")
  assert.equal(runVerdict("cache", [cold, warm(0)], "", ""), "fail")
  assert.equal(runVerdict("cache", [cold], "", ""), "unknown")
  assert.equal(runVerdict("cache", [sample({ ok: false })], "", ""), "fail")
})

test("image template sends image protocol and size", () => {
  const t = { ...tpl("builtin:image"), imageSize: "1536x1024" }
  const plan = buildProbePlan(t, "00ff00ff00ff00ff")
  const req = buildProbeRequest(t, plan, "gpt-image-1", 7)
  assert.equal(req.protocol, "image")
  assert.equal(req.image_size, "1536x1024")
  assert.match(plan.rounds[0].messages.at(-1)!.content, /pelican/)
  const plain = buildProbeRequest(tpl("builtin:image"), plan, "gpt-image-1", 7)
  assert.equal("image_size" in plain, false)
})

test("image view checks returned images", () => {
  assert.equal(evaluateSample("image", sample({ images: ["data:image/png;base64,aGk="] }), "", "")[0].status, "pass")
  assert.equal(evaluateSample("image", sample({ images: [] }), "", "")[0].status, "fail")
  // auto 协议跑生图模型时视图可能是 text，有图片同样按图片判定
  assert.equal(evaluateSample("text", sample({ images: ["https://x/a.png"] }), "", "")[0].label, "图片")
})

test("normalizeTemplate keeps image settings and rejects bad sizes", () => {
  const ok = normalizeTemplate({ name: "x", protocol: "image", view: "image", imageSize: "1024x1536" })
  assert.equal(ok.protocol, "image")
  assert.equal(ok.view, "image")
  assert.equal(ok.imageSize, "1024x1536")
  assert.equal(normalizeTemplate({ name: "x", imageSize: "huge" }).imageSize, undefined)
})
