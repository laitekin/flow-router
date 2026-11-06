"use client"

import { BellOff, ExternalLink, Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { apiFetch } from "@/lib/api"
import type { BalanceAlertLevel, BalanceAlertStatus } from "@/lib/api-types"
import { cn } from "@/lib/utils"

export const LEVEL_META: Record<BalanceAlertLevel, { label: string; cls: string }> = {
  ok: { label: "正常", cls: "text-success bg-success/10 ring-success/20" },
  warn: { label: "预警", cls: "text-warning bg-warning/10 ring-warning/30" },
  critical: { label: "紧急", cls: "text-danger bg-danger/10 ring-danger/30" },
  exhausted: { label: "已耗尽", cls: "text-danger bg-danger/15 ring-danger/40" },
}

export function balanceAlertKey(kind: BalanceAlertStatus["subject_kind"], id: number) {
  return `${kind}:${id}`
}

export function indexBalanceAlerts(items: BalanceAlertStatus[] | undefined) {
  const out: Record<string, BalanceAlertStatus> = {}
  for (const s of items ?? []) out[balanceAlertKey(s.subject_kind, s.subject_id)] = s
  return out
}

export function formatRunway(hours?: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "—"
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`
  if (hours < 48) return `${hours.toFixed(1)} 小时`
  return `${(hours / 24).toFixed(1)} 天`
}

function isSnoozed(s?: BalanceAlertStatus) {
  return !!s?.snooze_until && new Date(s.snooze_until).getTime() > Date.now()
}

export function runwayTooltip(s: BalanceAlertStatus): string {
  const lines: string[] = []
  if (s.burn_per_hour != null && s.burn_per_hour > 0) {
    lines.push(`消耗约 $${s.burn_per_hour.toFixed(2)}/小时（$${(s.burn_per_hour * 24).toFixed(2)}/天）`)
  } else {
    lines.push("近期没有可估算的消耗")
  }
  if (s.runway_hours != null) {
    const eta = new Date(Date.now() + s.runway_hours * 3600_000)
    lines.push(`预计 ${eta.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 耗尽`)
  }
  if (s.reason) lines.push(s.reason)
  lines.push(s.in_use ? "近 24h 有网关流量" : "近 24h 无网关流量（仅手填阈值生效）")
  if (isSnoozed(s)) lines.push(`提醒已静默至 ${new Date(s.snooze_until!).toLocaleString("zh-CN")}`)
  return lines.join("\n")
}

/** 预计可用 + 等级徽标 */
export function RunwayValue({ status }: { status?: BalanceAlertStatus }) {
  if (!status) {
    return <span className="text-muted-foreground">待评估</span>
  }
  const meta = LEVEL_META[status.level] ?? LEVEL_META.ok
  const tone = status.level === "warn" ? "text-warning" : status.level === "ok" ? "" : "text-danger"
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate", status.level !== "ok" && "font-semibold", tone)}>
            {status.level === "exhausted" ? "已耗尽" : formatRunway(status.runway_hours)}
          </span>
          {status.level !== "ok" ? (
            <span className={cn("inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", meta.cls)}>
              {meta.label}
            </span>
          ) : null}
          {isSnoozed(status) ? <BellOff className="size-3 shrink-0 text-muted-foreground" aria-label="已静默" /> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 whitespace-pre-line text-xs">
        {runwayTooltip(status)}
      </TooltipContent>
    </Tooltip>
  )
}

/** 充值链接 + 静默菜单 */
export function BalanceAlertActions({
  kind,
  id,
  status,
  rechargeURL,
  onChanged,
}: {
  kind: BalanceAlertStatus["subject_kind"]
  id: number
  status?: BalanceAlertStatus
  rechargeURL?: string
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const url = (status?.recharge_url || rechargeURL || "").trim()
  const safeURL = /^https?:\/\//i.test(url) ? url : ""
  async function snooze(minutes: number) {
    setBusy(true)
    try {
      await apiFetch(`/balance-alerts/${kind}/${id}/snooze`, { method: "POST", body: JSON.stringify({ minutes }) })
      toast.success(minutes > 0 ? `已静默 ${minutes >= 1440 ? `${minutes / 1440} 天` : `${minutes / 60} 小时`}` : "已取消静默")
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "设置静默失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-1">
      {safeURL ? (
        <Button asChild size="sm" variant={status && status.level !== "ok" ? "default" : "outline"} className="h-6 gap-1 px-2 text-[11px]">
          <a href={safeURL} target="_blank" rel="noopener noreferrer">
            去充值 <ExternalLink className="size-3" />
          </a>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={busy} title="静默余额提醒">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <BellOff className="size-3" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem onClick={() => void snooze(120)}>静默 2 小时</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void snooze(720)}>静默 12 小时</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void snooze(1440)}>静默 1 天</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void snooze(10080)}>静默 7 天</DropdownMenuItem>
          {isSnoozed(status) ? <DropdownMenuItem onClick={() => void snooze(0)}>取消静默</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
