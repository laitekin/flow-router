import type { CacheTestRun } from "./use-model-tests"
import { cacheTestStats } from "./cache-test-stats"

const percent = (rate: number | null) => rate == null ? "未报告" : `${(rate * 100).toFixed(2)}%`
const ms = (value: number | null) => value == null ? "—" : `${(value / 1000).toFixed(2)}s`
const names = { cold: "首次", repeat: "重复输入", changed_tail: "修改末尾" }

export function CacheTestResults({ run }: { run: CacheTestRun }) {
  return (
    <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-2.5 text-xs" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">缓存测试 · {run.samples.length}/{run.total}</span>
        <span className="text-muted-foreground">
          {run.state === "queued" ? "排队中" : run.state === "waiting" ? `等待缓存构建 · 第 ${run.round} 轮` : run.state === "running" ? `测试中 · 第 ${run.round || 1} 轮` : run.state === "cancelled" ? "已中止" : run.state === "error" ? "测试失败" : "已完成"}
        </span>
      </div>
      {run.upstreamModel ? <div className="break-all text-muted-foreground">上游 {run.upstreamModel} · {run.upstreamPath || "正在准备"}</div> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {(["repeat", "changed_tail"] as const).map((kind) => {
          const stats = cacheTestStats(run.samples.filter((s) => s.case === kind))
          return <div key={kind} className="rounded border p-2">
            <div>{names[kind]} · token 命中 {stats.tokenHitRate == null ? "未完整报告" : percent(stats.tokenHitRate)}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">确认命中 {stats.hitRequests}/{stats.total} 次 · 字段完整 {stats.reported}/{stats.total}</div>
          </div>
        })}
      </div>
      {run.samples.length ? <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] text-right tabular-nums">
          <thead><tr className="text-muted-foreground"><th className="py-1 text-left font-normal">轮次</th><th className="font-normal">输入</th><th className="font-normal">缓存</th><th className="font-normal">命中率</th><th className="font-normal">首字</th></tr></thead>
          <tbody>{run.samples.map((s) => <tr key={s.round} className="border-t border-border/50">
            <td className="py-1.5 text-left">{s.round} · {names[s.case]}</td>
            <td>{s.input_tokens ?? "—"}</td><td>{s.cached_tokens ?? "未报告"}</td><td>{percent(s.token_hit_rate)}</td><td>{s.ok ? ms(s.first_text_ms) : `失败 ${s.status_code || ""}`}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}
      {run.error || run.samples.some((s) => s.error) ? <p className="break-words text-destructive">{run.error || run.samples.find((s) => s.error)?.error}</p> : null}
    </div>
  )
}
