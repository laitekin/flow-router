import { CheckCircle2, CircleHelp, Copy, Loader2, XCircle } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { GatewayProbeSample } from "@/lib/api-types"
import type { ProbeRun } from "./use-model-tests"
import {
  cacheGroup,
  cacheTestStats,
  evaluateSample,
  extractHtml,
  extractJson,
  extractSvg,
  runVerdict,
  speedStats,
  type ProbeCheck,
} from "./probe-presets"

const pct = (rate: number | null) => (rate == null ? "未报告" : `${(rate * 100).toFixed(1)}%`)
const sec = (ms: number | null | undefined) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`)
const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString())

export function probeStateText(run: ProbeRun) {
  switch (run.state) {
    case "queued": return "排队中"
    case "waiting": return `等待间隔 · 下一轮 ${run.round}/${run.total}`
    case "running": return `运行中 · ${Math.max(run.samples.length + 1, run.round || 1)}/${run.total}`
    case "cancelled": return "已中止"
    case "error": return "测试失败"
    default: return "已完成"
  }
}

export function ProbeVerdictBadge({ run }: { run: ProbeRun }) {
  const busy = run.state === "queued" || run.state === "running" || run.state === "waiting"
  const v = runVerdict(run.template.view, run.samples, run.expect, run.template.jsonKeys)
  const cls = busy || v === "unknown"
    ? "border-border text-muted-foreground"
    : v === "pass"
      ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
      : v === "partial"
        ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
        : "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", cls)}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
      {busy ? probeStateText(run) : run.state === "cancelled" ? "已中止" : v === "pass" ? "通过" : v === "partial" ? "部分通过" : v === "unknown" ? "缓存未报告" : run.samples.length ? "未通过" : "失败"}
    </span>
  )
}

function Checks({ checks }: { checks: ProbeCheck[] }) {
  if (!checks.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {checks.map((c, i) => (
        <span
          key={i}
          title={c.detail}
          className={cn(
            "inline-flex max-w-full items-center gap-1 break-all rounded px-1.5 py-0.5 text-[11px]",
            c.status === "pass" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : c.status === "fail" ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-muted text-muted-foreground",
          )}
        >
          {c.status === "pass" ? <CheckCircle2 className="size-3 shrink-0" /> : c.status === "fail" ? <XCircle className="size-3 shrink-0" /> : <CircleHelp className="size-3 shrink-0" />}
          {c.label}
          {c.detail && c.status !== "pass" ? ` · ${c.detail}` : ""}
        </span>
      ))}
    </div>
  )
}

function Metrics({ s }: { s: GatewayProbeSample }) {
  const parts = [
    `首字 ${sec(s.first_text_ms)}`,
    s.first_token_ms != null && s.first_token_ms !== s.first_text_ms ? `首 token ${sec(s.first_token_ms)}` : null,
    `耗时 ${sec(s.duration_ms)}`,
    s.output_tokens != null ? `输出 ${num(s.output_tokens)} tok` : null,
    s.reasoning_tokens ? `推理 ${num(s.reasoning_tokens)} tok` : s.reasoning_chars ? `推理 ${num(s.reasoning_chars)} 字` : null,
    s.output_tps != null ? `${s.output_tps} tok/s` : null,
    s.input_tokens != null ? `输入 ${num(s.input_tokens)}` : null,
    s.finish_reason ? `结束 ${s.finish_reason}` : null,
  ].filter(Boolean)
  return <div className="text-[11px] tabular-nums text-muted-foreground">{parts.join(" · ")}</div>
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success("已复制"), () => toast.error("复制失败"))
}

function Source({ text, truncated }: { text: string; truncated?: boolean }) {
  return (
    <details className="group text-[11px]">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        查看原始输出（{text.length.toLocaleString()} 字{truncated ? "，已截断" : ""}）
      </summary>
      <div className="relative mt-1">
        <button type="button" className="absolute right-1 top-1 rounded bg-background/80 p-1 text-muted-foreground hover:text-foreground" onClick={() => copy(text)} aria-label="复制原始输出">
          <Copy className="size-3" />
        </button>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 pr-7 font-mono [overflow-wrap:anywhere]">{text}</pre>
      </div>
    </details>
  )
}

function SampleBody({ run, s }: { run: ProbeRun; s: GatewayProbeSample }) {
  const view = run.template.view
  if (!s.ok && !s.text) return null
  if (view === "svg") {
    const svg = extractSvg(s.text)
    return (
      <div className="space-y-1">
        {svg ? (
          <a href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} target="_blank" rel="noreferrer" title="新标签页打开大图" className="block">
            {/* Rendering through <img> keeps any <script> inside the SVG inert. */}
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`${run.label ?? ""} ${s.label} SVG`} className="aspect-square w-full rounded border bg-white object-contain" />
          </a>
        ) : null}
        <Source text={s.text} truncated={s.text_truncated} />
      </div>
    )
  }
  if (view === "html") {
    const html = extractHtml(s.text)
    return (
      <div className="space-y-1">
        {html ? (
          // Opaque-origin sandbox: scripts run but cannot reach this page, its storage or cookies.
          <iframe title={`${s.label} HTML`} sandbox="allow-scripts" srcDoc={html} className="h-64 w-full rounded border bg-white" />
        ) : null}
        <Source text={s.text} truncated={s.text_truncated} />
      </div>
    )
  }
  if (view === "json") {
    const parsed = extractJson(s.text)
    return parsed.ok ? (
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 font-mono text-[11px]">{JSON.stringify(parsed.value, null, 2)}</pre>
    ) : (
      <Source text={s.text} truncated={s.text_truncated} />
    )
  }
  if (view === "speed" || view === "cache") return s.text ? <Source text={s.text} truncated={s.text_truncated} /> : null
  return <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 text-xs [overflow-wrap:anywhere]">{s.text}</pre>
}

function CacheSummary({ run, compact }: { run: ProbeRun; compact?: boolean }) {
  const groups = [
    { key: "repeat" as const, name: "重复输入" },
    { key: "changed" as const, name: "修改末尾" },
  ].filter((g) => run.template.kind !== "cache" || g.key !== "changed" || run.template.changedRounds > 0)
  return (
    <div className="space-y-2">
      <div className={cn("grid gap-2", !compact && "sm:grid-cols-2")}>
        {groups.map((g) => {
          const st = cacheTestStats(run.samples.filter((s) => cacheGroup(s.label) === g.key))
          return (
            <div key={g.key} className="rounded border p-2 text-xs">
              <div className="font-medium">{g.name} · token 命中 {st.total === 0 ? "—" : st.tokenHitRate == null ? "未完整报告" : pct(st.tokenHitRate)}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">确认命中 {st.hitRequests}/{st.total} 次 · 字段完整 {st.reported}/{st.total}</div>
            </div>
          )
        })}
      </div>
      {run.samples.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 text-left font-normal">轮次</th>
                <th className="font-normal">输入</th>
                <th className="font-normal">缓存</th>
                <th className="font-normal">命中率</th>
                <th className="font-normal">首字</th>
                {compact ? null : <th className="font-normal">耗时</th>}
              </tr>
            </thead>
            <tbody>
              {run.samples.map((s) => (
                <tr key={s.round} className="border-t border-border/50">
                  <td className="py-1.5 text-left">{s.label}</td>
                  <td>{num(s.input_tokens)}</td>
                  <td>{s.cached_tokens ?? "未报告"}</td>
                  <td>{pct(s.token_hit_rate)}</td>
                  <td>{s.ok ? sec(s.first_text_ms) : <span className="text-destructive">失败 {s.status_code || ""}</span>}</td>
                  {compact ? null : <td>{sec(s.duration_ms)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

function SpeedSummary({ run, compact }: { run: ProbeRun; compact?: boolean }) {
  const st = speedStats(run.samples)
  const cells = [
    ["首 token", sec(st.firstTokenMS)],
    ["首字", sec(st.firstTextMS)],
    ["吞吐", st.tps == null ? "—" : `${st.tps.toFixed(1)} tok/s`],
    ["总耗时", sec(st.durationMS)],
  ]
  return (
    <div className="space-y-1">
      <div className={cn("grid grid-cols-2 gap-2", !compact && "sm:grid-cols-4")}>
        {cells.map(([k, v]) => (
          <div key={k} className="rounded border p-2">
            <div className="text-[11px] text-muted-foreground">{k}</div>
            <div className="text-sm font-medium tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">
        中位数 · 成功 {st.ok}/{st.total}
        {st.tpsMin != null && st.tpsMax != null && st.ok > 1 ? ` · 吞吐范围 ${st.tpsMin}–${st.tpsMax} tok/s` : ""}
        {st.outputTokens != null ? ` · 输出约 ${num(st.outputTokens)} tok` : ""}
      </div>
    </div>
  )
}

export function ProbeResultView({ run, compact }: { run: ProbeRun; compact?: boolean }) {
  const view = run.template.view
  const showSamples = view !== "cache"
  return (
    <div className="min-w-0 space-y-2 text-xs" aria-live="polite">
      {run.upstreamModel ? (
        <div className="break-all text-[11px] text-muted-foreground">
          上游 {run.upstreamModel} · {run.upstreamPath || run.protocol || "准备中"}
          {run.finishedAt ? ` · 用时 ${sec(run.finishedAt - run.startedAt)}` : ""}
        </div>
      ) : null}
      {view === "cache" ? <CacheSummary run={run} compact={compact} /> : null}
      {view === "speed" ? <SpeedSummary run={run} compact={compact} /> : null}
      {showSamples ? (
        <div className={cn("grid gap-2", view === "svg" && !compact && run.samples.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
          {run.samples.map((s) => {
            const checks = evaluateSample(view, s, run.expect, run.template.jsonKeys)
            return (
              <div key={s.round} className="min-w-0 space-y-1.5 rounded-md border bg-background/60 p-2">
                {run.total > 1 ? <div className="text-[11px] font-medium">{s.label}</div> : null}
                <SampleBody run={run} s={s} />
                <Checks checks={checks} />
                <Metrics s={s} />
              </div>
            )
          })}
        </div>
      ) : null}
      {run.state === "running" && run.samples.length < run.total ? (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> 正在等待第 {run.samples.length + 1} 轮输出…
        </div>
      ) : null}
      {run.error ? <p className="break-words text-destructive">{run.error}</p> : null}
    </div>
  )
}
