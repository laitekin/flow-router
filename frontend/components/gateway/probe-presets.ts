import type { GatewayImageOptions, GatewayProbeRequest, GatewayProbeRound, GatewayProbeSample } from "../../lib/api-types"

/**
 * A probe template describes one kind of model experiment. The backend only
 * executes rounds of messages; everything scenario-specific (how prompts are
 * built, how answers are judged and shown) lives here so users can tweak the
 * built-ins and save their own variants without backend changes.
 */
export type ProbeKind = "prompt" | "cache" | "needle"
export type ProbeView = "text" | "svg" | "html" | "json" | "speed" | "cache" | "image"
export type ProbeReasoning = GatewayProbeRequest["reasoning"]
export type ProbeProtocol = GatewayProbeRequest["protocol"]

export interface ProbeTemplate {
  id: string
  name: string
  description: string
  builtin?: boolean
  kind: ProbeKind
  view: ProbeView
  system: string
  prompt: string
  /** prompt/needle: how many identical samples to collect */
  repeat: number
  protocol: ProbeProtocol
  maxTokens: number
  /** null = do not send, keep the provider default */
  temperature: number | null
  reasoning: ProbeReasoning
  timeoutSec: number
  intervalSec: number
  continueOnError: boolean
  /** contains (case-insensitive) or /regex/flags; empty = no check */
  expect: string
  /** json view: comma separated keys that must exist */
  jsonKeys: string
  /** cache: synthetic shared prefix size, plus rounds per scenario */
  prefixTokens: number
  repeatRounds: number
  changedRounds: number
  /** needle: haystack size and where the needle sits (0 = start, 100 = end) */
  haystackTokens: number
  needleDepth: number
  /** image 协议的生图尺寸，空 = 1024x1024 */
  imageSize?: string
  /** image 协议的 gpt-image 参数；空字段不发送 */
  imageOptions?: GatewayImageOptions
}

export const IMAGE_SIZE_PATTERN = /^(auto|\d{3,4}x\d{3,4})$/

/** gpt-image-2 系任意尺寸规则：边长 16 的倍数、长宽比 ≤ 3:1、最大 3840x2160（>2560x1440 为实验性） */
export function imageSizeHint(size: string | undefined): string | null {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "")
  if (!m) return null
  const w = Number(m[1]), h = Number(m[2])
  if (w % 16 || h % 16) return "gpt-image-2 系要求宽高都是 16 的倍数"
  if (Math.max(w, h) / Math.min(w, h) > 3) return "长宽比需在 1:3 到 3:1 之间"
  if (Math.max(w, h) > 3840 || Math.min(w, h) > 2160) return "超出 3840x2160 上限"
  if (w * h > 2560 * 1440) return "超过 2560x1440，官方标为实验性"
  return null
}

function normalizeImageOptions(raw: unknown): GatewayImageOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(v) ? (v as T) : undefined
  const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined)
  const out: GatewayImageOptions = {
    quality: pick(r.quality, ["auto", "low", "medium", "high", "xhigh", "max"] as const),
    background: pick(r.background, ["auto", "opaque", "transparent"] as const),
    output_format: pick(r.output_format, ["png", "jpeg", "webp", "gif", "svg"] as const),
    output_compression: int(r.output_compression, 0, 100),
    n: int(r.n, 1, 10),
    moderation: pick(r.moderation, ["auto", "low"] as const),
    frame_count: int(r.frame_count, 2, 16),
    frame_duration_ms: int(r.frame_duration_ms, 20, 655_350),
  }
  const clean = cleanImageOptions(out)
  return clean
}

/** 去掉空值与当前格式下无效的字段（与后端校验一致，避免请求被拒） */
export function cleanImageOptions(o: GatewayImageOptions | undefined): GatewayImageOptions | undefined {
  if (!o) return undefined
  const fmt = o.output_format
  const out: GatewayImageOptions = {}
  if (o.quality) out.quality = o.quality
  if (o.background && !(o.background === "transparent" && fmt && fmt !== "png" && fmt !== "webp")) out.background = o.background
  if (fmt) out.output_format = fmt
  if (o.output_compression != null && (fmt === "jpeg" || fmt === "webp")) out.output_compression = o.output_compression
  if (o.n && o.n > 1 && fmt !== "svg") out.n = o.n
  if (o.moderation) out.moderation = o.moderation
  if (fmt === "gif") {
    if (o.frame_count) out.frame_count = o.frame_count
    if (o.frame_duration_ms) out.frame_duration_ms = o.frame_duration_ms
  }
  return Object.keys(out).length ? out : undefined
}

