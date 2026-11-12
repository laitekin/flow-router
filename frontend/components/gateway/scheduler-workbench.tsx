import { useMemo } from "react"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Check,
  CircleOff,
  Gauge,
  Pause,
  Route,
  ShieldCheck,
  Timer,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import type {
  GatewayGroup,
  GatewayProviderOption,
  GatewayRoute,
  RateSnapshot,
} from "@/lib/api-types"
import {
  deriveSchedulerSnapshot,
  formatSchedulerPercent,
  formatSchedulerRate,
  type SchedulerRouteRow,
} from "./scheduler-view-utils"
import { TierBadge } from "./tier-badge"
import { tierColor } from "./route-tiers"
import { SOFT } from "@/lib/soft-tone"

type SchedulerWorkbenchProps = {
  group: GatewayGroup | null
  routes: Partial<GatewayRoute>[]
  sourceGroupsByChannel: Record<number, RateSnapshot[]>
  providers: GatewayProviderOption[]
}

/** 分流条颜色（类名写全，Tailwind 才能扫描到） */
const PROGRESS_TINT: Record<string, string> = {
  emerald: "bg-emerald-500/15 [&>[data-slot=progress-indicator]]:bg-emerald-500",
  sky: "bg-sky-500/15 [&>[data-slot=progress-indicator]]:bg-sky-500",
  violet: "bg-violet-500/15 [&>[data-slot=progress-indicator]]:bg-violet-500",
  slate: "bg-slate-500/15 [&>[data-slot=progress-indicator]]:bg-slate-400",
}

function stateMeta(state: SchedulerRouteRow["state"], tier = -1) {
  switch (state) {
    case "primary":
      return { label: "主", className: SOFT.emerald.badge, iconClassName: "", icon: Check }
    case "fallback":
      return {
        label: tier > 0 ? `备${tier}` : "备用",
        className: SOFT[tierColor(tier) ?? "sky"].badge,
        iconClassName: "",
        icon: ArrowRight,
      }
    case "paused":
      return { label: "暂停", className: SOFT.amber.badge, iconClassName: "", icon: Pause }
    case "disabled":
      return { label: "禁用", className: "border-border bg-muted/40 text-muted-foreground", iconClassName: "", icon: CircleOff }
    default:
      return { label: "不可调度", className: SOFT.rose.badge, iconClassName: "", icon: X }
  }
}

