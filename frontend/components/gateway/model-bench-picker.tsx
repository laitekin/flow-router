import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronsUpDown, Loader2, RefreshCw, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { GatewayModelRoutePull } from "@/lib/api-types"
import { filterBenchModels, type BenchModel } from "./model-bench-catalog"

/** Rendering thousands of rows in a popover is slow; the search narrows the rest. */
const MAX_ROWS = 300

export function ModelBenchPicker({
  models,
  value,
  onChange,
  loading,
  error,
  failedRoutes,
  onRefresh,
}: {
  models: BenchModel[]
  value: string | null
  onChange: (id: string) => void
  loading: boolean
  error?: string
  failedRoutes: GatewayModelRoutePull[]
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => filterBenchModels(models, query), [models, query])
  const shown = filtered.slice(0, MAX_ROWS)
  const current = models.find((m) => m.item.id === value)
  const unsyncedCount = models.filter((m) => !m.saved).length

  useEffect(() => setActive(0), [query, open])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  function pick(id: string) {
    onChange(id)
    setOpen(false)
    setQuery("")
  }

  return (
    <div className="min-w-0 shrink-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label="选择要测试的模型"
              className="h-9 w-full min-w-0 justify-between gap-2 font-normal sm:w-[26rem]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={cn("truncate font-mono text-xs", !value && "font-sans text-muted-foreground")}>
                  {value ?? "选择模型…"}
                </span>
                {current && !current.saved ? (
                  <Badge variant="outline" className="shrink-0 border-amber-500/50 px-1.5 py-0 text-[10px] font-normal text-amber-700 dark:text-amber-400">
                    未同步
                  </Badge>
                ) : null}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] p-0">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)) }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
                  else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active].item.id) }
                }}
                placeholder="按模型 ID 搜索，空格分隔多个关键词"
                aria-label="搜索模型"
                aria-controls="model-bench-list"
                className="h-10 border-0 px-0 text-xs shadow-none focus-visible:ring-0"
              />
              {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="加载中" /> : null}
            </div>
            <ul id="model-bench-list" ref={listRef} role="listbox" aria-label="模型" className="max-h-72 overflow-y-auto p-1">
              {shown.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {loading && !models.length ? "正在读取各路由上报的模型…" : "没有匹配的模型"}
                </li>
              ) : shown.map((m, i) => (
                <li key={m.item.id} role="option" aria-selected={m.item.id === value} data-index={i}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(m.item.id)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                      i === active && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Check className={cn("size-3.5 shrink-0", m.item.id === value ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1 truncate font-mono" title={m.item.id}>{m.item.id}</span>
                    {m.saved ? null : (
                      <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-400">未同步</span>
                    )}
                    {m.reportedBy.length ? (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title="上报该模型的路由数">
                        {m.reportedBy.length} 路由
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {filtered.length > shown.length ? (
                <li className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                  还有 {filtered.length - shown.length} 个，继续输入以缩小范围
                </li>
              ) : null}
            </ul>
          </PopoverContent>
        </Popover>

        <span className="text-[11px] text-muted-foreground">
          {models.length} 个模型{unsyncedCount ? ` · ${unsyncedCount} 个未同步` : ""}
        </span>
        <Button size="sm" variant="ghost" className="h-8 px-2 text-[11px]" disabled={loading} onClick={onRefresh} title="重新读取各路由的 /v1/models">
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} 刷新路由模型
        </Button>
      </div>

      {current && !current.saved ? (
        <p className="text-[11px] text-muted-foreground">
          该模型尚未同步到分组，只在上报它的路由上测试；测试不会写入分组配置。
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" /> 读取路由模型失败：{error}（仍可测试已保存的模型）
        </p>
      ) : failedRoutes.length ? (
        <details className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px]">
          <summary className="cursor-pointer select-none text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mr-1 inline size-3 align-[-2px]" />
            {failedRoutes.length} 条路由未能拉取模型，其他路由的模型仍可选
          </summary>
          <ul className="mt-1.5 space-y-1 text-muted-foreground">
            {failedRoutes.map((r) => (
              <li key={r.route_id} className="break-all">
                <span className="font-medium text-foreground">{r.label || `route#${r.route_id}`}</span>
                {" · "}
                {r.error || r.skip_reason || "未知原因"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
