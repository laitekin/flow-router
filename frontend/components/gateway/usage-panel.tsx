import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, Loader2, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatDurationMS, formatTokens, money } from "@/lib/format"
import { cn } from "@/lib/utils"
import type {
  GatewayGroup,
  GatewayKey,
  GatewayUsageModelOption,
  GatewayUsagePage,
  GatewayUsageStats,
} from "@/lib/api-types"
import { GatewayUsageTable } from "./usage-table"
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGE_PRESETS,
  usageRangeFor,
  type UsageRangePreset,
} from "./usage-time"

/** 解析密钥筛选值：all / 数字 id / 按名称或前缀匹配组内密钥 */
function resolveUsageKeyFilter(
  raw: string,
  keys: GatewayKey[],
): { keyID: string; label: string } {
  const v = raw.trim()
  if (!v || v === "all") return { keyID: "all", label: "全部密钥" }
  if (/^\d+$/.test(v)) {
    const byID = keys.find((k) => String(k.id) === v)
    if (byID) {
      return {
        keyID: String(byID.id),
        label: byID.key_prefix
          ? `${byID.name} · ${byID.key_prefix}`
          : byID.name,
      }
    }
    return { keyID: v, label: `密钥 #${v}` }
  }
  const lower = v.toLowerCase()
  const byName = keys.find(
    (k) =>
      k.name.toLowerCase() === lower ||
      (k.key_prefix || "").toLowerCase() === lower ||
      (k.key_prefix || "").toLowerCase().startsWith(lower) ||
      k.name.toLowerCase().includes(lower),
  )
  if (byName) {
    return {
      keyID: String(byName.id),
      label: byName.key_prefix
        ? `${byName.name} · ${byName.key_prefix}`
        : byName.name,
    }
  }
  // 未匹配到：仍按数字失败时无法筛选；返回 all 并保留展示文案无意义
  // 这里把自定义串当作无效，调用方应提示；或尝试 id
  return { keyID: "all", label: v }
}