export const VIEW_LABELS: Record<ProbeView, string> = {
  text: "文本",
  svg: "SVG 图像",
  html: "HTML 页面",
  json: "JSON",
  speed: "速度",
  cache: "缓存",
  image: "生成图片",
}

export const REASONING_LABELS: Record<ProbeReasoning, string> = {
  default: "渠道默认",
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
}

const BASE: Omit<ProbeTemplate, "id" | "name" | "description" | "kind" | "view" | "prompt"> = {
  system: "",
  repeat: 1,
  protocol: "auto",
  maxTokens: 1024,
  temperature: null,
  reasoning: "default",
  timeoutSec: 90,
  intervalSec: 0,
  continueOnError: false,
  expect: "",
  jsonKeys: "",
  prefixTokens: 4000,
  repeatRounds: 2,
  changedRounds: 2,
  haystackTokens: 8000,
  needleDepth: 50,
}

const BUILTIN_LIST: ProbeTemplate[] = [
  {
    ...BASE,
    id: "builtin:cache",
    name: "缓存命中",
    description: "固定渠道发送同一段长前缀：首次、重复输入、修改末尾，对比缓存读取 token 与首字时间。",
    kind: "cache",
    view: "cache",
    prompt: "",
    maxTokens: 64,
    reasoning: "off",
    intervalSec: 5,
    timeoutSec: 30,
  },
  {
    ...BASE,
    id: "builtin:pelican",
    name: "鹈鹕 SVG",
    description: "经典「鹈鹕骑自行车」绘图题，直接渲染 SVG，多渠道并排对比画功与审美。",
    kind: "prompt",
    view: "svg",
    prompt: "Generate an SVG of a pelican riding a bicycle. Reply with only the SVG code.",
    maxTokens: 8192,
    timeoutSec: 240,
  },
  {
    ...BASE,
    id: "builtin:speed",
    name: "速度吞吐",
    description: "生成一段较长文本，统计首 token、首字、输出 token/s 与总耗时。",
    kind: "prompt",
    view: "speed",
    prompt: "Write a vivid 600-word short story about a lighthouse keeper who discovers a message in a bottle. Plain text only.",
    repeat: 3,
    maxTokens: 1500,
    reasoning: "off",
    timeoutSec: 120,
  },
  {
    ...BASE,
    id: "builtin:needle",
    name: "大海捞针",
    description: "在长文本指定深度藏一个随机口令，检验长上下文检索能力（自动校验答案）。",
    kind: "needle",
    view: "text",
    prompt: "What is the secret passphrase mentioned in the document? Answer with the passphrase only.",
    maxTokens: 256,
    timeoutSec: 120,
  },
  {
    ...BASE,
    id: "builtin:json",
    name: "JSON 指令遵循",
    description: "要求严格输出 JSON，自动校验能否解析及必需字段，检查格式遵循能力。",
    kind: "prompt",
    view: "json",
    system: "You are an API. Output strictly valid JSON with no markdown fences and no extra text.",
    prompt: 'Return a JSON object describing the planet Mars with keys "name" (string), "moons" (array of strings), "distance_au" (number) and "facts" (array of exactly 3 strings).',
    jsonKeys: "name,moons,distance_au,facts",
    maxTokens: 1024,
    temperature: 0,
  },
  {
    ...BASE,
    id: "builtin:html",
    name: "HTML 小作品",
    description: "让模型写一个单文件网页，在沙箱中直接运行预览，适合对比前端生成能力。",
    kind: "prompt",
    view: "html",
    prompt: "Create a single self-contained HTML file (inline CSS and JS, no external resources) that shows an animated analog clock with a smooth second hand. Reply with only the HTML.",
    maxTokens: 8192,
    timeoutSec: 240,
  },
  {
    ...BASE,
    id: "builtin:image",
    name: "生图",
    description: "调用 /v1/images/generations 生成一张图并直接预览，适合 gpt-image、dall-e、flux、seedream 等生图模型。",
    kind: "prompt",
    view: "image",
    protocol: "image",
    prompt: "A pelican riding a bicycle along a seaside road, flat vector illustration, bright colors.",
    timeoutSec: 240,
  },
  {
    ...BASE,
    id: "builtin:image-transparent",
    name: "生图 · 透明背景",
    description: "gpt-image 系透明背景 PNG（贴纸 / 图标），检查上游是否保留 alpha 通道。",
    kind: "prompt",
    view: "image",
    protocol: "image",
    prompt: "A glossy sticker of a cartoon fox head, thick white outline, no background.",
    timeoutSec: 240,
    imageOptions: { background: "transparent", output_format: "png", quality: "medium" },
  },
  {
    ...BASE,
    id: "builtin:image-wide",
    name: "生图 · 超宽 2K",
    description: "gpt-image-2 系任意尺寸：2560x1440 横幅 + 中文排版，检验大图与文字渲染。",
    kind: "prompt",
    view: "image",
    protocol: "image",
    prompt: "A cinematic banner for a coffee brand named 「山间咖啡」, misty mountains at dawn, the brand name rendered clearly in elegant Chinese calligraphy.",
    timeoutSec: 300,
    imageSize: "2560x1440",
    imageOptions: { quality: "high", output_format: "jpeg", output_compression: 85 },
  },
  {
    ...BASE,
    id: "builtin:image-gif",
    name: "生图 · GIF 动图",
    description: "output_format=gif（需上游开通 GIF 预览），检验多帧动图能否正常返回。",
    kind: "prompt",
    view: "image",
    protocol: "image",
    prompt: "A paper airplane looping through the sky, simple flat style, seamless loop.",
    timeoutSec: 300,
    imageSize: "1024x1024",
    imageOptions: { output_format: "gif", frame_count: 8, frame_duration_ms: 150, quality: "low" },
  },
  {
    ...BASE,
    id: "builtin:image-svg",
    name: "生图 · SVG 矢量",
    description: "output_format=svg（需上游开通），返回矢量图，检验 SVG 输出与渲染。",
    kind: "prompt",
    view: "image",
    protocol: "image",
    prompt: "A minimalist line-art logo of a lighthouse, two colors.",
    timeoutSec: 300,
    imageOptions: { output_format: "svg" },
  },
  {
    ...BASE,
    id: "builtin:custom",
    name: "自定义",
    description: "自己写系统提示词和问题，可选呈现方式与自动校验（包含文本或 /正则/）。",
    kind: "prompt",
    view: "text",
    prompt: "用一句话介绍你自己，并说明你的模型名称。",
  },
]

