import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Info,
  Loader2,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { copyText as copyToClipboard } from "@/lib/clipboard"
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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  fullDateTime,
  formatDurationMS,
  formatTokens,
  relativeTime,
} from "@/lib/format"
import { apiFetch } from "@/lib/api"
import type { GatewayUsageLog } from "@/lib/api-types"
import { cn } from "@/lib/utils"
import { formatSourceGroupDisplay } from "./gateway-utils"

/** datetime-local 字符串（本地）→ ISO RFC3339 */
function localDatetimeToISO(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  let d: Date
  if (m) {
    const [, y, mo, day, h, mi, sec] = m
    d = new Date(
      Number(y),
      Number(mo) - 1,
      Number(day),
      Number(h),
      Number(mi),
      Number(sec ?? 0),
      0,
    )
  } else {
    d = new Date(s)
  }
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function daysAgoLocal(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return toLocalDatetimeValue(d)
}

function UsageCleanupDialog({
  open,
  onOpenChange,
  onCleaned,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCleaned?: () => void
}) {
  const [mode, setMode] = useState<"before" | "all">("before")
  const [beforeLocal, setBeforeLocal] = useState(() => daysAgoLocal(30))
  const [ack, setAck] = useState(false)
  const [matched, setMatched] = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // 打开时重置
  useEffect(() => {
    if (!open) return
    setMode("before")
    setBeforeLocal(daysAgoLocal(30))
    setAck(false)
    setMatched(null)
  }, [open])

  // 条件变化时清空预览数
  useEffect(() => {
    setMatched(null)
  }, [mode, beforeLocal])

  const canSubmit =
    ack && !submitting && (mode === "all" || !!beforeLocal.trim())

  const runPreview = async () => {
    setPreviewing(true)
    try {
      const body =
        mode === "all"
          ? { all: true, dry_run: true }
          : {
              all: false,
              dry_run: true,
              before: localDatetimeToISO(beforeLocal) || beforeLocal,
            }
      if (mode === "before" && !localDatetimeToISO(beforeLocal)) {
        toast.error("请选择有效的截止时间")
        return
      }
      const res = await apiFetch<{ matched: number }>("/gateway/usage/cleanup", {
        method: "POST",
        body: JSON.stringify(body),
      })
      setMatched(res.matched ?? 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "预览失败")
    } finally {
      setPreviewing(false)
    }
  }

  const runCleanup = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const body =
        mode === "all"
          ? { all: true, confirm: true }
          : {
              all: false,
              confirm: true,
              before: localDatetimeToISO(beforeLocal) || beforeLocal,
            }
      if (mode === "before" && !localDatetimeToISO(beforeLocal)) {
        toast.error("请选择有效的截止时间")
        return
      }
      const res = await apiFetch<{ deleted: number }>("/gateway/usage/cleanup", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const n = res.deleted ?? 0
      toast.success(n > 0 ? `已清理 ${n} 条访问日志` : "没有可清理的记录")
      onOpenChange(false)
      onCleaned?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清理失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>清理访问日志</DialogTitle>
          <DialogDescription>
            删除网关使用记录（gateway_usage_logs）。此操作不可恢复，统计与费用明细将一并丢失。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
            <p className="font-medium">清理说明</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-800/90 dark:text-amber-100/80">
              <li>仅删除访问 / 用量日志，不影响网关组、密钥、路由配置</li>
              <li>按时间清理：删除「截止时间之前」的全部记录（不含该时刻之后）</li>
              <li>清理全部：清空所有历史调用记录，无法找回</li>
              <li>建议先点「预览将删除条数」确认范围</li>
            </ul>
          </div>

          <div className="space-y-2">
            <Label>清理范围</Label>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="radio"
                  name="usage-cleanup-mode"
                  className="mt-0.5"
                  checked={mode === "before"}
                  onChange={() => setMode("before")}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">按时间清理</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    删除选定时间之前的日志
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-red-200/80 p-2.5 has-[:checked]:border-red-500 has-[:checked]:bg-red-50/50 dark:border-red-900/40 dark:has-[:checked]:bg-red-950/20">
                <input
                  type="radio"
                  name="usage-cleanup-mode"
                  className="mt-0.5"
                  checked={mode === "all"}
                  onChange={() => setMode("all")}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-red-700 dark:text-red-300">
                    清理全部数据
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    删除所有访问日志，高风险
                  </span>
                </span>
              </label>
            </div>
          </div>

          {mode === "before" ? (
            <div className="space-y-2">
              <Label htmlFor="usage-cleanup-before">截止时间</Label>
              <Input
                id="usage-cleanup-before"
                type="datetime-local"
                value={beforeLocal}
                onChange={(e) => setBeforeLocal(e.target.value)}
              />
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: "7 天前", days: 7 },
                  { label: "30 天前", days: 30 },
                  { label: "90 天前", days: 90 },
                ].map((p) => (
                  <Button
                    key={p.days}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setBeforeLocal(daysAgoLocal(p.days))}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                将删除该时间点<strong className="text-foreground">之前</strong>
                的全部记录。
              </p>
            </div>
          ) : (
            <p className="text-xs text-red-700/90 dark:text-red-300/90">
              将删除全部访问日志。请确认下方复选框后提交。
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8"
              disabled={previewing || (mode === "before" && !beforeLocal.trim())}
              onClick={() => void runPreview()}
            >
              {previewing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              预览将删除条数
            </Button>
            {matched != null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                匹配{" "}
                <span className="font-medium text-foreground">{matched}</span> 条
              </span>
            ) : null}
          </div>

          <label className="flex items-start gap-2 rounded-md border p-2.5">
            <Checkbox
              checked={ack}
              onCheckedChange={(v) => setAck(v === true)}
              className="mt-0.5"
            />
            <span className="text-xs leading-relaxed text-muted-foreground">
              我已了解：清理后数据
              <strong className="text-foreground">不可恢复</strong>
              ，且可能影响历史统计与对账。
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!canSubmit}
            onClick={() => void runCleanup()}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {mode === "all" ? "清理全部" : "确认清理"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 访问日志可切换列（展开箭头列固定显示，不在此列）；列划分沿用 sub2api：一列一个信息 */
type UsageColId =
  | "status"
  | "key"
  | "account"
  | "model"
  | "reasoning"
  | "endpoint"
  | "group"
  | "type"
  | "billing"
  | "token"
  | "cost"
  | "latency"
  | "ip"
  | "time"
  | "userAgent"

// v3：从 v2 的合并列恢复为独立列
const USAGE_COLS_STORAGE_KEY = "gateway-usage-columns-v3"

const USAGE_COLUMNS: {
  id: UsageColId
  label: string
  defaultVisible: boolean
}[] = [
  { id: "status", label: "状态", defaultVisible: true },
  { id: "key", label: "API 密钥", defaultVisible: true },
  { id: "account", label: "账户", defaultVisible: true },
  { id: "model", label: "模型", defaultVisible: true },
  { id: "reasoning", label: "推理强度", defaultVisible: true },
  { id: "endpoint", label: "端点", defaultVisible: true },
  { id: "group", label: "分组", defaultVisible: true },
  { id: "type", label: "类型", defaultVisible: true },
  { id: "billing", label: "计费模式", defaultVisible: true },
  { id: "token", label: "Token", defaultVisible: true },
  { id: "cost", label: "费用", defaultVisible: true },
  { id: "latency", label: "延迟", defaultVisible: true },
  { id: "ip", label: "IP", defaultVisible: true },
  { id: "time", label: "时间", defaultVisible: true },
  { id: "userAgent", label: "User-Agent", defaultVisible: false },
]

type UsageColVisibility = Record<UsageColId, boolean>

function defaultUsageColVisibility(): UsageColVisibility {
  return Object.fromEntries(
    USAGE_COLUMNS.map((c) => [c.id, c.defaultVisible]),
  ) as UsageColVisibility
}

function loadUsageColVisibility(): UsageColVisibility {
  const defaults = defaultUsageColVisibility()
  if (typeof window === "undefined") return defaults
  try {
    const raw = window.localStorage.getItem(USAGE_COLS_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<Record<string, boolean>>
    const next = { ...defaults }
    for (const col of USAGE_COLUMNS) {
      if (typeof parsed[col.id] === "boolean") {
        next[col.id] = parsed[col.id]!
      }
    }
    // 至少保留一列，避免整表空白
    if (!USAGE_COLUMNS.some((c) => next[c.id])) {
      return defaults
    }
    return next
  } catch {
    return defaults
  }
}

function saveUsageColVisibility(v: UsageColVisibility) {
  try {
    window.localStorage.setItem(USAGE_COLS_STORAGE_KEY, JSON.stringify(v))
  } catch {
    /* ignore quota / private mode */
  }
}

/** 单元格文本：不截断、不限宽，由整表横向滚动查看完整内容 */
function CellText({
  text,
  className,
  empty = "—",
}: {
  text?: string | null
  className?: string
  empty?: string
}) {
  const display = (text ?? "").trim() || empty
  return (
    <span className={cn("whitespace-nowrap", className)}>{display}</span>
  )
}



type LatencySeverity = "good" | "warn" | "slow" | "critical"

function firstTokenSeverity(ms: number): LatencySeverity {
  if (ms >= 60_000) return "critical"
  if (ms >= 30_000) return "slow"
  if (ms >= 10_000) return "warn"
  return "good"
}

function durationSeverity(ms: number): LatencySeverity {
  if (ms >= 300_000) return "critical"
  if (ms >= 180_000) return "slow"
  if (ms >= 60_000) return "warn"
  return "good"
}

const LATENCY_TEXT: Record<LatencySeverity, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  slow: "text-orange-600 dark:text-orange-400",
  critical: "text-red-600 dark:text-red-400",
}

function money6(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return "$0.000000"
  return `$${v.toFixed(6)}`
}

function formatReasoningEffort(v?: string | null) {
  if (!v?.trim()) return "—"
  const s = v.trim()
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function billingModeLabel(mode?: string | null) {
  switch (mode) {
    case "image":
      return "图像"
    case "per_request":
      return "按次"
    case "video":
      return "视频"
    default:
      return "按量"
  }
}

function billingModeClass(mode?: string | null) {
  switch (mode) {
    case "image":
      return "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300"
    case "per_request":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
    case "video":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
    default:
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
  }
}

function requestTypeLabel(u: GatewayUsageLog) {
  if (u.stream || u.request_type === 2) return "流式"
  if (u.request_type === 1) return "同步"
  return "同步"
}

function requestTypeClass(u: GatewayUsageLog) {
  if (u.stream || u.request_type === 2) {
    return "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200"
  }
  return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
}

function mappingSteps(u: GatewayUsageLog): string[] {
  if (u.model_mapping_chain?.includes("→")) {
    return u.model_mapping_chain
      .split("→")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (u.upstream_model && u.upstream_model !== u.requested_model) {
    return [u.requested_model, u.upstream_model]
  }
  return [u.requested_model || "—"]
}

function errorTypeLabel(t?: string) {
  switch (t) {
    case "transport":
      return "传输"
    case "http":
      return "HTTP 错误"
    case "config":
      return "配置"
    case "internal":
      return "内部"
    case "client":
      return "客户端断开"
    default:
      return t || "错误"
  }
}

/**
 * error_type=client：客户端主动关连接。
 * 新逻辑 success=true 仍带 client 标记；旧数据可能 success=false。
 * 展示一律为「客户端断开」，不进红字失败。
 */
function isClientDisconnectResult(u: GatewayUsageLog) {
  return u.error_type === "client"
}

function ResultBadge({ u }: { u: GatewayUsageLog }) {
  if (isClientDisconnectResult(u)) {
    return (
      <span
        className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
        title="客户端在流式响应过程中关闭连接；上游可能已正常计费，已同步用量"
      >
        客户端断开
      </span>
    )
  }
  if (u.success) {
    return (
      <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
        成功
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">
      失败
    </span>
  )
}

function ResultText({ u }: { u: GatewayUsageLog }) {
  if (isClientDisconnectResult(u)) {
    return (
      <span
        className="text-amber-700 dark:text-amber-400"
        title="客户端在流式响应过程中关闭连接；上游可能已正常计费，已同步用量"
      >
        客户端断开
      </span>
    )
  }
  if (u.success) {
    return <span className="text-emerald-600 dark:text-emerald-400">成功</span>
  }
  return <span className="text-red-600 dark:text-red-400">失败</span>
}

function hasErrorDetail(u: GatewayUsageLog) {
  return !!(
    u.has_error_payload ||
    u.error_message ||
    u.error_detail ||
    u.upstream_error_body ||
    u.upstream_error_headers ||
    u.upstream_url
  )
}

function tryPrettyJSON(raw: string): string {
  const s = raw.trim()
  if (!s) return raw
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return raw
  }
}

/** 将落库的上游 header JSON（[{name,values}]）格式化为完整 Name: value 文本。 */
function formatUpstreamHeaders(raw?: string): string {
  const s = (raw || "").trim()
  if (!s) return ""
  try {
    const parsed = JSON.parse(s) as unknown
    if (Array.isArray(parsed)) {
      const lines: string[] = []
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue
        const name = String((item as { name?: unknown }).name ?? "").trim()
        const values = (item as { values?: unknown }).values
        if (!name) continue
        if (Array.isArray(values) && values.length > 0) {
          for (const v of values) {
            lines.push(`${name}: ${String(v)}`)
          }
        } else {
          lines.push(`${name}:`)
        }
      }
      if (lines.length > 0) return lines.join("\n")
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lines: string[] = []
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          for (const item of v) lines.push(`${k}: ${String(item)}`)
        } else {
          lines.push(`${k}: ${String(v)}`)
        }
      }
      if (lines.length > 0) return lines.join("\n")
    }
  } catch {
    // fall through
  }
  return tryPrettyJSON(s)
}

async function copyText(label: string, text: string) {
  try {
    await copyToClipboard(text)
    toast.success(`已复制${label}`)
  } catch {
    toast.error("复制失败")
  }
}

function attemptKindLabel(kind?: string) {
  switch (kind) {
    case "retry":
      return "重试"
    case "failover":
      return "顺延"
    case "primary":
      return "首次"
    default:
      return kind || ""
  }
}

/** 仅在有重试/顺延时展示尝试标签，避免单次成功也刷 #1·首次 */
function AttemptBadge({
  u,
  chainTotal,
  chainIndex,
}: {
  u: GatewayUsageLog
  chainTotal?: number
  chainIndex?: number
}) {
  const attempt = u.attempt && u.attempt > 0 ? u.attempt : 1
  const kind = (u.attempt_kind || "").trim()
  const multi = (chainTotal ?? 0) > 1
  const isRetryish = kind === "retry" || kind === "failover" || attempt > 1
  if (!multi && !isRetryish) return null

  const label =
    multi && chainIndex != null
      ? `${chainIndex}/${chainTotal} · ${attemptKindLabel(kind || "primary") || "尝试"}`
      : `#${attempt}${kind ? ` · ${attemptKindLabel(kind)}` : ""}`

  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        kind === "failover"
          ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
          : kind === "retry"
            ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
            : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  )
}

function StatusCell({
  u,
  chainTotal,
  chainIndex,
}: {
  u: GatewayUsageLog
  chainTotal?: number
  chainIndex?: number
}) {
  const reqID = (u.request_id || "").trim()
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1">
        <ResultBadge u={u} />
        <AttemptBadge u={u} chainTotal={chainTotal} chainIndex={chainIndex} />
        {u.status_code > 0 ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {u.status_code}
          </span>
        ) : null}
      </div>
      {reqID ? (
        <button
          type="button"
          className="group/rid flex items-center gap-1 text-left"
          title="点击复制 Request ID"
          onClick={() => void copyText("Request ID", reqID)}
        >
          <span className="shrink-0 text-[10px] text-muted-foreground">ID</span>
          <CellText
            text={reqID}
            className="font-mono text-[10px] text-muted-foreground group-hover/rid:text-foreground"
          />
        </button>
      ) : null}
      {!u.success && u.error_type && u.error_type !== "client" ? (
        <div className="text-[10px] text-muted-foreground">
          {errorTypeLabel(u.error_type)}
        </div>
      ) : null}
      {u.cooldown_until ? (
        <div className="text-[10px] text-amber-700 dark:text-amber-400">
          冷却至 {fullDateTime(u.cooldown_until)}
        </div>
      ) : null}
    </div>
  )
}

