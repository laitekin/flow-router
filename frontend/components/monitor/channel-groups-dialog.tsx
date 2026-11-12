"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowRightLeft, ChevronDown, Layers, Loader2, Plus, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Channel, RateSnapshot } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { channelTypeLabel, formatRatio, relativeTime } from "@/lib/format"
import { SOFT } from "@/lib/soft-tone"
import { cn } from "@/lib/utils"

/**
 * 「分组」：所有渠道的上游分组与倍率。
 *  - 按渠道：每个渠道一张卡，组内按倍率从低到高
 *  - 比价：跨渠道按倍率排成一列，倍率条直观对比
 * 每行直接给「建密钥 / 迁入」操作，不再藏在图标菜单里。
 */

interface Row {
  key: string
  channel: Channel
  rate: RateSnapshot
}

type View = "channel" | "compare"
type TypeFilter = "all" | "sub2api" | "newapi"

/** 倍率配色：便宜绿、偏贵琥珀、很贵玫红，其余中性（与卡片内倍率 chip 同一套阈值）。 */
function ratioBadge(r: number) {
  if (r <= 0.8) return SOFT.emerald.badge
  if (r > 2) return SOFT.rose.badge
  if (r > 1.2) return SOFT.amber.badge
  return "border-border bg-background text-foreground/80"
}

function ratioBar(r: number) {
  if (r <= 0.8) return SOFT.emerald.dot
  if (r > 2) return SOFT.rose.dot
  if (r > 1.2) return SOFT.amber.dot
  return "bg-slate-400 dark:bg-slate-500"
}

function TypeTag({ type }: { type: Channel["type"] }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded border px-1.5 text-[10px] font-medium",
        type === "newapi" ? SOFT.violet.badge : SOFT.blue.badge,
      )}
    >
      {channelTypeLabel(type)}
    </span>
  )
}

interface ChannelGroupsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channels: Channel[]
  onAPIKeyAction: (channel: Channel, rate: RateSnapshot, type: "create" | "migrate") => void
  /** 打开某渠道的「分组与模型」 */
  onOpenCatalog?: (channel: Channel) => void
  nestedDialogOpen: boolean
}