export const BUILTIN_TEMPLATES: ProbeTemplate[] = BUILTIN_LIST.map((t) => ({ ...t, builtin: true }))

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback
const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback)

export const PROBE_LIMITS = {
  repeat: [1, 6],
  maxTokens: [1, 64000],
  timeoutSec: [5, 600],
  intervalSec: [0, 120],
  prefixTokens: [1024, 100000],
  repeatRounds: [1, 5],
  changedRounds: [0, 5],
  haystackTokens: [1000, 120000],
  needleDepth: [0, 100],
} as const

/** Fill defaults and clamp values, e.g. for imported or older saved templates. */
export function normalizeTemplate(raw: Partial<ProbeTemplate> & Record<string, unknown>): ProbeTemplate {
  const kind = oneOf(raw.kind, ["prompt", "cache", "needle"] as const, "prompt")
  const L = PROBE_LIMITS
  const temp = raw.temperature == null || raw.temperature === ("" as unknown) ? null : Number(raw.temperature)
  return {
    id: str(raw.id, 80) || newTemplateID(),
    name: str(raw.name, 40).trim() || "未命名模板",
    description: str(raw.description, 300),
    builtin: raw.builtin === true ? true : undefined,
    kind,
    view: kind === "cache" ? "cache" : oneOf(raw.view, ["text", "svg", "html", "json", "speed", "image"] as const, "text"),
    system: str(raw.system, 200_000),
    prompt: str(raw.prompt, 200_000),
    repeat: clampInt(raw.repeat, L.repeat[0], L.repeat[1], BASE.repeat),
    protocol: oneOf(raw.protocol, ["auto", "chat", "responses", "image"] as const, "auto"),
    maxTokens: clampInt(raw.maxTokens, L.maxTokens[0], L.maxTokens[1], BASE.maxTokens),
    temperature: temp != null && Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : null,
    reasoning: oneOf(raw.reasoning, ["default", "off", "low", "medium", "high"] as const, "default"),
    timeoutSec: clampInt(raw.timeoutSec, L.timeoutSec[0], L.timeoutSec[1], BASE.timeoutSec),
    intervalSec: clampInt(raw.intervalSec, L.intervalSec[0], L.intervalSec[1], BASE.intervalSec),
    continueOnError: raw.continueOnError === true,
    expect: str(raw.expect, 500),
    jsonKeys: str(raw.jsonKeys, 500),
    prefixTokens: clampInt(raw.prefixTokens, L.prefixTokens[0], L.prefixTokens[1], BASE.prefixTokens),
    repeatRounds: clampInt(raw.repeatRounds, L.repeatRounds[0], L.repeatRounds[1], BASE.repeatRounds),
    changedRounds: clampInt(raw.changedRounds, L.changedRounds[0], L.changedRounds[1], BASE.changedRounds),
    haystackTokens: clampInt(raw.haystackTokens, L.haystackTokens[0], L.haystackTokens[1], BASE.haystackTokens),
    needleDepth: clampInt(raw.needleDepth, L.needleDepth[0], L.needleDepth[1], BASE.needleDepth),
    imageSize: IMAGE_SIZE_PATTERN.test(str(raw.imageSize, 16).trim()) ? str(raw.imageSize, 16).trim() : undefined,
    imageOptions: normalizeImageOptions(raw.imageOptions),
  }
}

