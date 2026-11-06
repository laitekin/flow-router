import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  CheckCircle2,
  ChevronDown,
  Download,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Square,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { GatewayModelListItem, GatewayModelTestResult, GatewayRoute } from "@/lib/api-types"
import { findSourceTest, modelSourceTests, resolveModelSources, type ModelSourceLabel } from "./gateway-utils"
import {
  PROBE_LIMITS,
  REASONING_LABELS,
  VIEW_LABELS,
  buildProbePlan,
  normalizeTemplate,
  type ProbeTemplate,
  type ProbeView,
} from "./probe-presets"
import {
  allTemplates,
  exportTemplates,
  importTemplates,
  loadLastTemplateID,
  loadUserTemplates,
  saveLastTemplateID,
  saveUserTemplates,
  upsertUserTemplate,
} from "./probe-template-store"
import { ProbeResultView, ProbeVerdictBadge } from "./probe-result-view"
import { MAX_CONCURRENCY, type ModelTests } from "./use-model-tests"

const AVAILABILITY = "availability"
const selectCls = "h-8 w-full rounded-md border bg-background px-2 text-xs"

function NumberField({ id, label, value, onChange, range, step, hint }: {
  id: string
  label: string
  value: number
  onChange: (v: number) => void
  range: readonly [number, number]
  step?: number
  hint?: string
}) {
  // Keep a local string so users can clear and retype; clamp on blur.
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        className="h-8 text-xs"
        min={range[0]}
        max={range[1]}
        step={step}
        value={text}
        title={hint ?? `${range[0]}–${range[1]}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Math.min(range[1], Math.max(range[0], Math.round(Number(text))))
          if (Number.isFinite(n)) onChange(n)
          setText(String(Number.isFinite(n) ? n : value))
        }}
      />
    </div>
  )
}

function TemplateEditor({ draft, onChange }: { draft: ProbeTemplate; onChange: (patch: Partial<ProbeTemplate>) => void }) {
  const isPrompt = draft.kind === "prompt"
  const [tempText, setTempText] = useState(draft.temperature == null ? "" : String(draft.temperature))
  useEffect(() => setTempText(draft.temperature == null ? "" : String(draft.temperature)), [draft.temperature])
  return (
    <div className="space-y-3">
      {draft.kind === "cache" ? (
        <div className="grid grid-cols-3 gap-2">
          <NumberField id="pt-prefix" label="前缀 token" value={draft.prefixTokens} range={PROBE_LIMITS.prefixTokens} step={1000} onChange={(v) => onChange({ prefixTokens: v })} />
          <NumberField id="pt-rep" label="重复轮数" value={draft.repeatRounds} range={PROBE_LIMITS.repeatRounds} onChange={(v) => onChange({ repeatRounds: v })} />
          <NumberField id="pt-chg" label="改尾轮数" value={draft.changedRounds} range={PROBE_LIMITS.changedRounds} onChange={(v) => onChange({ changedRounds: v })} />
        </div>
      ) : null}
      {draft.kind === "needle" ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="pt-hay" label="文本长度 token" value={draft.haystackTokens} range={PROBE_LIMITS.haystackTokens} step={1000} onChange={(v) => onChange({ haystackTokens: v })} />
          <NumberField id="pt-depth" label="藏针深度 %" value={draft.needleDepth} range={PROBE_LIMITS.needleDepth} step={10} onChange={(v) => onChange({ needleDepth: v })} />
        </div>
      ) : null}

      {draft.kind !== "cache" ? (
        <div className="space-y-1">
          <Label htmlFor="pt-prompt" className="text-[11px] text-muted-foreground">{draft.kind === "needle" ? "提问（附在长文本之后）" : "用户提示词"}</Label>
          <Textarea id="pt-prompt" className="min-h-20 text-xs" value={draft.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="pt-system" className="text-[11px] text-muted-foreground">系统提示词（可选）</Label>
        <Textarea id="pt-system" className="min-h-12 text-xs" value={draft.system} placeholder="留空则不发送" onChange={(e) => onChange({ system: e.target.value })} />
      </div>

      {isPrompt ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="pt-view" className="text-[11px] text-muted-foreground">呈现方式</Label>
            <select id="pt-view" className={selectCls} value={draft.view} onChange={(e) => onChange({ view: e.target.value as ProbeView })}>
              {(["text", "svg", "html", "json", "speed", "image"] as const).map((v) => <option key={v} value={v}>{VIEW_LABELS[v]}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pt-expect" className="text-[11px] text-muted-foreground">答案校验（包含 或 /正则/）</Label>
            <Input id="pt-expect" className="h-8 text-xs" value={draft.expect} placeholder="可选" onChange={(e) => onChange({ expect: e.target.value })} />
          </div>
          {draft.view === "json" ? (
            <div className="col-span-2 space-y-1">
              <Label htmlFor="pt-keys" className="text-[11px] text-muted-foreground">JSON 必需字段（逗号分隔）</Label>
              <Input id="pt-keys" className="h-8 text-xs" value={draft.jsonKeys} onChange={(e) => onChange({ jsonKeys: e.target.value })} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="pt-proto" className="text-[11px] text-muted-foreground">协议</Label>
          <select id="pt-proto" className={selectCls} value={draft.protocol} onChange={(e) => onChange({ protocol: e.target.value as ProbeTemplate["protocol"] })}>
            <option value="auto">跟随渠道</option>
            <option value="chat">Chat Completions</option>
            <option value="responses">Responses</option>
            <option value="image">生图 Images</option>
          </select>
        </div>
        {draft.protocol === "image" || draft.view === "image" ? (
          <div className="space-y-1">
            <Label htmlFor="pt-size" className="text-[11px] text-muted-foreground">图片尺寸</Label>
            <select id="pt-size" className={selectCls} value={draft.imageSize ?? ""} onChange={(e) => onChange({ imageSize: e.target.value || undefined })}>
              <option value="">1024x1024（默认）</option>
              <option value="auto">auto</option>
              <option value="1024x1536">1024x1536 竖版</option>
              <option value="1536x1024">1536x1024 横版</option>
              <option value="1792x1024">1792x1024（dall-e-3）</option>
              <option value="512x512">512x512</option>
              <option value="256x256">256x256（dall-e-2）</option>
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="pt-reason" className="text-[11px] text-muted-foreground">推理强度</Label>
          <select id="pt-reason" className={selectCls} value={draft.reasoning} onChange={(e) => onChange({ reasoning: e.target.value as ProbeTemplate["reasoning"] })}>
            {(Object.keys(REASONING_LABELS) as ProbeTemplate["reasoning"][]).map((r) => <option key={r} value={r}>{REASONING_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-temp" className="text-[11px] text-muted-foreground">温度</Label>
          <Input
            id="pt-temp"
            className="h-8 text-xs"
            inputMode="decimal"
            placeholder="默认"
            value={tempText}
            onChange={(e) => setTempText(e.target.value)}
            onBlur={() => {
              const t = tempText.trim()
              const n = Number(t)
              onChange({ temperature: t === "" || !Number.isFinite(n) ? null : Math.min(2, Math.max(0, n)) })
            }}
          />
        </div>
        <NumberField id="pt-max" label="Max tokens" value={draft.maxTokens} range={PROBE_LIMITS.maxTokens} onChange={(v) => onChange({ maxTokens: v })} />
        <NumberField id="pt-timeout" label="单轮超时（秒）" value={draft.timeoutSec} range={PROBE_LIMITS.timeoutSec} onChange={(v) => onChange({ timeoutSec: v })} />
        <NumberField id="pt-interval" label="轮间隔（秒）" value={draft.intervalSec} range={PROBE_LIMITS.intervalSec} onChange={(v) => onChange({ intervalSec: v })} />
        {draft.kind !== "cache" ? (
          <NumberField id="pt-repeat" label="样本次数" value={draft.repeat} range={PROBE_LIMITS.repeat} onChange={(v) => onChange({ repeat: v })} />
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <Switch checked={draft.continueOnError} onCheckedChange={(v) => onChange({ continueOnError: v })} />
        某轮失败后继续后续轮次
      </label>
    </div>
  )
}

function AvailabilityLine({ tr }: { tr?: GatewayModelTestResult }) {
  if (!tr) return <span className="text-[11px] text-muted-foreground">可用性未测试</span>
  return tr.ok ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="size-3" /> 可用 · 首字 {tr.latency_ms}ms
    </span>
  ) : (
    <span className="inline-flex min-w-0 items-start gap-1 break-all text-[11px] text-destructive" title={tr.error}>
      <XCircle className="mt-0.5 size-3 shrink-0" /> 失败{tr.status_code ? ` · ${tr.status_code}` : ""}{tr.error ? ` · ${tr.error.slice(0, 160)}` : ""}
    </span>
  )
}

export function ModelTestDialog({
  open,
  onOpenChange,
  modelTestTarget,
  routeDrafts,
  channelNameByID,
  providerNameByID,
  tests,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  modelTestTarget: GatewayModelListItem | null
  routeDrafts: Partial<GatewayRoute>[]
  channelNameByID: Map<number, string>
  providerNameByID?: Map<number, string>
  tests: ModelTests
}) {
  const [userTemplates, setUserTemplates] = useState<ProbeTemplate[]>(() => loadUserTemplates())
  const templates = useMemo(() => allTemplates(userTemplates), [userTemplates])
  const [selectedID, setSelectedID] = useState(() => {
    const last = loadLastTemplateID()
    return last === AVAILABILITY || allTemplates(loadUserTemplates()).some((t) => t.id === last) ? last : AVAILABILITY
  })
  /** unsaved parameter edits per template, kept while the page lives */
  const [drafts, setDrafts] = useState<Record<string, ProbeTemplate>>({})
  const [saveName, setSaveName] = useState<string | null>(null)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)
  // Parameters start collapsed on phones so results are reachable without scrolling past the form.
  const [showParams, setShowParams] = useState(() => {
    try {
      return window.matchMedia("(min-width: 1024px)").matches
    } catch {
      return true
    }
  })

  useEffect(() => saveLastTemplateID(selectedID), [selectedID])
  useEffect(() => setUnchecked(new Set()), [modelTestTarget?.id])

  const base = templates.find((t) => t.id === selectedID)
  const draft = base ? drafts[base.id] ?? base : undefined
  const dirty = !!base && !!drafts[base.id] && JSON.stringify(drafts[base.id]) !== JSON.stringify(base)
  const isAvailability = selectedID === AVAILABILITY

  const model = modelTestTarget?.id ?? ""
  const sources = useMemo(
    () => (modelTestTarget ? resolveModelSources(modelTestTarget, routeDrafts, channelNameByID, providerNameByID) : []),
    [modelTestTarget, routeDrafts, channelNameByID, providerNameByID],
  )
  const availResults = useMemo(() => modelSourceTests(sources, tests.results[model] ?? []), [sources, tests.results, model])
  const runnable = sources.filter((s): s is ModelSourceLabel & { route_id: number } => s.route_id != null)
  const checked = runnable.filter((s) => !unchecked.has(s.key))
  const estimate = useMemo(() => (draft ? buildProbePlan(draft, "estimate").estimatedInputTokens : 0), [draft])
  const anyBusy = modelTestTarget ? tests.isTesting(model) : false

  const patchDraft = (patch: Partial<ProbeTemplate>) => {
    if (!draft) return
    setDrafts((prev) => ({ ...prev, [draft.id]: { ...draft, ...patch } }))
  }
  const resetDraft = () => {
    if (!base) return
    setDrafts((prev) => { const next = { ...prev }; delete next[base.id]; return next })
  }
  const persist = (list: ProbeTemplate[]) => { setUserTemplates(list); saveUserTemplates(list) }

  function saveTemplate(name?: string) {
    if (!draft) return
    const { list, saved } = upsertUserTemplate(userTemplates, draft, name)
    persist(list)
    setDrafts((prev) => { const next = { ...prev }; delete next[draft.id]; return next })
    setSelectedID(saved.id)
    setSaveName(null)
    toast.success(name != null ? `已保存模板「${saved.name}」` : "模板已更新")
  }
  function deleteTemplate() {
    if (!base || base.builtin) return
    persist(userTemplates.filter((t) => t.id !== base.id))
    setSelectedID(AVAILABILITY)
    toast.success(`已删除模板「${base.name}」`)
  }
  function downloadJSON(name: string, data: string) {
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }))
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function onImport(file?: File) {
    if (!file) return
    try {
      const { list, added } = importTemplates(userTemplates, await file.text())
      persist(list)
      setSelectedID(list[list.length - 1].id)
      toast.success(`已导入 ${added} 个模板`)
    } catch (e) {
      toast.error(`导入失败：${e instanceof Error ? e.message : "格式错误"}`)
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }
  function exportResults() {
    if (!draft) return
    const rows = runnable.flatMap((s) => {
      const run = tests.probeRun(model, s.route_id, draft.id)
      return run ? [{ source: s.label, route_id: s.route_id, ...run }] : []
    })
    if (!rows.length) return toast.info("当前测试还没有结果")
    downloadJSON(`probe-${model.replace(/[^\w.-]+/g, "_")}-${draft.name}.json`, JSON.stringify({ model, test: draft.name, exported_at: new Date().toISOString(), results: rows }, null, 2))
  }

  function runOn(routeIDs: number[]) {
    if (!modelTestTarget || !routeIDs.length) return
    if (isAvailability) tests.run(model, routeIDs)
    else if (draft) tests.runProbe(model, routeIDs, normalizeTemplate({ ...draft }))
  }
  const testID = isAvailability ? "" : draft?.id ?? ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1rem)] max-w-6xl min-w-0 flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl sm:p-6">
        <DialogHeader className="min-w-0 shrink-0 space-y-1">
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 shrink-0" />
            模型测试台
          </DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {modelTestTarget ? (
              <>
                <code className="inline-block max-w-full break-all rounded bg-muted px-1 text-xs">{model}</code>
                {" "}· 选择测试类型、调整参数，在多个渠道上并发运行并对比。关闭弹窗后测试继续；刷新或离开网关页会停止。
              </>
            ) : "选择模型后测试"}
          </DialogDescription>
        </DialogHeader>

        {modelTestTarget ? (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:overflow-hidden">
            {/* ---------- left: test type + parameters ---------- */}
            <section className="min-w-0 space-y-3 lg:overflow-y-auto lg:pr-1" aria-label="测试设置">
              <div className="space-y-1.5">
                <div className="text-xs font-medium">测试类型</div>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="测试类型">
                  {[{ id: AVAILABILITY, name: "可用性", builtin: true }, ...templates].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={selectedID === t.id}
                      onClick={() => { setSelectedID(t.id); setSaveName(null) }}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedID === t.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                        !t.builtin && selectedID !== t.id && "border-dashed",
                      )}
                    >
                      {t.name}
                      {drafts[t.id] && JSON.stringify(drafts[t.id]) !== JSON.stringify(t) ? " •" : ""}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => fileRef.current?.click()}>
                    <Upload className="size-3" /> 导入模板
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={!userTemplates.length} onClick={() => downloadJSON("flow-router-probe-templates.json", exportTemplates(userTemplates))}>
                    <Download className="size-3" /> 导出我的模板
                  </Button>
                  <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onImport(e.target.files?.[0])} />
                </div>
              </div>

              {isAvailability ? (
                <p className="rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                  向每个渠道发送最小请求，验证模型能否调通并返回首字耗时。几乎不消耗额度，适合先跑一遍再做深入测试。
                </p>
              ) : draft ? (
                <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">{draft.description || "个人模板"}</p>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-xs font-medium"
                    aria-expanded={showParams}
                    onClick={() => setShowParams((v) => !v)}
                  >
                    参数设置{dirty ? "（已修改）" : ""}
                    <ChevronDown className={cn("size-3.5 transition-transform", showParams && "rotate-180")} />
                  </button>
                  {showParams ? <TemplateEditor key={draft.id} draft={draft} onChange={patchDraft} /> : null}
                  <div className="text-[11px] text-muted-foreground">
                    每个渠道约 {estimate.toLocaleString()} 输入 token · 最多 {draft.maxTokens.toLocaleString()} × {buildProbePlan(draft, "x").rounds.length} 输出 token，会消耗上游额度。
                  </div>
                  {saveName != null ? (
                    <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (saveName.trim()) saveTemplate(saveName.trim()) }}>
                      <Input autoFocus className="h-8 text-xs" placeholder="模板名称" maxLength={40} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                      <Button size="sm" type="submit" disabled={!saveName.trim()}>保存</Button>
                      <Button size="sm" type="button" variant="ghost" onClick={() => setSaveName(null)}>取消</Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {!draft.builtin ? (
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={!dirty} onClick={() => saveTemplate()}>
                          <Save className="size-3" /> 保存修改
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setSaveName(draft.builtin ? `${draft.name}（我的）` : `${draft.name} 副本`)}>
                        <Save className="size-3" /> 另存为模板
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-[11px]" disabled={!dirty} onClick={resetDraft}>
                        <RotateCcw className="size-3" /> 还原
                      </Button>
                      {!draft.builtin ? (
                        <Button size="sm" variant="ghost" className="h-7 text-[11px] text-destructive" onClick={deleteTemplate}>
                          <Trash2 className="size-3" /> 删除
                        </Button>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </section>

            {/* ---------- right: sources and results ---------- */}
            <section className="flex min-h-0 min-w-0 flex-col gap-2 lg:overflow-hidden" aria-label="渠道与结果">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={runnable.length > 0 && checked.length === runnable.length ? true : checked.length ? "indeterminate" : false}
                    onCheckedChange={(v) => setUnchecked(v === true ? new Set() : new Set(runnable.map((s) => s.key)))}
                    aria-label="全选渠道"
                  />
                  已选 {checked.length}/{runnable.length} 个渠道
                </label>
                {availResults.length ? (
                  <Badge variant="outline" className="text-[11px] font-normal">
                    可用 {availResults.filter((t) => t.ok).length}/{availResults.length}
                  </Badge>
                ) : null}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="同时运行的测试数（所有模型共享），其余排队">
                    并发
                    <select className="h-7 rounded border bg-background px-1 text-xs" value={tests.concurrency} onChange={(e) => tests.setConcurrency(Number(e.target.value))}>
                      {Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  {!isAvailability ? (
                    <Button size="sm" variant="ghost" className="h-8" onClick={exportResults}>
                      <Download className="size-3.5" /> 导出结果
                    </Button>
                  ) : null}
                  {anyBusy ? (
                    <Button size="sm" variant="outline" className="h-8" onClick={() => tests.cancelModel(model)}>
                      <Square className="size-3.5" /> 全部中止
                    </Button>
                  ) : null}
                  <Button size="sm" className="h-8" disabled={!checked.length || (!isAvailability && !draft)} onClick={() => runOn(checked.map((s) => s.route_id))}>
                    <Play className="size-3.5" /> 运行{isAvailability ? "可用性" : `「${draft?.name ?? ""}」`}
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 lg:overflow-y-auto">
                {sources.length === 0 ? (
                  <div className="rounded-md border px-4 py-10 text-center text-sm text-muted-foreground">
                    暂无可用绑定。请在「渠道路由」中检查已绑定线路是否存在并启用。
                  </div>
                ) : (
                  <ul className={cn("grid gap-2", sources.length > 1 && "xl:grid-cols-2")}>
                    {sources.map((s) => {
                      const rid = s.route_id
                      const busy = rid != null && tests.isTesting(model, rid, testID)
                      const run = rid != null && !isAvailability && draft ? tests.probeRun(model, rid, draft.id) : undefined
                      return (
                        <li key={s.key} className="min-w-0 rounded-lg border bg-card p-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <Checkbox
                              className="mt-0.5"
                              disabled={rid == null}
                              checked={rid != null && !unchecked.has(s.key)}
                              onCheckedChange={(v) => setUnchecked((prev) => { const next = new Set(prev); if (v === true) next.delete(s.key); else next.add(s.key); return next })}
                              aria-label={`选择 ${s.label}`}
                            />
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="break-all text-xs font-medium">{s.label}</div>
                              <AvailabilityLine tr={findSourceTest(s, availResults)} />
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {run ? <ProbeVerdictBadge run={run} /> : null}
                              {busy ? (
                                <Button size="icon" variant="ghost" className="size-7" aria-label="中止" title="中止" onClick={() => rid != null && tests.cancel(model, rid, testID)}>
                                  <Square className="size-3.5" />
                                </Button>
                              ) : (
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="size-7"
                                  disabled={rid == null || (!isAvailability && !draft)}
                                  aria-label="运行此渠道"
                                  title={rid == null ? "缺少路由 ID，请重新同步模型" : "只运行此渠道"}
                                  onClick={() => rid != null && runOn([rid])}
                                >
                                  {isAvailability && rid != null && tests.isTesting(model, rid, "") ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                                </Button>
                              )}
                              {run && !busy ? (
                                <Button size="icon" variant="ghost" className="size-7" aria-label="清除结果" title="清除结果" onClick={() => rid != null && draft && tests.clearProbe(model, rid, draft.id)}>
                                  <Trash2 className="size-3.5" />
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          {run ? (
                            <div className="mt-2 border-t pt-2">
                              <ProbeResultView run={run} compact={sources.length > 1} />
                            </div>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

