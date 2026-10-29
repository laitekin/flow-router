import { formatDurationMS, formatTokens, money } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GatewayUsageStat } from "@/lib/api-types"

/** 列表里展示 24h 用量的统一口径与配色，网关组 / 密钥 / 路由 / 直连渠道共用 */

export const SUMMARY_WINDOW_LABEL = "24h"

export function successRatio(s?: GatewayUsageStat | null): number | null {
  if (!s || s.requests <= 0) return null
  return s.success / s.requests
}

export function successRateClass(ratio: number | null) {
  if (ratio == null) return "text-muted-foreground"
  if (ratio >= 0.98) return "text-emerald-600 dark:text-emerald-400"
  if (ratio >= 0.9) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

export function successBarClass(ratio: number | null) {
  if (ratio == null) return "bg-muted-foreground/30"
  if (ratio >= 0.98) return "bg-emerald-500"
  if (ratio >= 0.9) return "bg-amber-500"
  return "bg-red-500"
}

export function formatRate(ratio: number | null) {
  if (ratio == null) return "—"
  const pct = ratio * 100
  return `${pct >= 99.95 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`
}

export function compactCount(n: number) {
  return formatTokens(n)
}

/** 一行紧凑统计：128 次 · 97.6% · $0.37；无数据时显示「24h 无请求」 */
export function StatLine({
  stat,
  unit = "次",
  className,
  showCost = true,
}: {
  stat?: GatewayUsageStat | null
  unit?: string
  className?: string
  showCost?: boolean
}) {
  const ratio = successRatio(stat)
  if (!stat || stat.requests <= 0) {
    return (
      <span className={cn("text-[11px] text-muted-foreground/70", className)}>
        {SUMMARY_WINDOW_LABEL} 无请求
      </span>
    )
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground", className)}>
      <span>
        <span className="font-medium text-foreground">{compactCount(stat.requests)}</span> {unit}
      </span>
      <span className="text-border">·</span>
      <span className={cn("font-medium", successRateClass(ratio))}>{formatRate(ratio)}</span>
      {showCost ? (
        <>
          <span className="text-border">·</span>
          <span>{money(stat.cost)}</span>
        </>
      ) : null}
    </span>
  )
}

/** 成功率细条，宽度 = 成功率 */
export function SuccessBar({ stat, className }: { stat?: GatewayUsageStat | null; className?: string }) {
  const ratio = successRatio(stat)
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-muted", className)} title={`成功率 ${formatRate(ratio)}`}>
      <div
        className={cn("h-full rounded-full transition-all", successBarClass(ratio))}
        style={{ width: ratio == null ? "0%" : `${Math.max(2, ratio * 100)}%` }}
      />
    </div>
  )
}

/** 大号指标块，用于网关组详情顶部 */
export function StatTiles({ stat }: { stat?: GatewayUsageStat | null }) {
  const ratio = successRatio(stat)
  const tiles = [
    { label: `${SUMMARY_WINDOW_LABEL} 请求`, value: stat ? compactCount(stat.requests) : "0" },
    {
      label: "成功率",
      value: formatRate(ratio),
      valueClass: successRateClass(ratio),
      hint: stat && stat.requests > 0 ? `失败 ${stat.requests - stat.success}` : undefined,
    },
    { label: "费用", value: money(stat?.cost ?? 0) },
    { label: "Tokens", value: formatTokens(stat?.tokens ?? 0) },
    { label: "平均首字", value: stat?.avg_first_token_ms != null ? formatDurationMS(stat.avg_first_token_ms) : "—" },
    { label: "平均耗时", value: stat && stat.requests > 0 ? formatDurationMS(stat.avg_duration_ms) : "—" },
  ]
  return (
    <div className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-lg border bg-card sm:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="min-w-0 px-3 py-2">
          <div className="truncate text-[11px] text-muted-foreground">{t.label}</div>
          <div className={cn("truncate text-base font-semibold tabular-nums", t.valueClass)}>{t.value}</div>
          {t.hint ? <div className="truncate text-[10px] text-muted-foreground">{t.hint}</div> : null}
        </div>
      ))}
    </div>
  )
}