export function newTemplateID() {
  return `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function randomSeed() {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export interface ProbePlan {
  rounds: GatewayProbeRound[]
  /** answer check used for this run (needle generates its own) */
  expect: string
  /** rough input token estimate for one source */
  estimatedInputTokens: number
}

const TOKENS_PER_RECORD = 30
const NEEDLE_WORDS = ["amber", "cobalt", "falcon", "harbor", "juniper", "lantern", "meadow", "nebula", "orchid", "quartz", "saffron", "tundra"]
const HAY = [
  "The regional logistics office reviewed shipping schedules, noting that coastal routes remained steady while inland freight saw modest delays.",
  "Committee members discussed the maintenance budget for the northern facilities and agreed to postpone roof repairs until spring.",
  "Field researchers recorded mild temperatures across the valley, with light winds and occasional cloud cover throughout the afternoon.",
  "The library catalogue was updated to include several new volumes on maritime history, agriculture, and early industrial design.",
  "Quarterly inventory counts matched expectations; minor discrepancies in packaging supplies were traced to a labelling error.",
]

const user = (content: string) => ({ role: "user" as const, content })
const withSystem = (system: string, content: string) =>
  system.trim() ? [{ role: "system" as const, content: system }, user(content)] : [user(content)]
const estimate = (rounds: GatewayProbeRound[]) =>
  Math.round(rounds.reduce((sum, r) => sum + r.messages.reduce((s, m) => s + m.content.length, 0), 0) / 4)

export function needlePassphrase(seed: string) {
  const n = parseInt(seed.slice(0, 8), 16) || 0
  return `${NEEDLE_WORDS[n % NEEDLE_WORDS.length]}-${(n % 9000) + 1000}`
}

export function buildProbePlan(t: ProbeTemplate, seed: string): ProbePlan {
  if (t.kind === "cache") {
    const records = Math.max(1, Math.ceil(t.prefixTokens / TOKENS_PER_RECORD))
    let prefix = `Synthetic cache experiment ${seed}. Read the records and reply only OK.\n`
    for (let i = 0; i < records; i++) {
      prefix += `Record ${String(i).padStart(4, "0")}: warehouse inventory item copper steel timber glass; received 48 units, dispatched 17 units, remaining 31 units; verified stable.\n`
    }
    const rounds: GatewayProbeRound[] = [{ label: "首次", messages: withSystem(t.system, prefix + "End of document. Reply only OK.") }]
    for (let i = 1; i <= t.repeatRounds; i++) {
      rounds.push({ label: `重复 #${i}`, messages: withSystem(t.system, prefix + "End of document. Reply only OK.") })
    }
    for (let i = 1; i <= t.changedRounds; i++) {
      rounds.push({ label: `改尾 #${i}`, messages: withSystem(t.system, prefix + `End of document. Verification variant ${i}. Reply only OK.`) })
    }
    return { rounds, expect: "", estimatedInputTokens: estimate(rounds) }
  }
  if (t.kind === "needle") {
    const pass = needlePassphrase(seed)
    const sentences: string[] = []
    let chars = 0
    for (let i = 0; chars < t.haystackTokens * 4; i++) {
      const s = `[${i + 1}] ${HAY[i % HAY.length]}`
      sentences.push(s)
      chars += s.length + 1
    }
    const at = Math.round((sentences.length * t.needleDepth) / 100)
    sentences.splice(at, 0, `[note] Important: the secret passphrase is "${pass}". Remember it.`)
    const doc = `<document id="${seed}">\n${sentences.join("\n")}\n</document>\n\n${t.prompt || "What is the secret passphrase mentioned in the document? Answer with the passphrase only."}`
    const rounds = Array.from({ length: t.repeat }, (_, i) => ({ label: t.repeat > 1 ? `样本 #${i + 1}` : "检索", messages: withSystem(t.system, doc) }))
    return { rounds, expect: pass, estimatedInputTokens: estimate(rounds) }
  }
  const rounds = Array.from({ length: t.repeat }, (_, i) => ({ label: t.repeat > 1 ? `样本 #${i + 1}` : "样本", messages: withSystem(t.system, t.prompt) }))
  return { rounds, expect: t.expect, estimatedInputTokens: estimate(rounds) }
}