function ChainTimeline({
  rows,
  errorOpen,
  onToggleError,
}: {
  rows: GatewayUsageLog[]
  errorOpen: Record<number, boolean>
  onToggleError: (id: number) => void
}) {
  return (
    <div className="space-y-2 rounded-lg border border-violet-200/70 bg-violet-50/40 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
      <div className="min-w-0 text-xs font-medium text-violet-900 dark:text-violet-200">
        同请求链路 · {rows.length} 次尝试
        <span className="ml-2 break-all font-mono text-[10px] font-normal text-muted-foreground">
          {rows[0]?.request_id}
        </span>
      </div>
      <ol className="space-y-2">
        {rows.map((r, i) => {
          const account =
            r.provider_name ||
            r.channel_name ||
            (r.gateway_provider_id
              ? `直连 #${r.gateway_provider_id}`
              : r.channel_id
                ? `#${r.channel_id}`
                : "—")
          const canShowError =
            hasErrorDetail(r) && (!r.success || isClientDisconnectResult(r))
          const errOpen = canShowError && !!errorOpen[r.id]
          return (
            <li
              key={r.id}
              className="min-w-0 rounded-md border bg-background/80 px-2.5 py-2 text-xs"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="w-6 tabular-nums text-muted-foreground">
                  {i + 1}.
                </span>
                <AttemptBadge u={r} chainTotal={rows.length} chainIndex={i + 1} />
                <ResultText u={r} />
                {r.status_code > 0 ? (
                  <span className="tabular-nums text-muted-foreground">{r.status_code}</span>
                ) : null}
                <span className="max-w-[10rem] truncate font-medium" title={account}>
                  {account}
                </span>
                {r.source_api_key_name ? (
                  <span className="max-w-[8rem] truncate text-muted-foreground">
                    {r.source_api_key_name}
                  </span>
                ) : null}
                <span className="tabular-nums text-muted-foreground">
                  {formatDurationMS(r.duration_ms)}
                </span>
                {canShowError ? (
                  <button
                    type="button"
                    className="text-[11px] text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
                    onClick={() => onToggleError(r.id)}
                  >
                    {errOpen
                      ? "收起详情"
                      : isClientDisconnectResult(r)
                        ? "断开详情"
                        : "错误详情"}
                  </button>
                ) : null}
              </div>
              {errOpen ? (
                <div className="mt-2 min-w-0 border-t border-border/60 pt-2">
                  <ErrorDetailPanel u={r} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 列表省略了上游错误 body / header 等大字段，展开时按 id 补拉（带缓存） */
const usageDetailCache = new Map<number, GatewayUsageLog>()

function useUsageDetail(u: GatewayUsageLog): {
  log: GatewayUsageLog
  loading: boolean
} {
  const needFetch =
    !!u.has_error_payload &&
    !u.error_detail &&
    !u.upstream_error_body &&
    !u.upstream_error_headers
  const [full, setFull] = useState<GatewayUsageLog | null>(
    () => usageDetailCache.get(u.id) ?? null,
  )
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!needFetch || usageDetailCache.has(u.id)) return
    let cancelled = false
    setLoading(true)
    apiFetch<GatewayUsageLog>(`/gateway/usage/detail/${u.id}`)
      .then((res) => {
        usageDetailCache.set(u.id, res)
        if (!cancelled) setFull(res)
      })
      .catch((e) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "加载错误详情失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [needFetch, u.id])
  return { log: needFetch && full ? { ...u, ...full } : u, loading }
}

function ErrorDetailPanel({ u: row }: { u: GatewayUsageLog }) {
  const { log: u, loading } = useUsageDetail(row)
  const bodyPretty = u.upstream_error_body ? tryPrettyJSON(u.upstream_error_body) : ""
  const headersPretty = formatUpstreamHeaders(u.upstream_error_headers)
  const fullDebug = [
    `request_id: ${u.request_id || "—"}`,
    `attempt: ${u.attempt ?? 1}`,
    `attempt_kind: ${u.attempt_kind || "—"}`,
    `route_id: ${u.route_id || "—"}`,
    `channel: ${u.channel_name || u.channel_id || "—"}`,
    `status: ${u.status_code || 0}`,
    `type: ${u.error_type || "—"}`,
    `url: ${u.upstream_url || "—"}`,
    `cooldown_until: ${u.cooldown_until || "—"}`,
    "",
    "--- summary ---",
    u.error_message || "(none)",
    "",
    "--- detail ---",
    u.error_detail || "(none)",
    "",
    "--- upstream body ---",
    bodyPretty || "(none)",
    "",
    "--- upstream headers (full) ---",
    headersPretty || "(none)",
  ].join("\n")

  return (
    <div className="space-y-3 rounded-lg border border-red-200/80 bg-red-50/50 p-3 text-xs dark:border-red-900/50 dark:bg-red-950/20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-red-800 dark:text-red-200">
          上游错误详情
          {loading ? <Loader2 className="size-3 animate-spin" /> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() => void copyText("错误详情", fullDebug)}
        >
          <Copy className="size-3" /> 复制全部
        </Button>
      </div>
      {u.error_message ? (
        <div className="whitespace-pre-wrap break-all rounded-md border border-red-200/70 bg-background/80 px-2 py-1.5 text-red-800 dark:border-red-900/50 dark:text-red-200">
          {u.error_message}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Request ID（同请求关联键）
          </div>
          <div className="font-mono break-all">{u.request_id || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            尝试
          </div>
          <div>
            #{u.attempt && u.attempt > 0 ? u.attempt : 1}
            {u.attempt_kind ? ` · ${attemptKindLabel(u.attempt_kind)}` : ""}
            {u.cooldown_until ? ` · 冷却至 ${fullDateTime(u.cooldown_until)}` : ""}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Upstream URL</div>
          <div className="font-mono break-all">{u.upstream_url || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Route / Channel</div>
          <div className="break-all">
            route #{u.route_id}
            {" · "}
            {u.channel_name || `channel #${u.channel_id}`}
            {u.source_api_key_name ? ` · ${u.source_api_key_name}` : ""}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">协议</div>
          <div>
            {u.inbound_protocol || "—"} → {u.upstream_protocol || "—"}
            {u.protocol_converted ? "（已转换）" : ""}
          </div>
        </div>
      </div>
      {u.error_detail ? (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Detail</div>
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void copyText("Detail", u.error_detail || "")}
            >
              复制
            </button>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background/80 p-2 font-mono text-[11px] leading-4">
            {u.error_detail}
          </pre>
        </div>
      ) : null}
      {bodyPretty ? (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Upstream Response Body
            </div>
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void copyText("Body", bodyPretty)}
            >
              复制
            </button>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background/80 p-2 font-mono text-[11px] leading-4">
            {bodyPretty}
          </pre>
        </div>
      ) : null}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Upstream Response Headers（完整）
          </div>
          {headersPretty ? (
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void copyText("Headers", headersPretty)}
            >
              复制
            </button>
          ) : null}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background/80 p-2 font-mono text-[11px] leading-4 [overflow-wrap:anywhere]">
          {headersPretty || "(none)"}
        </pre>
      </div>
    </div>
  )
}

function totalTokens(u: GatewayUsageLog) {
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_creation_tokens || 0) +
    (u.cache_read_tokens || 0)
  )
}

/** 缓存命中率 = 缓存读取 / 全部输入（不含缓存 + 读 + 写） */
function cacheHitRate(u: GatewayUsageLog): number | null {
  const prompt =
    (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_creation_tokens || 0)
  if (prompt <= 0 || !u.cache_read_tokens) return null
  return u.cache_read_tokens / prompt
}

function TokenCell({ u }: { u: GatewayUsageLog }) {
  const reasoning = u.reasoning_tokens ?? 0
  const hit = cacheHitRate(u)
  return (
    <div className="flex items-start gap-1.5">
      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1" title="输入（不含缓存）">
            <ArrowDown className="size-3.5 text-emerald-500" />
            <span className="font-medium tabular-nums">{formatTokens(u.input_tokens)}</span>
          </span>
          <span className="inline-flex items-center gap-1" title={reasoning > 0 ? `输出（含推理 ${formatTokens(reasoning)}）` : "输出"}>
            <ArrowUp className="size-3.5 text-violet-500" />
            <span className="font-medium tabular-nums">{formatTokens(u.output_tokens)}</span>
          </span>
        </div>
        {(u.cache_read_tokens > 0 || u.cache_creation_tokens > 0) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {u.cache_read_tokens > 0 && (
              <span className="font-medium tabular-nums text-sky-600 dark:text-sky-400" title={hit != null ? `缓存命中 ${(hit * 100).toFixed(1)}%` : "缓存读取"}>
                读 {formatTokens(u.cache_read_tokens)}
              </span>
            )}
            {u.cache_creation_tokens > 0 && (
              <span className="font-medium tabular-nums text-amber-600 dark:text-amber-400" title="缓存写入">
                写 {formatTokens(u.cache_creation_tokens)}
                {(u.cache_creation_1h_tokens ?? 0) > 0 && (
                  <span className="ml-1 rounded bg-orange-100 px-1 text-[10px] text-orange-600 ring-1 ring-inset ring-orange-200 dark:bg-orange-500/20 dark:text-orange-400">
                    1h
                  </span>
                )}
              </span>
            )}
          </div>
        )}
        {(u.image_output_tokens ?? 0) > 0 && (
          <div className="font-medium text-pink-600 dark:text-pink-400 tabular-nums">
            图 {formatTokens(u.image_output_tokens)}
          </div>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-blue-100 hover:text-blue-600 dark:hover:bg-blue-900/50"
          >
            <Info className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs space-y-1 p-3 text-xs">
          <div className="mb-1 font-semibold">Token 明细</div>
          <div className="flex justify-between gap-6">
            <span className="text-muted-foreground">输入（不含缓存）</span>
            <span>{formatTokens(u.input_tokens)}</span>
          </div>
          {u.cache_read_tokens > 0 && (
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">缓存读取</span>
              <span>
                {formatTokens(u.cache_read_tokens)}
                {hit != null ? ` · 命中 ${(hit * 100).toFixed(1)}%` : ""}
              </span>
            </div>
          )}
          {u.cache_creation_tokens > 0 && (
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">缓存创建</span>
              <span>{formatTokens(u.cache_creation_tokens)}</span>
            </div>
          )}
          {((u.cache_creation_5m_tokens ?? 0) > 0 || (u.cache_creation_1h_tokens ?? 0) > 0) && (
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">其中 5m / 1h</span>
              <span>
                {formatTokens(u.cache_creation_5m_tokens)} / {formatTokens(u.cache_creation_1h_tokens)}
              </span>
            </div>
          )}
          {(u.image_output_tokens ?? 0) > 0 && (
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">图像输出</span>
              <span>{formatTokens(u.image_output_tokens)}</span>
            </div>
          )}
          <div className="flex justify-between gap-6">
            <span className="text-muted-foreground">输出</span>
            <span>{formatTokens(u.output_tokens)}</span>
          </div>
          {reasoning > 0 && (
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">其中推理</span>
              <span>{formatTokens(reasoning)}</span>
            </div>
          )}
          <div className="flex justify-between gap-6 border-t pt-1 font-semibold">
            <span className="text-muted-foreground">合计</span>
            <span className="text-blue-500">{formatTokens(totalTokens(u))}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function CostCell({ u }: { u: GatewayUsageLog }) {
  const standard = u.total_cost || 0
  const actual = u.actual_cost || 0
  return (
    <div className="text-sm">
      <div className="flex items-center gap-1.5">
        <span
          className="font-medium tabular-nums text-green-600 dark:text-green-400"
          title="实收 = 标准费用 × 账号计费倍率"
        >
          {money6(actual)}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-blue-100 hover:text-blue-600"
            >
              <Info className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs space-y-1 p-3 text-xs">
            <div className="mb-1 font-semibold">费用明细</div>
            {u.input_cost > 0 && (
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">输入</span>
                <span>{money6(u.input_cost)}</span>
              </div>
            )}
            {u.output_cost > 0 && (
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">输出</span>
                <span>{money6(u.output_cost)}</span>
              </div>
            )}
            {u.cache_creation_cost > 0 && (
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">缓存创建</span>
                <span>{money6(u.cache_creation_cost)}</span>
              </div>
            )}
            {u.cache_read_cost > 0 && (
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">缓存读取</span>
                <span>{money6(u.cache_read_cost)}</span>
              </div>
            )}
            {(u.image_output_cost ?? 0) > 0 && (
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">图像</span>
                <span>{money6(u.image_output_cost)}</span>
              </div>
            )}
            {u.account_rate_multiplier != null && u.account_rate_multiplier !== 1 && (
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">账号倍率</span>
                <span className="text-blue-400">{u.account_rate_multiplier.toFixed(4)}x</span>
              </div>
            )}
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">倍率</span>
              <span className="text-blue-400">{(u.rate_multiplier || 1).toFixed(4)}x</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">计费倍率</span>
              <span className="text-blue-400">
                {(u.billing_rate_multiplier || 1).toFixed(4)}x
              </span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">标准费用</span>
              <span>{money6(standard)}</span>
            </div>
            <div className="flex justify-between gap-6 font-semibold">
              <span className="text-muted-foreground">实收</span>
              <span className="text-green-400">{money6(actual)}</span>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
      {/* 副行：标准费用（未乘倍率）+ 实际折扣倍率，一眼看出这单打了几折 */}
      <div
        className="mt-0.5 text-[11px] tabular-nums text-muted-foreground"
        title="标准费用 = tokens × 模型单价（未乘倍率）；倍率 = 实收 / 标准"
      >
        标准 {money6(standard)}
        {standard > 0 && Math.abs(actual / standard - 1) > 0.0005 ? (
          <span className="ml-1 text-orange-600 dark:text-orange-400">
            {(actual / standard).toFixed(2)}x
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 输出速度：输出 tokens / 生成耗时（流式扣掉首字前的等待） */
function outputSpeed(u: GatewayUsageLog): number | null {
  const out = u.output_tokens || 0
  if (out <= 0 || !u.duration_ms) return null
  const genMS = u.duration_ms - (u.first_token_ms ?? 0)
  if (genMS < 50) return null
  return out / (genMS / 1000)
}

function LatencyCell({ u }: { u: GatewayUsageLog }) {
  const dSev = durationSeverity(u.duration_ms ?? 0)
  const hasFT = u.first_token_ms != null
  const fSev = hasFT ? firstTokenSeverity(u.first_token_ms!) : dSev
  const speed = outputSpeed(u)
  return (
    <div>
      <div className="grid grid-cols-[max-content_max-content] items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">首字</span>
        {hasFT ? (
          <span className={cn("font-medium tabular-nums", LATENCY_TEXT[fSev])}>
            {formatDurationMS(u.first_token_ms)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        <span className="text-muted-foreground">总耗时</span>
        <span className={cn("font-medium tabular-nums", LATENCY_TEXT[dSev])}>
          {formatDurationMS(u.duration_ms)}
        </span>
        {speed != null ? (
          <>
            <span className="text-muted-foreground">速度</span>
            <span className="tabular-nums text-muted-foreground">
              {speed >= 100 ? speed.toFixed(0) : speed.toFixed(1)} tok/s
            </span>
          </>
        ) : null}
      </div>
    </div>
  )
}

function accountLabel(u: GatewayUsageLog) {
  return (
    u.provider_name ||
    u.channel_name ||
    (u.gateway_provider_id
      ? `直连 #${u.gateway_provider_id}`
      : u.channel_id
        ? `#${u.channel_id}`
        : "—")
  )
}

function multiplierText(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return "—"
  return `${Number(v.toFixed(4))}x`
}

function ModelCell({ u }: { u: GatewayUsageLog }) {
  const steps = mappingSteps(u)
  if (steps.length <= 1) return <CellText text={steps[0]} className="font-medium" />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default space-y-0.5">
          <CellText text={steps[0]} className="font-medium" />
          <div className="whitespace-nowrap text-[11px] text-muted-foreground">↳ {steps[steps.length - 1]}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        映射：{steps.join(" → ")}
      </TooltipContent>
    </Tooltip>
  )
}

function AccountCell({ u }: { u: GatewayUsageLog }) {
  // 两行：渠道 / 直连名 + 源密钥名（或「直连」）
  const isDirect = !!(u.provider_name || u.gateway_provider_id)
  const secondary = (u.source_api_key_name || "").trim() || (isDirect ? "直连" : "")
  return (
    <div className="flex flex-col gap-0.5 leading-tight">
      <span className="whitespace-nowrap font-medium">{accountLabel(u)}</span>
      {secondary ? <span className="whitespace-nowrap text-[11px] text-muted-foreground">{secondary}</span> : null}
    </div>
  )
}

function EndpointCell({ u }: { u: GatewayUsageLog }) {
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex items-baseline gap-1 whitespace-nowrap">
        <span className="text-muted-foreground">入站:</span>
        <span>{u.inbound_endpoint?.trim() || "—"}</span>
      </div>
      <div className="flex items-baseline gap-1 whitespace-nowrap">
        <span className="text-muted-foreground">上游:</span>
        <span>{u.upstream_endpoint?.trim() || "—"}</span>
      </div>
      {u.protocol_converted ? (
        <span
          className="inline-flex rounded bg-violet-100 px-1.5 py-px text-[10px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
          title={`${u.inbound_protocol || "?"} → ${u.upstream_protocol || "?"}`}
        >
          协议转换
        </span>
      ) : null}
    </div>
  )
}

function GroupCell({ u }: { u: GatewayUsageLog }) {
  const groupName = (u.gateway_group_name || "").trim()
  if (!groupName) return <span className="text-muted-foreground">—</span>
  const sg = formatSourceGroupDisplay(u.source_group_name)
  const sourceTip = sg.tip ? sg.tip : sg.label ? `源 ${sg.label}` : undefined
  const tag = (
    <span className="inline-flex whitespace-nowrap rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200">
      {groupName}
    </span>
  )
  if (!sourceTip) return tag
  return (
    <Tooltip>
      <TooltipTrigger asChild>{tag}</TooltipTrigger>
      <TooltipContent side="top" className="space-y-0.5 text-xs">
        <div className="font-medium">{groupName}</div>
        <div className="text-muted-foreground">{sourceTip}</div>
      </TooltipContent>
    </Tooltip>
  )
}

/* ───────────── 详情抽屉：点击行打开，全部字段 + 原始数据，保证不丢信息 ───────────── */

function DetailItem({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("text-sm tabular-nums [overflow-wrap:anywhere]", mono && "font-mono text-xs")}>{children}</div>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-md border bg-muted/30 p-3 sm:grid-cols-3">{children}</div>
    </section>
  )
}

function UsageDetailSheet({
  u,
  chain,
  onOpenChange,
}: {
  u: GatewayUsageLog | null
  chain?: GatewayUsageLog[]
  onOpenChange: (open: boolean) => void
}) {
  const [errorOpen, setErrorOpen] = useState<Record<number, boolean>>({})
  const [rawOpen, setRawOpen] = useState(false)
  if (!u) return null
  const hit = cacheHitRate(u)
  const speed = outputSpeed(u)
  const showError = hasErrorDetail(u) && (!u.success || isClientDisconnectResult(u))
  const standard = u.total_cost || 0
  const actual = u.actual_cost || 0
  const gen = u.first_token_ms != null ? Math.max(0, (u.duration_ms || 0) - u.first_token_ms) : null
  const raw = JSON.stringify(u, null, 2)
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base">{u.requested_model || "—"}</span>
            <ResultBadge u={u} />
            {u.status_code > 0 ? (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">HTTP {u.status_code}</span>
            ) : null}
            <AttemptBadge u={u} chainTotal={chain && chain.length > 1 ? chain.length : undefined} chainIndex={chain && chain.length > 1 ? chain.findIndex((r) => r.id === u.id) + 1 : undefined} />
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {fullDateTime(u.created_at)} · {relativeTime(u.created_at)}
            </span>
            {u.request_id ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 font-mono text-xs hover:text-foreground"
                onClick={() => void copyText("Request ID", u.request_id)}
                title="复制 Request ID"
              >
                {u.request_id}
                <Copy className="size-3" />
              </button>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 p-4">
          {showError ? <ErrorDetailPanel u={u} /> : null}

          <DetailSection title="请求">
            <DetailItem label="请求模型" mono>{u.requested_model || "—"}</DetailItem>
            <DetailItem label="上游模型" mono>{u.upstream_model || u.requested_model || "—"}</DetailItem>
            <DetailItem label="映射链" mono>{u.model_mapping_chain || "—"}</DetailItem>
            <DetailItem label="推理强度">{formatReasoningEffort(u.reasoning_effort)}</DetailItem>
            <DetailItem label="类型">{requestTypeLabel(u)}</DetailItem>
            <DetailItem label="计费模式">{billingModeLabel(u.billing_mode)}</DetailItem>
            <DetailItem label="服务档位">{u.service_tier || "—"}</DetailItem>
            <DetailItem label="入站端点" mono>{u.inbound_endpoint || "—"}</DetailItem>
            <DetailItem label="上游端点" mono>{u.upstream_endpoint || "—"}</DetailItem>
            <DetailItem label="协议">
              {u.inbound_protocol || "—"} → {u.upstream_protocol || "—"}
              {u.protocol_converted ? "（已转换）" : ""}
            </DetailItem>
            <DetailItem label="上游 URL" mono>{u.upstream_url || "—"}</DetailItem>
          </DetailSection>

          <DetailSection title="路由">
            <DetailItem label="API 密钥">
              {u.gateway_key_name || "—"} <span className="text-muted-foreground">#{u.gateway_key_id}</span>
            </DetailItem>
            <DetailItem label="网关组">
              {u.gateway_group_name || "—"} <span className="text-muted-foreground">#{u.gateway_group_id}</span>
            </DetailItem>
            <DetailItem label="上游账户">{accountLabel(u)}</DetailItem>
            <DetailItem label="上游密钥">{u.source_api_key_name || "—"}</DetailItem>
            <DetailItem label="源分组">{formatSourceGroupDisplay(u.source_group_name).label || "—"}</DetailItem>
            <DetailItem label="路由 / 渠道 / 直连">
              #{u.route_id || 0} / #{u.channel_id || 0} / #{u.gateway_provider_id || 0}
            </DetailItem>
            {u.cooldown_until ? <DetailItem label="路由冷却至">{fullDateTime(u.cooldown_until)}</DetailItem> : null}
          </DetailSection>

          <DetailSection title="Token">
            <DetailItem label="合计">{totalTokens(u).toLocaleString("en-US")}</DetailItem>
            <DetailItem label="输入（不含缓存）">{(u.input_tokens || 0).toLocaleString("en-US")}</DetailItem>
            <DetailItem label="输出">
              {(u.output_tokens || 0).toLocaleString("en-US")}
              {(u.reasoning_tokens ?? 0) > 0 ? `（推理 ${u.reasoning_tokens!.toLocaleString("en-US")}）` : ""}
            </DetailItem>
            <DetailItem label="缓存读取">
              {(u.cache_read_tokens || 0).toLocaleString("en-US")}
              {hit != null ? `（命中 ${(hit * 100).toFixed(1)}%）` : ""}
            </DetailItem>
            <DetailItem label="缓存写入">{(u.cache_creation_tokens || 0).toLocaleString("en-US")}</DetailItem>
            <DetailItem label="缓存写 5m / 1h">
              {(u.cache_creation_5m_tokens ?? 0).toLocaleString("en-US")} / {(u.cache_creation_1h_tokens ?? 0).toLocaleString("en-US")}
            </DetailItem>
            <DetailItem label="图像输出">{(u.image_output_tokens ?? 0).toLocaleString("en-US")}</DetailItem>
          </DetailSection>

          <DetailSection title="费用">
            <DetailItem label="实收">
              <span className="font-medium text-green-600 dark:text-green-400">{money6(actual)}</span>
            </DetailItem>
            <DetailItem label="标准费用">{money6(standard)}</DetailItem>
            <DetailItem label="实际倍率">{standard > 0 ? multiplierText(actual / standard) : "—"}</DetailItem>
            <DetailItem label="计费倍率">{multiplierText(u.billing_rate_multiplier || 1)}</DetailItem>
            <DetailItem label="倍率">{multiplierText(u.rate_multiplier || 1)}</DetailItem>
            <DetailItem label="账号倍率">{multiplierText(u.account_rate_multiplier ?? 1)}</DetailItem>
            <DetailItem label="输入">{money6(u.input_cost)}</DetailItem>
            <DetailItem label="输出">{money6(u.output_cost)}</DetailItem>
            <DetailItem label="缓存读取">{money6(u.cache_read_cost)}</DetailItem>
            <DetailItem label="缓存写入">{money6(u.cache_creation_cost)}</DetailItem>
            <DetailItem label="图像">{money6(u.image_output_cost ?? 0)}</DetailItem>
            <DetailItem label="账号统计">{money6(u.account_stats_cost ?? 0)}</DetailItem>
          </DetailSection>

          <DetailSection title="性能与客户端">
            <DetailItem label="首字">{formatDurationMS(u.first_token_ms)}</DetailItem>
            <DetailItem label="生成">{gen != null ? formatDurationMS(gen) : "—"}</DetailItem>
            <DetailItem label="总耗时">{formatDurationMS(u.duration_ms)}</DetailItem>
            <DetailItem label="输出速度">{speed != null ? `${speed.toFixed(1)} tok/s` : "—"}</DetailItem>
            <DetailItem label="IP" mono>{u.ip_address || "—"}</DetailItem>
            <div className="col-span-2 sm:col-span-3">
              <DetailItem label="User-Agent" mono>{u.user_agent || "—"}</DetailItem>
            </div>
          </DetailSection>

          {chain && chain.length > 1 ? (
            <ChainTimeline
              rows={chain}
              errorOpen={errorOpen}
              onToggleError={(id) => setErrorOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
            />
          ) : null}

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setRawOpen((v) => !v)}
              >
                {rawOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                原始数据（JSON）
              </button>
              <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => void copyText("原始数据", raw)}>
                <Copy className="size-3" /> 复制
              </Button>
            </div>
            {rawOpen ? (
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-4">{raw}</pre>
            ) : null}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function GatewayUsageTable({
  items,
  emptyText = "暂无使用记录",
  onCleaned,
}: {
  items: GatewayUsageLog[]
  emptyText?: string
  /** 清理成功后回调（刷新列表 / 统计） */
  onCleaned?: () => void
}) {
  const [errorOpen, setErrorOpen] = useState<Record<number, boolean>>({})
  const [chainOpen, setChainOpen] = useState<Record<string, boolean>>({})
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [detailRow, setDetailRow] = useState<GatewayUsageLog | null>(null)
  const [colVisible, setColVisible] = useState<UsageColVisibility>(() => loadUsageColVisibility())

  const show = useCallback((id: UsageColId) => colVisible[id] !== false, [colVisible])

  const visibleCount = useMemo(() => USAGE_COLUMNS.filter((c) => colVisible[c.id]).length, [colVisible])
  // 展开箭头列 + 可见数据列
  const colSpan = 1 + visibleCount

  const toggleCol = useCallback((id: UsageColId, next: boolean) => {
    setColVisible((prev) => {
      if (!next) {
        const others = USAGE_COLUMNS.filter((c) => c.id !== id && prev[c.id])
        if (others.length === 0) {
          toast.message("至少保留一列")
          return prev
        }
      }
      const updated = { ...prev, [id]: next }
      saveUsageColVisibility(updated)
      return updated
    })
  }, [])

  const resetCols = useCallback(() => {
    const defaults = defaultUsageColVisibility()
    saveUsageColVisibility(defaults)
    setColVisible(defaults)
  }, [])

  // request_id → 本页内全部尝试（按 attempt / id 排序）
  const chainByReq = (() => {
    const m = new Map<string, GatewayUsageLog[]>()
    for (const u of items) {
      const rid = (u.request_id || "").trim()
      if (!rid) continue
      const list = m.get(rid) ?? []
      list.push(u)
      m.set(rid, list)
    }
    for (const [k, list] of m) {
      list.sort((a, b) => (a.attempt || 1) - (b.attempt || 1) || a.id - b.id)
      m.set(k, list)
    }
    return m
  })()

  // 主行列表：保持接口返回顺序，但同 request_id 只出一行（最终结果）
  // 避免「折叠时只显示成功、展开又插一堆完整行」把表格打乱
  const mainRows: GatewayUsageLog[] = []
  const seenReq = new Set<string>()
  for (const u of items) {
    const rid = (u.request_id || "").trim()
    if (rid && chainByReq.has(rid)) {
      if (seenReq.has(rid)) continue
      seenReq.add(rid)
      const chain = chainByReq.get(rid)!
      // 主行 = 最终成功，否则最后一次尝试
      const final = [...chain].reverse().find((r) => r.success) || chain[chain.length - 1]
      mainRows.push(final)
    } else {
      mainRows.push(u)
    }
  }

  const head = (id: UsageColId, label: string) =>
    show(id) ? (
      <TableHead key={id} className="whitespace-nowrap text-xs font-medium text-muted-foreground">
        {label}
      </TableHead>
    ) : null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            悬停 Token / 费用 / 延迟查看明细，点击行查看全部字段
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-muted-foreground hover:text-destructive"
              onClick={() => setCleanupOpen(true)}
            >
              <Trash2 className="size-3.5" />
              清理
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5">
                  <Columns3 className="size-3.5" />
                  列显示
                  <span className="tabular-nums text-muted-foreground">
                    {visibleCount}/{USAGE_COLUMNS.length}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>选择展示列</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {USAGE_COLUMNS.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={colVisible[col.id]}
                    onCheckedChange={(checked) => toggleCol(col.id, checked === true)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={resetCols}>恢复默认</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <UsageCleanupDialog open={cleanupOpen} onOpenChange={setCleanupOpen} onCleaned={onCleaned} />

        <UsageDetailSheet
          u={detailRow}
          chain={detailRow?.request_id ? chainByReq.get(detailRow.request_id.trim()) : undefined}
          onOpenChange={(open) => {
            if (!open) setDetailRow(null)
          }}
        />

        {/* 表格自身滚动（横向 + 纵向），表头吸顶；内层 table 容器不再单独滚动 */}
        <div className="max-h-[calc(100vh-12rem)] overflow-auto rounded-lg border bg-card [&>[data-slot=table-container]]:overflow-visible">
          <Table className="w-max min-w-full">
            <TableHeader className="sticky top-0 z-10 bg-muted/60 backdrop-blur supports-[backdrop-filter]:bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 whitespace-nowrap" />
                {head("status", "状态")}
                {head("key", "API 密钥")}
                {head("account", "账户")}
                {head("model", "模型")}
                {head("reasoning", "推理强度")}
                {head("endpoint", "端点")}
                {head("group", "分组")}
                {head("type", "类型")}
                {head("billing", "计费模式")}
                {head("token", "Token")}
                {head("cost", "费用")}
                {head("latency", "延迟")}
                {head("ip", "IP")}
                {head("time", "时间")}
                {head("userAgent", "User-Agent")}
              </TableRow>
            </TableHeader>
            <TableBody>
              {mainRows.map((u) => {
                const rid = (u.request_id || "").trim()
                const chain = rid ? chainByReq.get(rid) : undefined
                const chainTotal = chain?.length ?? 1
                const chainIndex = chain && chainTotal > 1 ? chain.findIndex((r) => r.id === u.id) + 1 : undefined
                const hasChain = chainTotal > 1
                const chainExpanded = hasChain && !!chainOpen[rid]
                const canError = hasErrorDetail(u) && (!u.success || isClientDisconnectResult(u))
                const errExpanded = !!errorOpen[u.id]
                // 单箭头：有链路优先展开链路；无链路且有错误则展开错误
                const showToggle = hasChain || canError
                const rowOpen = hasChain ? chainExpanded : errExpanded

                return (
                  <Fragment key={u.id}>
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        !u.success && !isClientDisconnectResult(u) && "bg-red-50/50 hover:bg-red-50 dark:bg-red-950/15 dark:hover:bg-red-950/25",
                        isClientDisconnectResult(u) && "bg-amber-50/50 hover:bg-amber-50 dark:bg-amber-950/15 dark:hover:bg-amber-950/25",
                      )}
                      onClick={(e) => {
                        // 行内按钮 / 链接 / 选中文本时不打开详情
                        const target = e.target as HTMLElement
                        if (target.closest("button,a,input")) return
                        if (window.getSelection()?.toString()) return
                        setDetailRow(u)
                      }}
                    >
                      <TableCell className="w-10 px-1">
                        {showToggle ? (
                          <button
                            type="button"
                            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            title={
                              hasChain
                                ? rowOpen
                                  ? "收起请求链路"
                                  : `展开请求链路（${chainTotal} 次）`
                                : rowOpen
                                  ? "收起错误详情"
                                  : "展开错误详情"
                            }
                            onClick={() => {
                              if (hasChain) {
                                setChainOpen((prev) => ({ ...prev, [rid]: !prev[rid] }))
                              } else {
                                setErrorOpen((prev) => ({ ...prev, [u.id]: !prev[u.id] }))
                              }
                            }}
                          >
                            {rowOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        ) : (
                          <span className="inline-block size-7" />
                        )}
                      </TableCell>

                      {show("status") && (
                        <TableCell>
                          <StatusCell
                            u={u}
                            chainTotal={hasChain ? chainTotal : undefined}
                            chainIndex={hasChain ? chainIndex || chainTotal : undefined}
                          />
                          {hasChain && !chainExpanded ? (
                            <button
                              type="button"
                              className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                              onClick={() => setChainOpen((prev) => ({ ...prev, [rid]: true }))}
                            >
                              查看全部 {chainTotal} 次尝试
                            </button>
                          ) : null}
                          {!u.success && !isClientDisconnectResult(u) && u.error_message ? (
                            <div className="mt-0.5 max-w-[14rem] truncate text-[11px] text-red-700 dark:text-red-300" title={u.error_message}>
                              {u.error_message}
                            </div>
                          ) : null}
                        </TableCell>
                      )}

                      {show("key") && (
                        <TableCell className="text-sm">
                          <CellText text={u.gateway_key_name || (u.gateway_key_id ? `#${u.gateway_key_id}` : "—")} className="font-medium" />
                        </TableCell>
                      )}

                      {show("account") && (
                        <TableCell className="text-sm">
                          <AccountCell u={u} />
                        </TableCell>
                      )}

                      {show("model") && (
                        <TableCell className="text-xs">
                          <ModelCell u={u} />
                        </TableCell>
                      )}

                      {show("reasoning") && (
                        <TableCell className="text-sm">
                          <CellText text={formatReasoningEffort(u.reasoning_effort)} />
                        </TableCell>
                      )}

                      {show("endpoint") && (
                        <TableCell>
                          <EndpointCell u={u} />
                        </TableCell>
                      )}

                      {show("group") && (
                        <TableCell className="text-xs">
                          <GroupCell u={u} />
                        </TableCell>
                      )}

                      {show("type") && (
                        <TableCell>
                          <span className={cn("inline-flex items-center rounded px-2 py-0.5 text-xs font-medium", requestTypeClass(u))}>
                            {requestTypeLabel(u)}
                          </span>
                        </TableCell>
                      )}

                      {show("billing") && (
                        <TableCell>
                          <span className={cn("inline-flex items-center rounded px-2 py-0.5 text-xs font-medium", billingModeClass(u.billing_mode))}>
                            {billingModeLabel(u.billing_mode)}
                          </span>
                        </TableCell>
                      )}

                      {show("token") && (
                        <TableCell>
                          <TokenCell u={u} />
                        </TableCell>
                      )}

                      {show("cost") && (
                        <TableCell>
                          <CostCell u={u} />
                        </TableCell>
                      )}

                      {show("latency") && (
                        <TableCell>
                          <LatencyCell u={u} />
                        </TableCell>
                      )}

                      {show("ip") && (
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          <CellText text={u.ip_address || "—"} />
                        </TableCell>
                      )}

                      {show("time") && (
                        <TableCell className="text-sm text-muted-foreground">
                          <span className="whitespace-nowrap tabular-nums" title={relativeTime(u.created_at)}>
                            {fullDateTime(u.created_at)}
                          </span>
                        </TableCell>
                      )}

                      {show("userAgent") && (
                        <TableCell className="text-xs text-muted-foreground">
                          <span className="block max-w-[16rem] truncate" title={u.user_agent || undefined}>
                            {u.user_agent?.trim() || "—"}
                          </span>
                        </TableCell>
                      )}
                    </TableRow>
                    {hasChain && chainExpanded ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={colSpan} className="bg-muted/20 p-3">
                          <ChainTimeline
                            rows={chain!}
                            errorOpen={errorOpen}
                            onToggleError={(id) => setErrorOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {!hasChain && canError && errExpanded ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={colSpan} className="bg-muted/20 p-3">
                          <ErrorDetailPanel u={u} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                )
              })}
              {mainRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </TooltipProvider>
  )
}
