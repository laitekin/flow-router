import { ArrowRight, DatabaseZap, FlaskConical, Loader2, Plus, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  GatewayModelListItem,
  GatewayModelTestResult,
  GatewayProviderOption,
  GatewayRoute,
  RateSnapshot,
} from "@/lib/api-types"
import {
  ModelMappingEditor,
  type MappingRow,
} from "./model-mapping-editor"
import {
  findSourceTest,
  formatRate,
  isRouteTempPaused,
  resolveModelSources,
  routeEffectiveRate,
  sourceTagTone,
  modelSourceTests,
  type ModelSourceLabel,
} from "./gateway-utils"
import { assignRouteTiers, tierLabel, type TierEntry, type TierState } from "./route-tiers"
import { TierBadge, TierBars } from "./tier-badge"

const MODELS_MODE_OPTIONS = [
  {
    value: "auto",
    label: "auto · 实时聚合",
    description:
      "GET /v1/models 按路由实时拉取各上游模型并去重映射，不读下方列表",
    hint: "公开模型目录来自各路由上游的实时聚合；下方列表仅作管理/测试参考，保存后也不影响 /v1/models。",
  },
  {
    value: "manual",
    label: "manual · 仅列表",
    description: "GET /v1/models 只返回下方已保存的模型列表",
    hint: "公开模型目录完全由下方列表决定；需「从渠道同步」或手动添加后点保存才会生效。",
  },
  {
    value: "hybrid",
    label: "hybrid · 聚合∪补充目录",
    description: "实时聚合上游模型，并合并自定义和官方目录项",
    hint: "公开模型目录 = 上游实时聚合 ∪ 下方「自定义」模型 ∪「官方目录」模型。",
  },
] as const

function modelsModeHint(mode: string): string {
  return (
    MODELS_MODE_OPTIONS.find((o) => o.value === mode)?.hint ??
    MODELS_MODE_OPTIONS[0].hint
  )
}

type ModelsPanelProps = {
  busy: boolean
  modelsMode: string
  onModelsModeChange: (v: string) => void
  onSyncModels: () => void
  onOpenCatalog: () => void
  onSave: () => void
  customModel: string
  onCustomModelChange: (v: string) => void
  onAddCustomModel: () => void
  modelItems: GatewayModelListItem[]
  setModelItems: (items: GatewayModelListItem[]) => void
  routeDrafts: Partial<GatewayRoute>[]
  channelNameByID: Map<number, string>
  providerNameByID?: Map<number, string>
  modelTestResults: Record<string, GatewayModelTestResult[]>
  isModelTesting: (model: string, routeID?: number) => boolean
  activeTestCount: number
  onRunModelTestFor: (modelID: string, routeID?: number) => void
  /** null opens the test bench with only the model picker */
  onOpenModelTest: (m: GatewayModelListItem | null) => void
  mappingRows: MappingRow[]
  onMappingRowsChange: (rows: MappingRow[]) => void
  modelSuggestions: string[]
  /** 主备分档用：源分组倍率、直连渠道、分组的倍率排序方向 */
  sourceGroupsByChannel?: Record<number, RateSnapshot[]>
  providers?: GatewayProviderOption[]
  rateDirection?: string
}

type SourceTierEntry = TierEntry<ModelSourceLabel> & { bound: boolean }