export function buildProbeRequest(t: ProbeTemplate, plan: ProbePlan, model: string, routeID: number): GatewayProbeRequest {
  return {
    model,
    route_id: routeID,
    protocol: t.protocol,
    ...(t.imageSize ? { image_size: t.imageSize } : {}),
    ...(t.protocol === "image" && cleanImageOptions(t.imageOptions) ? { image_options: cleanImageOptions(t.imageOptions) } : {}),
    rounds: plan.rounds,
    interval_sec: t.intervalSec,
    max_tokens: t.maxTokens,
    temperature: t.temperature,
    reasoning: t.reasoning,
    timeout_sec: t.timeoutSec,
    continue_on_error: t.continueOnError,
  }
}

/* ---------------- answer extraction and checks ---------------- */

const FENCE = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/

export function stripFences(text: string) {
  const m = text.match(FENCE)
  return (m ? m[1] : text).trim()
}

export function extractSvg(text: string): string | null {
  const m = text.match(/<svg[\s>][\s\S]*?<\/svg>/i)
  return m ? m[0] : null
}

export function extractHtml(text: string): string | null {
  const body = stripFences(text)
  const doc = body.match(/<!doctype html[\s\S]*<\/html>/i) ?? body.match(/<html[\s\S]*<\/html>/i)
  if (doc) return doc[0]
  return /<(body|div|canvas|svg|main|style|script)[\s>]/i.test(body) ? body : null
}

export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = [text.trim(), stripFences(text)]
  const brace = text.indexOf("{")
  const bracket = text.indexOf("[")
  const start = [brace, bracket].filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (start != null) {
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"))
    if (end > start) candidates.push(text.slice(start, end + 1))
  }
  let error = "没有找到 JSON"
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, error }
}

/** true/false when checked; null when the expectation is empty or an invalid regex. */
export function matchExpect(text: string, expect: string): boolean | null {
  const e = expect.trim()
  if (!e) return null
  const re = e.match(/^\/(.+)\/([dgimsuy]*)$/)
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(text)
    } catch {
      return null
    }
  }
  return text.toLowerCase().includes(e.toLowerCase())
}

export type CheckStatus = "pass" | "fail" | "unknown"
export interface ProbeCheck {
  label: string
  status: CheckStatus
  detail?: string
}