function RouteChainItem({ row }: { row: SchedulerRouteRow }) {
  return (
    <div
      className={`relative min-w-0 overflow-hidden rounded-lg border p-3 pl-3.5 ${
        tierColor(row.tier) ? SOFT[tierColor(row.tier)!].surface : "border-border bg-background"
      }`}
    >
      <span
        className={`absolute inset-y-0 left-0 w-[3px] ${tierColor(row.tier) ? SOFT[tierColor(row.tier)!].dot : "bg-border"}`}
        aria-hidden
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{row.sourceLabel}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            路由 #{row.route.id ?? "—"} · {row.protocolLabel}
          </p>
        </div>
        <TierBadge tier={row.tier} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-current/10 pt-2.5 text-[11px]">
        <div>
          <p className="text-muted-foreground">有效倍率</p>
          <p className="mt-0.5 font-mono tabular-nums text-foreground/90">{formatSchedulerRate(row.rate)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">权重</p>
          <p className="mt-0.5 font-mono tabular-nums text-foreground/90">{row.weight}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{row.tierSize > 1 ? "同档分流" : "流量"}</p>
          <p className="mt-0.5 font-mono tabular-nums text-foreground/90">
            {row.tier === 0 || row.tierSize > 1 ? formatSchedulerPercent(row.configuredShare) : "失败才用"}
          </p>
        </div>
      </div>
    </div>
  )
}

export function SchedulerWorkbench({
  group,
  routes,
  sourceGroupsByChannel,
  providers,
}: SchedulerWorkbenchProps) {
  const snapshot = useMemo(
    () => deriveSchedulerSnapshot(group, routes, sourceGroupsByChannel, providers),
    [group, providers, routes, sourceGroupsByChannel],
  )

  const eligibleCount = snapshot.eligible.length
  const tiers = useMemo(() => {
    const out: SchedulerRouteRow[][] = []
    for (const row of snapshot.eligible) {
      const last = out[out.length - 1]
      if (last && last[0].tier === row.tier) last.push(row)
      else out.push([row])
    }
    return out
  }, [snapshot.eligible])
  const policy = [
    group?.retry_enabled === false ? "失败不重试" : `同路由重试 ${group?.retry_count ?? 0} 次`,
    group?.failover_enabled === false
      ? "不顺延"
      : `最多顺延 ${group?.failover_max ?? 0} 次`,
    group?.failover_on_4xx ? "普通 4xx 可顺延" : "普通 4xx 直返",
    group?.balance_failover_enabled === false ? "余额不足不顺延" : "余额不足按策略顺延",
    (group?.balance_cooldown_seconds ?? 300) === 0 ? "余额不足不新增冷却"
      : `余额冷却 ${group?.balance_cooldown_seconds ?? 300}–${group?.balance_cooldown_max_seconds ?? 1800}s`,
    `冷却 ${group?.cooldown_seconds ?? 0}s`,
  ]

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-border shadow-none">
        <CardHeader className="border-b border-border bg-muted/20 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Gauge className="size-4" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">组内调度</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {group ? `${group.name} · 规则执行视图` : "选择一个网关组查看调度"}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="gap-1.5 border-border bg-background text-xs">
              <Activity className="size-3.5 text-emerald-600" />
              规则模式
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4 py-4 sm:px-5">
          <div className="grid gap-2 sm:grid-cols-5">
            {[
              ["Gateway Key", "鉴权 / 配额"],
              ["Gateway Group", "当前分组"],
              ["Hard filters", "启用 / 密钥 / 暂停"],
              ["Rate sort", group?.rate_sort_direction === "desc" ? "高倍率优先" : "低倍率优先"],
              ["Failover", group?.failover_enabled === false ? "关闭" : "顺延备用"],
            ].map(([title, value], index) => (
              <div key={title} className="relative rounded-lg border border-border bg-background px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {title}
                </p>
                <p className="mt-1 text-xs font-medium text-foreground">{value}</p>
                {index < 4 ? (
                  <ArrowRight className="absolute -right-2.5 top-1/2 hidden size-4 -translate-y-1/2 bg-background text-muted-foreground sm:block" />
                ) : null}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {policy.map((item) => (
              <Badge key={item} variant="secondary" className="rounded-md px-2 py-1 text-[11px] font-normal">
                {item}
              </Badge>
            ))}
            {group?.first_token_timeout_sec ? (
              <Badge variant="outline" className="gap-1 rounded-md px-2 py-1 text-[11px] font-normal">
                <Timer className="size-3" /> 首字 {group.first_token_timeout_sec}s
              </Badge>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["可调度", eligibleCount, "emerald"],
          ["临时暂停", snapshot.pausedCount, "amber"],
          ["禁用", snapshot.disabledCount, "muted"],
          ["配置路由", snapshot.rows.length, "sky"],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-lg border border-border bg-background px-4 py-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p
              className={`mt-1 flex items-center gap-2 text-xl font-semibold tabular-nums ${
                tone === "emerald" ? SOFT.emerald.text : tone === "amber" && Number(value) > 0 ? SOFT.amber.text : tone === "sky" ? SOFT.sky.text : "text-foreground"
              }`}
            >
              {value}
            </p>
          </div>
        ))}
      </div>

      {snapshot.eligible.length > 0 ? (
        <Card className="overflow-hidden border-border shadow-none">
          <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Route className="size-4 text-primary" />
                  当前尝试链
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  从左到右：主 → 备1 → 备2。同一档内按权重分流；整档失败 / 冷却才顺延到下一档。
                </p>
              </div>
              <Badge variant="outline" className="text-[10px]">
                {eligibleCount} 条可用
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
              {tiers.map((rows, index) => (
                <div key={rows[0].tier} className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {rows.map((row) => (
                      <RouteChainItem key={row.route.id ?? row.index} row={row} />
                    ))}
                    {rows.length > 1 ? (
                      <p className="text-center text-[10px] text-muted-foreground">同倍率 · 按权重分流</p>
                    ) : null}
                  </div>
                  {index < tiers.length - 1 ? (
                    <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground lg:block" aria-label="全部失败后顺延" />
                  ) : null}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed border-border shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <AlertTriangle className="size-5 text-amber-500" />
            <p className="text-sm font-medium">当前没有可调度路由</p>
            <p className="max-w-md text-xs leading-5 text-muted-foreground">
              检查路由是否启用、已绑定上游密钥，或是否仍处于临时暂停窗口。
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden border-border shadow-none">
        <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm">路由规则明细</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                顺序由有效倍率决定（同倍率按路由列表顺序）；分流占比是同一档内按权重的首选概率。
              </p>
            </div>
            <Badge variant="outline" className="gap-1.5 text-[10px]">
              <ShieldCheck className="size-3" /> 硬规则优先
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 py-0">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-muted/25 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium sm:px-5">顺序</th>
                <th className="px-3 py-3 font-medium">上游</th>
                <th className="px-3 py-3 font-medium">倍率</th>
                <th className="px-3 py-3 font-medium">同档分流</th>
                <th className="px-3 py-3 font-medium">协议</th>
                <th className="px-3 py-3 font-medium">并发配置</th>
                <th className="px-3 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium sm:px-5">原因</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snapshot.rows.map((row) => {
                const meta = stateMeta(row.state, row.tier)
                const StateIcon = meta.icon
                return (
                  <tr key={row.route.id ?? row.index} className="align-middle">
                    <td className="px-4 py-3 sm:px-5">
                      {row.tier >= 0 ? (
                        <TierBadge tier={row.tier} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-[230px] px-3 py-3">
                      <p className="truncate font-medium text-foreground">{row.sourceLabel}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        route {row.route.id ?? "—"}
                      </p>
                    </td>
                    <td className="px-3 py-3 font-mono">{formatSchedulerRate(row.rate)}</td>
                    <td className="w-[145px] px-3 py-3">
                      <div className="flex items-center gap-2">
                        <Progress
                          value={row.tierSize > 1 ? row.configuredShare * 100 : 0}
                          className={`h-1 ${PROGRESS_TINT[tierColor(row.tier) ?? "slate"]}`}
                        />
                        <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                          {row.tierSize > 1 ? formatSchedulerPercent(row.configuredShare) : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{row.protocolLabel}</td>
                    <td className="px-3 py-3 font-mono text-muted-foreground">
                      {row.route.concurrency || "—"}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={`gap-1 text-[10px] ${meta.className}`}>
                        <StateIcon className={`size-3 ${meta.iconClassName}`} /> {meta.label}
                      </Badge>
                    </td>
                    <td className="max-w-[180px] truncate px-4 py-3 text-muted-foreground sm:px-5">
                      {row.reason}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="border-border shadow-none">
          <CardContent className="flex items-start gap-3 px-4 py-4 sm:px-5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ShieldCheck className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">规则边界</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                权限、模型能力、密钥、启用状态、并发和故障转移由网关确定性执行；前端只展示密钥绑定信息，凭据有效性仍由后端校验。
              </p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-dashed border-border bg-muted/15 shadow-none">
          <CardContent className="flex items-start gap-3 px-4 py-4 sm:px-5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <BrainCircuit className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">智能评分层</p>
                <Badge variant="secondary" className="text-[10px]">未接入</Badge>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                后续 AI 只可基于延迟、错误率、成本和负载调整候选权重，结果需经过上方硬规则过滤后才可生效。
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