/** 按调度顺序给模型的来源分档：主 → 备1 → 备2 …（与后端 SortRoutes 一致） */
function tierModelSources(
  sources: ModelSourceLabel[],
  routes: Partial<GatewayRoute>[],
  sourceGroupsByChannel: Record<number, RateSnapshot[]>,
  providers: GatewayProviderOption[],
  direction: string,
): SourceTierEntry[] {
  const byID = new Map(routes.map((r, i) => [r.id, { route: r, index: i }]))
  const now = Date.now()
  const inputs = sources.flatMap((s, i) => {
    const hit = s.route_id != null ? byID.get(s.route_id) : undefined
    if (!hit) return []
    const r = hit.route
    const state: TierState =
      r.enabled === false ? "disabled" : isRouteTempPaused(r.temp_unschedulable_until, now) ? "paused" : "active"
    const rate = routeEffectiveRate(r, sourceGroupsByChannel[Number(r.source_channel_id) || 0] ?? [], providers)
    const weight = r.weight == null ? 1 : Number(r.weight) || 0
    return [{ item: s, index: hit.index * 1000 + i, rate: Number.isFinite(rate) ? rate : 0, weight, state }]
  })
  const tiered = assignRouteTiers(inputs, direction).map((e) => ({ ...e, bound: true }))
  const placed = new Set(tiered.map((e) => e.item.key))
  // 没有对应路由的旧数据来源（仅渠道级），排在最后，不参与分档
  const loose = sources
    .filter((s) => !placed.has(s.key))
    .map<SourceTierEntry>((s, i) => ({ item: s, index: i, rate: 0, weight: 0, state: "active", tier: -1, share: 0, tierSize: 0, bound: false }))
  return [...tiered, ...loose]
}

function testDot(tr?: GatewayModelTestResult) {
  if (!tr) return "border border-muted-foreground/50 bg-transparent"
  if (!tr.ok) return "bg-rose-500/80"
  if (tr.latency_ms <= 5_000) return "bg-emerald-500/80"
  if (tr.latency_ms <= 10_000) return "bg-amber-500/80"
  return "bg-orange-500/80"
}

