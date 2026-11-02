import { useState } from "react"
import { AlertTriangle, DatabaseZap, Loader2, MoreHorizontal, Plus, RefreshCw, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  GatewayRoute,
} from "@/lib/api-types"
import {
  ModelMappingEditor,
  type MappingRow,
} from "./model-mapping-editor"
import {
  findSourceTest,
  resolveModelSources,
  sourceTagTone,
  testBusyKey,
} from "./gateway-utils"
import { ModelPreferenceDialog, modelPreferenceTriggerID } from "./model-preference-dialog"

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
  hasUnsavedChanges: boolean
  preferredChangesPending: boolean
  onPreferredRouteChange: (modelID: string, routeID?: number) => void
  customModel: string
  onCustomModelChange: (v: string) => void
  onAddCustomModel: () => void
  modelItems: GatewayModelListItem[]
  setModelItems: (items: GatewayModelListItem[]) => void
  routeDrafts: Partial<GatewayRoute>[]
  channelNameByID: Map<number, string>
  providerNameByID?: Map<number, string>
  modelTestResults: Record<string, GatewayModelTestResult[]>
  modelTesting: string | null
  onRunModelTestFor: (modelID: string, routeID?: number) => void
  onOpenModelTest: (m: GatewayModelListItem) => void
  mappingRows: MappingRow[]
  onMappingRowsChange: (rows: MappingRow[]) => void
  modelSuggestions: string[]
}

