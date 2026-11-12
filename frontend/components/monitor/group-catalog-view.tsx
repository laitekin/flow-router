"use client"

import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { CatalogModel, GroupCatalog } from "@/lib/api-types"
import { cn } from "@/lib/utils"

/**
 * GroupCatalogView 展示「分组 → 分组倍率（价格）→ 分组下的模型」。
 * 快速导入预览与渠道「分组与模型」对话框共用。
 */

const PLATFORM_TONE: Record<string, string> = {
  anthropic: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300",
  openai: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  gemini: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300",
  antigravity: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300",
}

function platformTone(p?: string) {
  return PLATFORM_TONE[(p ?? "").toLowerCase()] ?? "border-border bg-muted/50 text-muted-foreground"
}

export function formatUSD(v: number): string {
  if (!Number.isFinite(v)) return "—"
  if (v === 0) return "$0"
  const abs = Math.abs(v)
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return `$${v.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`
}

export function formatRatio(v: number): string {
  if (!Number.isFinite(v)) return "—"
  return `×${Number(v.toFixed(4))}`
}

/** 模型在该分组下的实际价格文案（已乘分组倍率）。 */
export function modelPriceLabel(m: CatalogModel, ratio: number): string | null {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  if (m.per_request != null && m.per_request > 0) return `${formatUSD(m.per_request * r)}/次`
  if (m.input_per_mtok != null || m.output_per_mtok != null) {
    const parts: string[] = []
    if (m.input_per_mtok != null) parts.push(`入 ${formatUSD(m.input_per_mtok * r)}`)
    if (m.output_per_mtok != null) parts.push(`出 ${formatUSD(m.output_per_mtok * r)}`)
    return `${parts.join(" · ")} /1M`
  }
  return null
}

/** 比较价格用的单值：按次价 or 输入价。 */
function modelSortPrice(m: CatalogModel, ratio: number): number {
  if (m.per_request != null && m.per_request > 0) return m.per_request * ratio
  if (m.input_per_mtok != null) return m.input_per_mtok * ratio
  return Number.POSITIVE_INFINITY
}

function ratioTone(ratio: number, min: number, max: number) {
  if (max > min && ratio === min) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
  }
  if (ratio > 1) {
    return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
  }
  return "border-border bg-background text-foreground"
}

interface GroupCatalogViewProps {
  groups: GroupCatalog[]
  className?: string
  /** 列表最大高度（超出滚动），默认 22rem */
  maxHeightClass?: string
}

export function GroupCatalogView({ groups, className, maxHeightClass = "max-h-[22rem]" }: GroupCatalogViewProps) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const ratios = groups.map((g) => g.ratio).filter((r) => Number.isFinite(r))
  const minRatio = ratios.length ? Math.min(...ratios) : 1
  const maxRatio = ratios.length ? Math.max(...ratios) : 1
  const totalModels = useMemo(() => new Set(groups.flatMap((g) => g.models.map((m) => m.name))).size, [groups])
  const anyModelsKnown = groups.some((g) => g.models_known)

  const q = query.trim().toLowerCase()
  const hits = useMemo(() => {
    if (!q) return []
    const out: { group: GroupCatalog; model: CatalogModel; price: number }[] = []
    for (const g of groups) {
      for (const m of g.models) {
        if (m.name.toLowerCase().includes(q)) out.push({ group: g, model: m, price: modelSortPrice(m, g.ratio) })
      }
    }
    // 先按实际价，价格未知时按分组倍率
    return out.sort((a, b) => a.price - b.price || a.group.ratio - b.group.ratio || a.model.name.localeCompare(b.model.name))
  }, [groups, q])

  if (groups.length === 0) {
    return (
      <p className={cn("rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground", className)}>
        该账号没有可用分组
      </p>
    )
  }

  const isOpen = (key: string) => expanded[key] ?? groups.length <= 2

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={anyModelsKnown ? "搜模型：看哪个分组有、实际多少钱" : "上游未公开分组模型清单"}
            disabled={!anyModelsKnown}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <p className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {groups.length} 个分组{anyModelsKnown ? ` · ${totalModels} 个模型` : ""}
        </p>
      </div>

      {q ? (
        <div className={cn("overflow-y-auto rounded-lg border border-border", maxHeightClass)}>
          {hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有分组提供「{query}」</p>
          ) : (
            <ul className="divide-y divide-border">
              {hits.map(({ group, model }, i) => {
                const price = modelPriceLabel(model, group.ratio)
                return (
                  <li key={`${group.name}-${model.name}`} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span
                      className={cn(
                        "w-9 shrink-0 text-center text-[10px] font-semibold",
                        i === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                      )}
                    >
                      {i === 0 ? "最便宜" : `#${i + 1}`}
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono" title={model.name}>{model.name}</code>
                    <span className="max-w-[9rem] shrink-0 truncate text-muted-foreground" title={group.name}>{group.name}</span>
                    <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px]", ratioTone(group.ratio, minRatio, maxRatio))}>
                      {formatRatio(group.ratio)}
                    </span>
                    <span className="w-[9.5rem] shrink-0 text-right font-mono text-[11px] tabular-nums">{price ?? "—"}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className={cn("overflow-y-auto rounded-lg border border-border", maxHeightClass)}>
          <ul className="divide-y divide-border">
            {groups.map((g) => {
              const key = `${g.id ?? ""}:${g.name}`
              const open = isOpen(key)
              return (
                <li key={key}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => setExpanded((prev) => ({ ...prev, [key]: !open }))}
                    aria-expanded={open}
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{g.name}</span>
                        {g.platform ? (
                          <span className={cn("rounded border px-1 py-0 text-[10px]", platformTone(g.platform))}>{g.platform}</span>
                        ) : null}
                        {g.subscription_type === "subscription" ? (
                          <span className="rounded border border-violet-200 bg-violet-50 px-1 py-0 text-[10px] text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300">
                            订阅
                          </span>
                        ) : null}
                      </div>
                      {g.description ? (
                        <p className="truncate text-[11px] text-muted-foreground" title={g.description}>{g.description}</p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {g.models_known ? `${g.models.length} 个模型` : "模型未公开"}
                    </span>
                    <span
                      className={cn("w-16 shrink-0 rounded-md border px-1.5 py-0.5 text-center font-mono text-xs font-medium", ratioTone(g.ratio, minRatio, maxRatio))}
                      title="分组倍率：实际价 = 模型基础价 × 分组倍率"
                    >
                      {formatRatio(g.ratio)}
                    </span>
                  </button>
                  {open ? (
                    <div className="bg-muted/20 px-3 pt-1 pb-2.5 pl-8">
                      {!g.models_known ? (
                        <p className="text-[11px] text-muted-foreground">
                          上游没有公开该分组的模型清单（Sub2API 需站点开启「可用渠道」）。保存后为该分组创建密钥，网关「从渠道同步」即可拉到模型。
                        </p>
                      ) : g.models.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">该分组下没有模型</p>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {g.models.map((m) => {
                            const price = modelPriceLabel(m, g.ratio)
                            return (
                              <Tooltip key={m.name}>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex max-w-full cursor-default items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px]">
                                    <span className="truncate font-mono">{m.name}</span>
                                    {price ? <span className="shrink-0 text-muted-foreground">{price.replace(" /1M", "")}</span> : null}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                  <div className="font-mono">{m.name}</div>
                                  <div>{price ? `${price}（已含 ${formatRatio(g.ratio)}）` : "上游未提供价格"}</div>
                                </TooltipContent>
                              </Tooltip>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