export function ChannelGroupsDialog({
  open,
  onOpenChange,
  channels,
  onAPIKeyAction,
  onOpenCatalog,
  nestedDialogOpen,
}: ChannelGroupsDialogProps) {
  const [query, setQuery] = useState("")
  const [view, setView] = useState<View>("channel")
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all(
      channels.map(async (channel) => {
        const rates = await apiFetch<RateSnapshot[]>(
          `/channels/${channel.id}/rates${channel.only_created_key_groups_enabled ? "?only_with_keys=1" : ""}`,
        )
        return { channel, rates }
      }),
    )
      .then((result) => {
        if (cancelled) return
        setRows(
          result.flatMap(({ channel, rates }) =>
            rates.map((rate) => ({ key: `${channel.id}-${rate.id}`, channel, rate })),
          ),
        )
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || "加载分组失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, channels])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(({ channel, rate }) => {
      if (typeFilter !== "all" && channel.type !== typeFilter) return false
      if (!q) return true
      return [channel.name, rate.model_name, rate.description ?? "", formatRatio(rate.ratio)].some((v) =>
        v.toLowerCase().includes(q),
      )
    })
  }, [rows, query, typeFilter])

  const byChannel = useMemo(() => {
    const map = new Map<number, { channel: Channel; rows: Row[] }>()
    for (const r of filtered) {
      const entry = map.get(r.channel.id) ?? { channel: r.channel, rows: [] }
      entry.rows.push(r)
      map.set(r.channel.id, entry)
    }
    return [...map.values()]
      .map((e) => ({ ...e, rows: e.rows.sort((a, b) => a.rate.ratio - b.rate.ratio) }))
      .sort((a, b) => a.channel.name.localeCompare(b.channel.name, "zh-CN"))
  }, [filtered])

  const compare = useMemo(() => [...filtered].sort((a, b) => a.rate.ratio - b.rate.ratio), [filtered])
  const maxRatio = Math.max(1, ...filtered.map((r) => r.rate.ratio))
  const channelCount = new Set(rows.map((r) => r.channel.id)).size
  const minAll = rows.length ? Math.min(...rows.map((r) => r.rate.ratio)) : 0

  const typeCounts = useMemo(() => {
    const c = { all: rows.length, sub2api: 0, newapi: 0 }
    for (const r of rows) c[r.channel.type as "sub2api" | "newapi"]++
    return c
  }, [rows])

  function renderActions(row: Row) {
    return (
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => onAPIKeyAction(row.channel, row.rate, "create")}
          title="在此分组新建 API Key"
        >
          <Plus className="size-3" />
          建密钥
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => onAPIKeyAction(row.channel, row.rate, "migrate")}
          title="把现有 API Key 移到此分组"
        >
          <ArrowRightLeft className="size-3" />
          迁入
        </Button>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid-cols-1 sm:max-w-3xl [&>*]:min-w-0"
        onInteractOutside={(event) => {
          if (nestedDialogOpen) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (nestedDialogOpen) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className={cn("flex size-6 items-center justify-center rounded-md border", SOFT.violet.badge)}>
              <Layers className="size-3.5" />
            </span>
            分组与倍率
          </DialogTitle>
          <DialogDescription className="text-xs">
            {loading
              ? "正在读取全部渠道分组…"
              : `${channelCount} 个渠道 · ${rows.length} 个分组${rows.length ? ` · 最低 ${formatRatio(minAll)}` : ""}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜渠道、分组、描述或倍率" className="h-9 pl-8 text-xs" />
          </div>
          <div className="inline-flex shrink-0 rounded-lg bg-muted p-0.5" role="tablist" aria-label="视图">
            {(
              [
                ["channel", "按渠道"],
                ["compare", "比价"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-all",
                  view === key ? "bg-background text-foreground shadow-xs ring-1 ring-border/60" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", "全部"],
              ["sub2api", "Sub2API"],
              ["newapi", "NewAPI"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTypeFilter(key)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                typeFilter === key
                  ? key === "newapi"
                    ? SOFT.violet.badge
                    : key === "sub2api"
                      ? SOFT.blue.badge
                      : "border-foreground/20 bg-muted text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              <span className="tabular-nums opacity-70">{typeCounts[key]}</span>
            </button>
          ))}
        </div>

        <div className="max-h-[58vh] min-h-48 overflow-y-auto pr-0.5">
          {loading ? (
            <p className="py-16 text-center text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
              加载中…
            </p>
          ) : error ? (
            <p className={cn("rounded-lg border px-3 py-3 text-xs", SOFT.rose.badge)}>{error}</p>
          ) : filtered.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-16 text-center text-xs text-muted-foreground">
              {rows.length === 0 ? "暂无分组数据，先同步渠道" : "没有匹配的分组"}
            </p>
          ) : view === "channel" ? (
            <div className="space-y-2.5">
              {byChannel.map(({ channel, rows: list }) => {
                const isCollapsed = collapsed[channel.id]
                const lowest = list[0]?.rate.ratio
                return (
                  <section key={channel.id} className="overflow-hidden rounded-xl border border-border bg-background">
                    <header className="flex items-center gap-2 px-3.5 py-2.5">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setCollapsed((p) => ({ ...p, [channel.id]: !isCollapsed }))}
                        aria-expanded={!isCollapsed}
                      >
                        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")} />
                        <span className="truncate text-sm font-medium">{channel.name}</span>
                        <TypeTag type={channel.type} />
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{list.length} 个分组</span>
                      </button>
                      {lowest != null ? (
                        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                          最低 <span className="font-mono text-foreground/80">{formatRatio(lowest)}</span>
                        </span>
                      ) : null}
                      {onOpenCatalog ? (
                        <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => onOpenCatalog(channel)}>
                          模型与价格
                        </Button>
                      ) : null}
                    </header>
                    {!isCollapsed ? (
                      <ul className="border-t border-border/70">
                        {list.map((row) => (
                          <li key={row.key} className="group flex items-center gap-3 px-3.5 py-2 transition-colors hover:bg-muted/30">
                            <span
                              className={cn(
                                "inline-flex h-6 min-w-14 shrink-0 items-center justify-center rounded-md border px-1.5 font-mono text-xs font-medium tabular-nums",
                                ratioBadge(row.rate.ratio),
                              )}
                            >
                              {formatRatio(row.rate.ratio)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] text-foreground">{row.rate.model_name}</p>
                              {row.rate.description ? (
                                <p className="truncate text-[11px] text-muted-foreground" title={row.rate.description}>
                                  {row.rate.description}
                                </p>
                              ) : null}
                            </div>
                            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{relativeTime(row.rate.last_seen_at)}</span>
                            {renderActions(row)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                )
              })}
            </div>
          ) : (
            <ul className="overflow-hidden rounded-xl border border-border bg-background">
              {compare.map((row, i) => (
                <li key={row.key} className="group flex items-center gap-3 border-b border-border/70 px-3.5 py-2 last:border-b-0 transition-colors hover:bg-muted/30">
                  <span className={cn("w-6 shrink-0 text-right font-mono text-[11px] tabular-nums", i === 0 ? SOFT.emerald.text : "text-muted-foreground")}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] text-foreground">{row.rate.model_name}</span>
                      <TypeTag type={row.channel.type} />
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">{row.channel.name}{row.rate.description ? ` · ${row.rate.description}` : ""}</p>
                  </div>
                  <div className="hidden w-28 shrink-0 sm:block" aria-hidden>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", ratioBar(row.rate.ratio))} style={{ width: `${Math.max(4, (row.rate.ratio / maxRatio) * 100)}%` }} />
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex h-6 min-w-14 shrink-0 items-center justify-center rounded-md border px-1.5 font-mono text-xs font-medium tabular-nums",
                      ratioBadge(row.rate.ratio),
                    )}
                  >
                    {formatRatio(row.rate.ratio)}
                  </span>
                  {renderActions(row)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