export function ModelsPanel({
  busy,
  modelsMode,
  onModelsModeChange,
  onSyncModels,
  onOpenCatalog,
  onSave,
  customModel,
  onCustomModelChange,
  onAddCustomModel,
  modelItems,
  setModelItems,
  routeDrafts,
  channelNameByID,
  providerNameByID,
  modelTestResults,
  isModelTesting,
  activeTestCount,
  onRunModelTestFor,
  onOpenModelTest,
  mappingRows,
  onMappingRowsChange,
  modelSuggestions,
  sourceGroupsByChannel = {},
  providers = [],
  rateDirection = "asc",
}: ModelsPanelProps) {
  return (
    <div className="space-y-4">
<Card className="overflow-hidden border-border shadow-none">
  <CardContent className="space-y-6 p-4 sm:p-5">
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <Label className="shrink-0">模型列表模式</Label>
        <Select value={modelsMode} onValueChange={onModelsModeChange}>
          <SelectTrigger className="w-[13.5rem]">
            <SelectValue placeholder="选择模式" />
          </SelectTrigger>
          <SelectContent className="min-w-[22rem]">
            {MODELS_MODE_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                description={opt.description}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => void onSave()} disabled={busy}>
          保存
        </Button>
      </div>
      <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
        {modelsModeHint(modelsMode)}
      </p>
    </div>

    <div className="flex flex-wrap items-center gap-2">
      {activeTestCount > 0 ? (
        <Badge variant="secondary" className="gap-1.5" role="status">
          <Loader2 className="size-3 animate-spin" />
          {activeTestCount} 项测试运行或排队中
        </Badge>
      ) : null}
      <Input
        className="h-9 max-w-xs"
        placeholder="自定义模型 ID"
        value={customModel}
        onChange={(e) => onCustomModelChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onAddCustomModel()}
      />
      <Button className="h-9" variant="outline" onClick={onAddCustomModel}>
        <Plus className="size-3.5" /> 添加自定义
      </Button>
      <Button
        className="h-9"
        variant="outline"
        onClick={() => void onSyncModels()}
        disabled={busy}
      >
        <RefreshCw className="size-3.5" /> 从渠道同步去重
      </Button>
      <Button
        className="h-9"
        variant="outline"
        onClick={() => void onOpenCatalog()}
        disabled={busy}
      >
        <DatabaseZap className="size-3.5" /> 同步官方模型目录
      </Button>
      <Button
        className="h-9"
        variant="outline"
        onClick={() => onOpenModelTest(null)}
        title="搜索并测试已保存的模型或各路由上报的模型"
      >
        <FlaskConical className="size-3.5" /> 模型测试台
      </Button>
    </div>

    <div className="w-full min-w-0 space-y-2">
      {/*
        table-fixed + 容器 min-w-0：列宽按可见区域分配，
        「渠道-分组」标签在格内换行，不把整表撑出横向滚动。
      */}
      <div className="w-full min-w-0 overflow-hidden rounded-md border">
        <Table className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">模型 ID</TableHead>
              <TableHead className="w-[46%]">
                绑定路由 · 主备顺序
                <span className="ml-1 font-normal text-muted-foreground">（同档按权重分流）</span>
              </TableHead>
              <TableHead className="w-14 px-1 text-center">状态</TableHead>
              <TableHead className="w-[22%] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modelItems.map((m) => {
              const sources = resolveModelSources(
                m,
                routeDrafts,
                channelNameByID,
                providerNameByID,
              )
              const tests = modelSourceTests(sources, modelTestResults[m.id] ?? [])
              const okN = tests.filter((t) => t.ok).length
              return (
                <TableRow key={m.id}>
                  <TableCell className="align-top">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <code className="max-w-full break-all text-xs sm:truncate sm:text-sm" title={m.id}>
                        {m.id}
                      </code>
                      <Badge
                        variant={m.source === "custom" ? "secondary" : "outline"}
                        className="h-5 shrink-0 px-1.5 text-[10px] font-normal"
                      >
                        {m.source === "custom"
                          ? "自定义"
                          : m.source === "catalog"
                            ? "官方目录"
                            : "同步"}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    {sources.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        未配置可用路由
                      </span>
                    ) : (
                      <div className="flex max-w-full flex-wrap content-start items-center gap-1">
                        {tierModelSources(sources, routeDrafts, sourceGroupsByChannel, providers, rateDirection).map((entry, i, all) => {
                          const s = entry.item
                          const tr = findSourceTest(s, tests)
                          const tone = sourceTagTone(tr)
                          const prev = all[i - 1]
                          const tierStart = i > 0 && prev.tier !== entry.tier && entry.tier > 0
                          const tagBusy =
                            s.route_id != null &&
                            isModelTesting(m.id, s.route_id)
                          const pill =
                            entry.state === "disabled"
                              ? "停用"
                              : entry.state === "paused"
                                ? "冷却"
                                : entry.bound
                                  ? tierLabel(entry.tier)
                                  : "?"
                          return (
                            <span key={s.key} className="inline-flex max-w-full items-center gap-1">
                              {tierStart ? (
                                <ArrowRight
                                  className="size-3 shrink-0 text-muted-foreground/60"
                                  aria-label="失败后顺延"
                                />
                              ) : null}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  disabled={tagBusy}
                                  className={cn(
                                    "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-left text-[11px] font-normal text-foreground/85 transition-colors",
                                    "cursor-pointer outline-none hover:border-foreground/20 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40",
                                    "disabled:cursor-wait disabled:opacity-80",
                                    entry.tier < 0 && "border-dashed text-muted-foreground",
                                    tagBusy && "ring-1 ring-ring/30",
                                  )}
                                  onClick={() => {
                                    if (s.route_id != null) {
                                      void onRunModelTestFor(m.id, s.route_id)
                                    } else {
                                      onOpenModelTest(m)
                                    }
                                  }}
                                >
                                  <span className="inline-flex shrink-0 items-center gap-1 border-r border-border pr-1.5 text-[10px] font-medium text-muted-foreground">
                                    <TierBars tier={entry.bound ? entry.tier : -1} />
                                    {pill}
                                  </span>
                                  {tagBusy ? (
                                    <Loader2 className="size-3 shrink-0 animate-spin" />
                                  ) : (
                                    <span
                                      className={cn("size-1.5 shrink-0 rounded-full", testDot(tr))}
                                      aria-hidden
                                    />
                                  )}
                                  <span className="min-w-0 break-all">
                                    {s.label}
                                  </span>
                                  {entry.bound ? (
                                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                      ×{formatRate(entry.rate)}
                                      {entry.tierSize > 1 ? ` · ${Math.round(entry.share * 100)}%` : ""}
                                    </span>
                                  ) : null}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                className="max-w-xs space-y-1 p-2.5 text-xs"
                              >
                                <div className="font-medium">{s.label}</div>
                                <div>
                                  {entry.state === "disabled"
                                    ? "路由已停用，不参与调度"
                                    : entry.state === "paused"
                                      ? "冷却中，暂不参与调度"
                                      : !entry.bound
                                        ? "未匹配到具体路由"
                                        : entry.tier === 0
                                          ? entry.tierSize > 1
                                            ? `主路由 · 与另外 ${entry.tierSize - 1} 条同倍率路由按权重分流（${Math.round(entry.share * 100)}%）`
                                            : "主路由 · 首选"
                                          : `备用第 ${entry.tier} 档 · 前面各档都失败 / 冷却才会用到`}
                                </div>
                                {s.sourceTip ? (
                                  <div className="text-muted-foreground">
                                    {s.sourceTip}
                                  </div>
                                ) : null}
                                <div className="text-muted-foreground">
                                  {tagBusy ? "测试中…" : tone.summary}
                                </div>
                                {tr && !tagBusy ? (
                                  <div className="space-y-0.5 border-t border-border/60 pt-1 text-[11px] text-muted-foreground">
                                    {tr.upstream_model ? (
                                      <div>上游模型：{tr.upstream_model}</div>
                                    ) : null}
                                    {tr.upstream_path ? (
                                      <div>路径：{tr.upstream_path}</div>
                                    ) : null}
                                    {tr.status_code ? (
                                      <div>HTTP {tr.status_code}</div>
                                    ) : null}
                                    {tr.ok ? (
                                      <div>首字 {tr.latency_ms}ms</div>
                                    ) : tr.error ? (
                                      <div className="break-words text-destructive">
                                        {tr.error}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                                {!tagBusy ? (
                                  <div className="border-t border-border/60 pt-1 text-[11px] text-muted-foreground">
                                    点击直接测试（不打开弹窗）
                                  </div>
                                ) : null}
                              </TooltipContent>
                            </Tooltip>
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="px-1 text-center align-top text-xs">
                    {tests.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          "font-medium tabular-nums",
                          okN === tests.length
                            ? "text-emerald-600 dark:text-emerald-400"
                            : okN > 0
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-destructive",
                        )}
                      >
                        {okN}/{tests.length}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onOpenModelTest(m)}
                      >
                        测试
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          onMappingRowsChange([
                            ...mappingRows,
                            { from: m.id, to: "" },
                          ])
                        }
                      >
                        映射
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setModelItems(
                            modelItems.filter((x) => x.id !== m.id),
                          )
                        }
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {modelItems.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-muted-foreground"
                >
                  同步渠道模型或添加自定义模型
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {[0, 1, 2].map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <TierBadge tier={t} bare />
            <span>{t === 0 ? "首选" : t === 1 ? "主档全挂才用" : "再往后顺延"}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <TierBadge tier={-1} inactiveLabel="停用 / 冷却" bare />
          <span>不参与</span>
        </span>
        <span className="h-3 w-px bg-border" aria-hidden />
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500/80" />可用
          <span className="size-1.5 rounded-full bg-amber-500/80" />慢
          <span className="size-1.5 rounded-full bg-rose-500/80" />失败
          <span className="size-1.5 rounded-full border border-muted-foreground/50" />未测
        </span>
      </div>
      <ul className="w-full max-w-full space-y-0.5 text-[11px] leading-5 text-muted-foreground">
        <li>
          主备按有效倍率{rateDirection === "desc" ? "从高到低" : "从低到高"}自动分档（与网关实际调度一致）：同倍率是同一档、按权重分流；前一档全部失败或冷却才顺延到下一档。想调整主备，改路由倍率或在「渠道路由」里调顺序。
        </li>
        <li>圆点为最近一次测试结果，点击路由可直接重新测试。</li>
        {modelItems.some((m) => m.source === "custom" && !m.sources?.some((s) => s.route_id)) ? (
          <li>未限定线路的旧自定义模型沿用分组默认线路。</li>
        ) : null}
      </ul>
    </div>

    <ModelMappingEditor
      rows={mappingRows}
      onChange={onMappingRowsChange}
      modelSuggestions={modelSuggestions}
    />
  </CardContent>
</Card>

    </div>
  )
}