function UsageKeyCombobox({
  keys,
  groups,
  value,
  onChange,
}: {
  keys: GatewayKey[]
  groups: GatewayGroup[]
  value: string
  onChange: (keyID: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const groupNameByID = useMemo(() => {
    const m = new Map<number, string>()
    for (const g of groups) m.set(g.id, g.name)
    return m
  }, [groups])

  const selected = useMemo(() => {
    if (!value || value === "all") return null
    return keys.find((k) => String(k.id) === value) ?? null
  }, [keys, value])

  // 触发器只展示密钥名称；下拉 option 仍为双行详情
  const label =
    !value || value === "all"
      ? "全部密钥"
      : selected
        ? selected.name
        : /^\d+$/.test(value)
          ? `密钥 #${value}`
          : value

  const q = query.trim()
  const qLower = q.toLowerCase()
  const filtered = !q
    ? keys
    : keys.filter((k) => {
        const gn = (groupNameByID.get(k.group_id) || "").toLowerCase()
        return (
          k.name.toLowerCase().includes(qLower) ||
          (k.key_prefix || "").toLowerCase().includes(qLower) ||
          String(k.id).includes(q) ||
          gn.includes(qLower)
        )
      })

  const exactInList =
    !!q &&
    keys.some(
      (k) =>
        String(k.id) === q ||
        k.name.toLowerCase() === qLower ||
        (k.key_prefix || "").toLowerCase() === qLower,
    )
  const customResolved = q && !exactInList ? resolveUsageKeyFilter(q, keys) : null
  const showCustom =
    !!customResolved &&
    customResolved.keyID !== "all" &&
    customResolved.keyID !== value

  function pick(keyID: string) {
    onChange(keyID)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between bg-background px-3 font-normal"
        >
          <span className="min-w-0 truncate text-left">{label}</span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="搜索或输入密钥名 / 前缀 / ID"
          />
          <CommandList>
            <CommandEmpty>无匹配密钥</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={() => pick("all")}>
                <Check
                  className={cn(
                    "size-4",
                    !value || value === "all" ? "opacity-100" : "opacity-0",
                  )}
                />
                全部密钥
              </CommandItem>
            </CommandGroup>
            {filtered.length > 0 || showCustom ? <CommandSeparator /> : null}
            <CommandGroup>
              {filtered.map((k) => {
                const groupLabel =
                  k.group_id > 0
                    ? groupNameByID.get(k.group_id) || `组#${k.group_id}`
                    : ""
                return (
                  <CommandItem
                    key={k.id}
                    value={`${k.id} ${k.name} ${k.key_prefix || ""} ${groupLabel}`}
                    onSelect={() => pick(String(k.id))}
                    className="items-start py-2"
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        value === String(k.id) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-medium leading-tight">
                          {k.name}
                        </span>
                        {groupLabel ? (
                          <span className="shrink-0 text-[11px] leading-tight text-muted-foreground">
                            {groupLabel}
                          </span>
                        ) : null}
                      </div>
                      {k.key_prefix ? (
                        <div className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
                          {k.key_prefix}
                        </div>
                      ) : null}
                    </div>
                  </CommandItem>
                )
              })}
              {showCustom && customResolved ? (
                <CommandItem
                  value={`custom ${q}`}
                  onSelect={() => pick(customResolved.keyID)}
                  className="items-start py-2"
                >
                  <Check className="mt-0.5 size-4 shrink-0 opacity-0" />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="truncate text-sm leading-tight">
                      使用自定义
                    </div>
                    <div className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
                      {customResolved.label}
                    </div>
                  </div>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

type UsageQueryOpts = {
  groupID: string
  keyID: string
  model: string
  requestID: string
  success: string
  from: string
  to: string
  page: number
  pageSize: number
}

type UsagePanelProps = {
  usage: GatewayUsagePage | null
  usageStats: GatewayUsageStats | null
  usageLoading: boolean
  groups: GatewayGroup[]
  usageKeys: GatewayKey[]
  usageGroupFilter: string
  setUsageGroupFilter: (v: string) => void
  usageKeyFilter: string
  setUsageKeyFilter: (v: string) => void
  usageModelFilter: string
  setUsageModelFilter: (v: string) => void
  usageModelOptions: GatewayUsageModelOption[]
  usageRequestIDFilter: string
  setUsageRequestIDFilter: (v: string) => void
  usageSuccessFilter: string
  setUsageSuccessFilter: (v: string) => void
  usageFrom: string
  setUsageFrom: (v: string) => void
  usageTo: string
  setUsageTo: (v: string) => void
  usageRange: UsageRangePreset | ""
  setUsageRange: (v: UsageRangePreset | "") => void
  setUsagePage: (v: number) => void
  usagePageSize: number
  setUsagePageSize: (v: number) => void
  usageQueryOpts: (page?: number, pageSize?: number) => UsageQueryOpts
  loadUsage: (opts?: Partial<UsageQueryOpts> & { groupID?: string | number | null }) => void
  refreshUsage: (page?: number) => void
  goUsagePage: (p: number) => void
}

const AUTO_REFRESH_STORAGE_KEY = "gateway-usage-auto-refresh-v1"
const AUTO_REFRESH_OPTIONS = [0, 10, 30, 60] as const

function loadAutoRefresh(): number {
  try {
    const n = Number(window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY))
    return (AUTO_REFRESH_OPTIONS as readonly number[]).includes(n) ? n : 0
  } catch {
    return 0
  }
}

function percent(part: number, whole: number) {
  if (!whole || whole <= 0) return "—"
  return `${((part / whole) * 100).toFixed(1)}%`
}

export function UsagePanel({
  usage,
  usageStats,
  usageLoading,
  groups,
  usageKeys,
  usageGroupFilter,
  setUsageGroupFilter,
  usageKeyFilter,
  setUsageKeyFilter,
  usageModelFilter,
  setUsageModelFilter,
  usageModelOptions,
  usageRequestIDFilter,
  setUsageRequestIDFilter,
  usageSuccessFilter,
  setUsageSuccessFilter,
  usageFrom,
  setUsageFrom,
  usageTo,
  setUsageTo,
  usageRange,
  setUsageRange,
  setUsagePage,
  usagePageSize,
  setUsagePageSize,
  usageQueryOpts,
  loadUsage,
  refreshUsage,
  goUsagePage,
}: UsagePanelProps) {
  const [autoRefresh, setAutoRefresh] = useState<number>(() => loadAutoRefresh())

  // 自动刷新：停留在当前页；「近 N 小时」每次按当前时刻重算窗口。
  // 用 ref 拿最新筛选，避免每次输入都重建定时器。
  const tickRef = useRef<() => void>(() => {})
  tickRef.current = () => {
    if (usageLoading || document.hidden) return
    const opts = usageQueryOpts()
    if (usageRange === "1h" || usageRange === "24h") {
      const range = usageRangeFor(usageRange)
      setUsageFrom(range.from)
      setUsageTo(range.to)
      void loadUsage({ ...opts, ...range })
      return
    }
    void loadUsage(opts)
  }
  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => tickRef.current(), autoRefresh * 1000)
    return () => window.clearInterval(timer)
  }, [autoRefresh])

  const runQuery = (patch: Partial<UsageQueryOpts> = {}) => {
    setUsagePage(1)
    void loadUsage({ ...usageQueryOpts(1, usagePageSize), ...patch })
  }

  const applyRange = (preset: UsageRangePreset) => {
    const range = usageRangeFor(preset)
    setUsageRange(preset)
    setUsageFrom(range.from)
    setUsageTo(range.to)
    // 直接传本地串，由 loadUsage 统一转 ISO（勿依赖尚未 commit 的 state）
    runQuery(range)
  }

  const stats = usageStats
  const totalReq = stats?.total_requests ?? 0
  const promptTokens =
    (stats?.total_input_tokens ?? 0) +
    (stats?.total_cache_read_tokens ?? 0) +
    (stats?.total_cache_creation_tokens ?? 0)

  return (
    <div className="space-y-4">
{stats ? (
  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
    {[
      {
        label: "请求数",
        value: String(totalReq),
        hint: `成功率 ${percent(stats.success_count ?? 0, totalReq)} · 失败 ${stats.error_count ?? 0}`,
        hintClass:
          totalReq > 0 && (stats.error_count ?? 0) / totalReq > 0.05
            ? "text-red-600 dark:text-red-400"
            : undefined,
      },
      {
        label: "Tokens",
        value: formatTokens(stats.total_tokens ?? 0),
        // 互斥桶：入/出/读/写（sub2api 同款 K/M 格式）
        hint: `入 ${formatTokens(stats.total_input_tokens ?? 0)} · 出 ${formatTokens(stats.total_output_tokens ?? 0)} · 读 ${formatTokens(stats.total_cache_read_tokens ?? 0)} · 写 ${formatTokens(stats.total_cache_creation_tokens ?? 0)}`,
      },
      {
        label: "缓存命中率",
        value: percent(stats.total_cache_read_tokens ?? 0, promptTokens),
        hint: "缓存读取 / 全部输入",
      },
      {
        label: "费用",
        value: money(stats.total_actual_cost),
        hint: `标准 ${money(stats.total_cost)}${totalReq > 0 ? ` · 均 ${money((stats.total_actual_cost ?? 0) / totalReq)}/次` : ""}`,
      },
      {
        label: "平均耗时",
        // 与表格延迟列一致：&lt;1s 显示 ms，否则 x.xxs（如 16.71s）
        value: formatDurationMS(stats.average_duration_ms ?? 0),
        hint: "",
      },
      {
        label: "RPM / TPM",
        value: `${stats.rpm ?? 0} / ${formatTokens(stats.tpm ?? 0)}`,
        hint: "近 5 分钟均值 · TPM 为入+出",
      },
    ].map((tile) => (
      <div
        key={tile.label}
        className="flex min-h-[4.75rem] min-w-0 flex-col justify-between gap-0.5 rounded-xl border border-border bg-muted/20 px-3 py-2.5"
      >
        <span className="text-[11px] text-muted-foreground">{tile.label}</span>
        <div className="truncate text-xl font-semibold tabular-nums tracking-tight">
          {tile.value}
        </div>
        {tile.hint ? (
          <div
            className={cn(
              "truncate text-[11px] tabular-nums text-muted-foreground",
              tile.hintClass,
            )}
            title={tile.hint}
          >
            {tile.hint}
          </div>
        ) : (
          <div className="h-3.5" />
        )}
      </div>
    ))}
  </div>
) : null}

<Card className="overflow-hidden border-border shadow-none">
  <CardContent className="space-y-3 p-4 sm:p-5">
    {/* 筛选条：维度筛选即选即查；时间用快捷范围 + 自定义 */}
    <div className="space-y-3 rounded-xl border border-border bg-muted/15 p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            网关组
          </Label>
          <Select
            value={usageGroupFilter}
            onValueChange={(v) => {
              // 组变更：密钥联动重置为全部，并立即按新组查询
              setUsageGroupFilter(v)
              setUsageKeyFilter("all")
              runQuery({ groupID: v, keyID: "all" })
            }}
          >
            <SelectTrigger className="h-9 w-full bg-background">
              <SelectValue placeholder="全部网关组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部网关组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            密钥
          </Label>
          <UsageKeyCombobox
            keys={usageKeys}
            groups={groups}
            value={usageKeyFilter}
            onChange={(v) => {
              setUsageKeyFilter(v)
              runQuery({ keyID: v })
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            模型
          </Label>
          <Select
            value={usageModelFilter || "all"}
            onValueChange={(v) => {
              setUsageModelFilter(v)
              runQuery({ model: v })
            }}
          >
            <SelectTrigger className="h-9 w-full bg-background">
              <SelectValue placeholder="全部模型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模型</SelectItem>
              {usageModelOptions.map((m) => (
                <SelectItem key={m.model} value={m.model}>
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs">{m.model}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {m.count}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            结果
          </Label>
          <Select
            value={usageSuccessFilter}
            onValueChange={(v) => {
              setUsageSuccessFilter(v)
              runQuery({ success: v })
            }}
          >
            <SelectTrigger className="h-9 w-full bg-background">
              <SelectValue placeholder="全部结果" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部结果</SelectItem>
              <SelectItem value="success">仅成功</SelectItem>
              <SelectItem value="client">客户端断开</SelectItem>
              <SelectItem value="fail">仅失败</SelectItem>
              <SelectItem value="multi">含重试 / 顺延</SelectItem>
              <SelectItem value="multi_success">
                顺延后成功（如 2/2 · 顺延）
              </SelectItem>
              <SelectItem value="multi_fail">重试/顺延后仍失败</SelectItem>
              {/* 链级口径：每条请求链只出最后一次尝试那一行，条数跟首页调度图上的
                  三个结局一一对应（上面的「仅成功 / 仅失败」是尝试级，对不上） */}
              <SelectItem value="chain_direct">整条链：一次过</SelectItem>
              <SelectItem value="chain_recovered">整条链：顺延后成功</SelectItem>
              <SelectItem value="chain_failed">整条链：最终失败</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            Request ID
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 w-full bg-background pl-8 font-mono text-xs"
              placeholder="部分匹配，回车查询"
              value={usageRequestIDFilter}
              onChange={(e) => setUsageRequestIDFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runQuery()
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border bg-background p-0.5">
            {USAGE_RANGE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={usageLoading}
                className={cn(
                  "h-7 rounded px-2.5 text-xs transition-colors disabled:opacity-50",
                  usageRange === p.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => applyRange(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="datetime-local"
              step={1}
              aria-label="开始时间"
              className={cn(
                "h-8 w-[13.5rem] bg-background font-mono text-xs",
                !usageRange && "border-primary/60",
              )}
              value={usageFrom}
              onChange={(e) => {
                setUsageRange("")
                setUsageFrom(e.target.value)
              }}
            />
            <span className="text-xs text-muted-foreground">至</span>
            <Input
              type="datetime-local"
              step={1}
              aria-label="结束时间"
              className={cn(
                "h-8 w-[13.5rem] bg-background font-mono text-xs",
                !usageRange && "border-primary/60",
              )}
              value={usageTo}
              onChange={(e) => {
                setUsageRange("")
                setUsageTo(e.target.value)
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={String(autoRefresh)}
            onValueChange={(v) => {
              const n = Number(v) || 0
              setAutoRefresh(n)
              try {
                window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(n))
              } catch {
                /* ignore */
              }
            }}
          >
            <SelectTrigger
              className={cn(
                "h-8 w-[7.5rem] text-xs",
                autoRefresh > 0 && "border-emerald-500/60 text-emerald-700 dark:text-emerald-300",
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTO_REFRESH_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n === 0 ? "自动刷新：关" : `每 ${n} 秒刷新`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8"
            disabled={usageLoading}
            onClick={() => {
              const range = usageRangeFor(DEFAULT_USAGE_RANGE)
              setUsageGroupFilter("all")
              setUsageKeyFilter("all")
              setUsageModelFilter("all")
              setUsageRequestIDFilter("")
              setUsageSuccessFilter("all")
              setUsageRange(DEFAULT_USAGE_RANGE)
              setUsageFrom(range.from)
              setUsageTo(range.to)
              setUsagePage(1)
              void loadUsage({
                groupID: "all",
                keyID: "all",
                model: "all",
                requestID: "",
                success: "all",
                ...range,
                page: 1,
                pageSize: usagePageSize,
              })
            }}
          >
            重置
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={usageLoading}
            onClick={() => refreshUsage()}
          >
            <RefreshCw
              className={cn("size-3.5", usageLoading && "animate-spin")}
            />
            刷新
          </Button>
          <Button
            size="sm"
            className="h-8 min-w-[4.5rem]"
            disabled={usageLoading}
            onClick={() => runQuery()}
          >
            {usageLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            查询
          </Button>
        </div>
      </div>
    </div>

    {usageLoading && !usage ? (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载使用记录…
      </div>
    ) : (
      <>
        <div className={cn(usageLoading && "opacity-60 pointer-events-none")}>
          <GatewayUsageTable
            items={usage?.items ?? []}
            onCleaned={() => {
              setUsagePage(1)
              refreshUsage(1)
            }}
          />
        </div>
        {/* 分页：始终展示总数；多页时显示翻页与每页条数 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3 text-sm">
          <div className="text-muted-foreground">
            {usageLoading ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                加载中…
              </span>
            ) : (
              <>
                共{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {usage?.total ?? 0}
                </span>{" "}
                条
                {(usage?.pages ?? 0) > 0 ? (
                  <>
                    {" "}
                    · 第{" "}
                    <span className="font-medium tabular-nums text-foreground">
                      {usage?.page ?? 1}
                    </span>
                    /
                    <span className="tabular-nums">{usage?.pages ?? 1}</span>{" "}
                    页
                  </>
                ) : null}
                {usage?.page_size ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · 本页 {usage.items?.length ?? 0} 条
                  </span>
                ) : null}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">每页</span>
              <Select
                value={String(usagePageSize)}
                onValueChange={(v) => {
                  const size = Number(v) || 50
                  setUsagePageSize(size)
                  setUsagePage(1)
                  void loadUsage(usageQueryOpts(1, size))
                }}
              >
                <SelectTrigger className="h-8 w-[4.5rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="200">200</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={
                usageLoading || !usage || (usage.page ?? 1) <= 1
              }
              onClick={() => goUsagePage(1)}
            >
              首页
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={
                usageLoading || !usage || (usage.page ?? 1) <= 1
              }
              onClick={() => goUsagePage((usage?.page ?? 1) - 1)}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={
                usageLoading ||
                !usage ||
                (usage.page ?? 1) >= (usage.pages || 1)
              }
              onClick={() => goUsagePage((usage?.page ?? 1) + 1)}
            >
              下一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={
                usageLoading ||
                !usage ||
                (usage.page ?? 1) >= (usage.pages || 1) ||
                (usage.pages ?? 0) <= 1
              }
              onClick={() => goUsagePage(usage?.pages ?? 1)}
            >
              末页
            </Button>
          </div>
        </div>
      </>
    )}
  </CardContent>
</Card>

    </div>
  )
}