export function ModelsPanel({
  busy,
  modelsMode,
  onModelsModeChange,
  onSyncModels,
  onOpenCatalog,
  onSave,
  hasUnsavedChanges,
  preferredChangesPending,
  onPreferredRouteChange,
  customModel,
  onCustomModelChange,
  onAddCustomModel,
  modelItems,
  setModelItems,
  routeDrafts,
  channelNameByID,
  providerNameByID,
  modelTestResults,
  modelTesting,
  onRunModelTestFor,
  onOpenModelTest,
  mappingRows,
  onMappingRowsChange,
  modelSuggestions,
}: ModelsPanelProps) {
  const [preferenceModelID, setPreferenceModelID] = useState<string | null>(null)
  const preferenceModel = modelItems.find((m) => m.id === preferenceModelID)
  const preferenceSources = preferenceModel
    ? resolveModelSources(preferenceModel, routeDrafts, channelNameByID, providerNameByID)
        .filter((s) => s.route_id != null)
    : []
  const unavailableLabel = preferenceModel?.preferred_route_id &&
    !preferenceSources.some((s) => s.route_id === preferenceModel.preferred_route_id)
    ? preferenceModel.sources?.find((s) => s.route_id === preferenceModel.preferred_route_id)?.channel_name ||
      `线路 #${preferenceModel.preferred_route_id}`
    : undefined

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
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          保存模型配置
        </Button>
        {hasUnsavedChanges ? (
          <Badge variant="outline" role="status" className="border-amber-500/30 text-amber-700 dark:text-amber-300">
            未保存更改
          </Badge>
        ) : null}
      </div>
      <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
        {modelsModeHint(modelsMode)}
      </p>
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        每个模型可指定首选线路；更改后点击“保存模型配置”生效。
      </p>
    </div>

    <div className="flex flex-wrap items-center gap-2">
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
        disabled={busy || preferredChangesPending}
        title={preferredChangesPending ? "请先保存首选线路更改" : undefined}
      >
        <RefreshCw className="size-3.5" /> 从渠道同步去重
      </Button>
      <Button
        className="h-9"
        variant="outline"
        onClick={() => void onOpenCatalog()}
        disabled={busy || preferredChangesPending}
        title={preferredChangesPending ? "请先保存首选线路更改" : undefined}
      >
        <DatabaseZap className="size-3.5" /> 同步官方模型目录
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
              <TableHead className="w-[28%]">模型 ID</TableHead>
              <TableHead>渠道-分组</TableHead>
              <TableHead className="hidden w-12 px-1 text-center sm:table-cell">状态</TableHead>
              <TableHead className="w-24 text-right sm:w-28">操作</TableHead>
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
              const tests = modelTestResults[m.id] ?? []
              const okN = tests.filter((t) => t.ok).length
              const preferredID = Number(m.preferred_route_id) || 0
              const preferredSource = sources.find((s) => s.route_id === preferredID)
              const preferredUnavailable = preferredID > 0 && !preferredSource
              const preferredRoute = routeDrafts.find((r) => r.id === preferredID)
              const preferredCooling = preferredSource && preferredRoute?.temp_unschedulable_until &&
                new Date(preferredRoute.temp_unschedulable_until).getTime() > Date.now()
              const orderedSources = preferredSource
                ? [preferredSource, ...sources.filter((s) => s !== preferredSource)]
                : sources
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
                      <div className="flex max-w-full flex-wrap content-start gap-1">
                        {orderedSources.map((s) => {
                          const tr = findSourceTest(s, tests)
                          const tone = sourceTagTone(tr)
                          const tagBusy =
                            s.route_id != null &&
                            modelTesting === testBusyKey(m.id, s.route_id)
                          return (
                            <Tooltip key={s.key}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  disabled={!!modelTesting}
                                  className={cn(
                                    "inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0 text-left text-[11px] font-normal transition-colors",
                                    "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    "disabled:cursor-wait disabled:opacity-80",
                                    tone.className,
                                    s.route_id === preferredID && "border-primary/40 bg-primary/5",
                                    tagBusy && "ring-1 ring-primary/40",
                                  )}
                                  onClick={() => {
                                    if (s.route_id != null) {
                                      void onRunModelTestFor(m.id, s.route_id)
                                    } else {
                                      onOpenModelTest(m)
                                    }
                                  }}
                                >
                                  {tagBusy ? (
                                    <Loader2 className="size-3 shrink-0 animate-spin" />
                                  ) : null}
                                  {s.route_id === preferredID ? (
                                    <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary">
                                      <Star className="size-3" /> 首选
                                    </span>
                                  ) : preferredID > 0 ? (
                                    <span className="shrink-0 text-muted-foreground">备用</span>
                                  ) : null}
                                  <span className="min-w-0 break-all">
                                    {s.label}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                className="max-w-xs space-y-1 p-2.5 text-xs"
                              >
                                <div className="font-medium">{s.label}</div>
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
                          )
                        })}
                      </div>
                    )}
                    {preferredUnavailable ? (
                      <p role="status" className="mt-1.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        <span>首选不可用{sources.length ? "，将按规则选择备用。" : "，请启用或重新绑定线路。"}</span>
                      </p>
                    ) : preferredCooling ? (
                      <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">首选冷却中，将使用其他可用线路。</p>
                    ) : preferredID === 0 ? (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">自动选择</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden px-1 text-center align-top text-xs sm:table-cell">
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
                        className="min-h-11 px-2 text-xs sm:min-h-8"
                        aria-label={`设置 ${m.id} 的首选线路`}
                        id={modelPreferenceTriggerID(m.id)}
                        disabled={busy}
                        onClick={() => setPreferenceModelID(m.id)}
                      >
                        <Star className="size-3.5" /> 首选
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="min-h-11 w-8 sm:min-h-8" aria-label={`${m.id} 的更多操作`} disabled={busy}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => onOpenModelTest(m)}>测试模型</DropdownMenuItem>
                          <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => onMappingRowsChange([...mappingRows, { from: m.id, to: "" }])}>添加映射</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="min-h-11 sm:min-h-8" variant="destructive" onSelect={() => setModelItems(modelItems.filter((x) => x.id !== m.id))}>移除模型</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
      <ul className="w-full max-w-full space-y-0.5 text-[11px] leading-5 text-muted-foreground">
        <li>• 首选、备用仅来自该模型的可用绑定；禁用线路不参与选择</li>
        <li>• 未配置路由时，提示先在「路由」里配渠道并启用</li>
        <li>• 直连 provider 会显示渠道名（有的话）或 直连 #id</li>
        <li>
          • 未绑定具体线路的自定义模型，沿用组内全部启用线路
        </li>
      </ul>
    </div>

    <ModelMappingEditor
      rows={mappingRows}
      onChange={onMappingRowsChange}
      modelSuggestions={modelSuggestions}
    />
  </CardContent>
</Card>

      {preferenceModel ? (
        <ModelPreferenceDialog
          key={preferenceModel.id}
          model={preferenceModel}
          sources={preferenceSources}
          unavailableLabel={unavailableLabel}
          busy={busy}
          onClose={() => setPreferenceModelID(null)}
          onApply={(routeID) => {
            onPreferredRouteChange(preferenceModel.id, routeID)
            setPreferenceModelID(null)
          }}
        />
      ) : null}

    </div>
  )
}