export function evaluateSample(view: ProbeView, sample: GatewayProbeSample, expect: string, jsonKeys: string): ProbeCheck[] {
  if (!sample.ok) return [{ label: "请求", status: "fail", detail: sample.error || `HTTP ${sample.status_code || "—"}` }]
  const checks: ProbeCheck[] = []
  if (view === "image" || (sample.images?.length ?? 0) > 0) {
    const n = sample.images?.length ?? 0
    checks.push(n > 0 ? { label: "图片", status: "pass", detail: n > 1 ? `${n} 张` : undefined } : { label: "图片", status: "fail", detail: "上游未返回图片" })
    return checks
  }
  if (view === "svg") {
    const svg = extractSvg(sample.text)
    checks.push(svg ? { label: "SVG", status: "pass" } : { label: "SVG", status: "fail", detail: sample.text_truncated ? "输出被截断" : "没有完整的 <svg>…</svg>" })
  } else if (view === "html") {
    checks.push(extractHtml(sample.text) ? { label: "HTML", status: "pass" } : { label: "HTML", status: "fail", detail: "没有识别到 HTML" })
  } else if (view === "json") {
    const parsed = extractJson(sample.text)
    if (!parsed.ok) checks.push({ label: "JSON 解析", status: "fail", detail: parsed.error })
    else {
      checks.push({ label: "JSON 解析", status: "pass" })
      const keys = jsonKeys.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean)
      if (keys.length) {
        const obj = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {}
        const missing = keys.filter((k) => !(k in obj))
        checks.push(missing.length ? { label: "必需字段", status: "fail", detail: `缺少 ${missing.join(", ")}` } : { label: "必需字段", status: "pass" })
      }
    }
  }
  const m = matchExpect(sample.text, expect)
  if (m != null) checks.push({ label: "答案校验", status: m ? "pass" : "fail", detail: m ? undefined : `未匹配 ${expect}` })
  else if (expect.trim()) checks.push({ label: "答案校验", status: "unknown", detail: "正则无效" })
  if (sample.finish_reason && /length|max_tokens|max_output_tokens/.test(sample.finish_reason)) {
    checks.push({ label: "输出完整", status: "fail", detail: "达到 max tokens 被截断" })
  }
  return checks
}

/* ---------------- aggregate statistics ---------------- */

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function speedStats(samples: GatewayProbeSample[]) {
  const ok = samples.filter((s) => s.ok)
  const tps = ok.flatMap((s) => (s.output_tps != null ? [s.output_tps] : []))
  return {
    ok: ok.length,
    total: samples.length,
    firstTokenMS: median(ok.flatMap((s) => (s.first_token_ms != null ? [s.first_token_ms] : []))),
    firstTextMS: median(ok.flatMap((s) => (s.first_text_ms != null ? [s.first_text_ms] : []))),
    durationMS: median(ok.map((s) => s.duration_ms)),
    tps: tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : null,
    tpsMin: tps.length ? Math.min(...tps) : null,
    tpsMax: tps.length ? Math.max(...tps) : null,
    outputTokens: median(ok.flatMap((s) => (s.output_tokens != null ? [s.output_tokens] : []))),
  }
}

export function cacheTestStats(samples: GatewayProbeSample[]) {
  const reported = samples.filter((s) => s.ok && s.cached_tokens != null && s.input_tokens != null && s.input_tokens > 0 && s.cached_tokens <= s.input_tokens)
  const input = reported.reduce((sum, s) => sum + s.input_tokens!, 0)
  const cached = reported.reduce((sum, s) => sum + s.cached_tokens!, 0)
  return {
    total: samples.length,
    reported: reported.length,
    hitRequests: reported.filter((s) => s.cached_tokens! > 0).length,
    // A missing field is unknown. Never silently turn it into a miss or report
    // a rate calculated over only the positive samples as the overall rate.
    tokenHitRate: reported.length === samples.length && input > 0 ? cached / input : null,
  }
}

/** Cache rounds are labelled "首次", "重复 #n", "改尾 #n". */
export function cacheGroup(label: string): "cold" | "repeat" | "changed" | "other" {
  if (label.startsWith("首次")) return "cold"
  if (label.startsWith("重复")) return "repeat"
  if (label.startsWith("改尾")) return "changed"
  return "other"
}

export type RunVerdict = "pass" | "partial" | "fail" | "unknown" | "pending"

export function runVerdict(view: ProbeView, samples: GatewayProbeSample[], expect: string, jsonKeys: string): RunVerdict {
  if (!samples.length) return "pending"
  const per = samples.map((s) => {
    const checks = evaluateSample(view, s, expect, jsonKeys)
    return checks.every((c) => c.status !== "fail")
  })
  const passed = per.filter(Boolean).length
  if (passed === 0) return "fail"
  if (view === "cache") {
    // "Requests succeeded" is not "cache works": judge the warm rounds.
    const warm = samples.filter((s) => s.ok && cacheGroup(s.label) === "repeat")
    if (!warm.length) return passed === per.length ? "unknown" : "partial"
    if (warm.some((s) => s.cached_tokens == null)) return "unknown"
    const hits = warm.filter((s) => s.cached_tokens! > 0).length
    return hits === warm.length && passed === per.length ? "pass" : hits ? "partial" : "fail"
  }
  return passed === per.length ? "pass" : "partial"
}
