import { toast } from "sonner"
import { Copy, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
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
import { fullDateTime, money, relativeTime } from "@/lib/format"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import type { GatewayKey, GatewayUsageStat } from "@/lib/api-types"
import { StatLine, SUMMARY_WINDOW_LABEL } from "./usage-stat"

/** 最近使用取 last_used_at（每分钟落库一次）与 24h 用量里最后一条请求时间中更晚的那个 */
function lastUsed(k: GatewayKey, stat?: GatewayUsageStat): string | null {
  const a = k.last_used_at ? new Date(k.last_used_at).getTime() : 0
  const b = stat?.last_at ? new Date(stat.last_at).getTime() : 0
  if (!a && !b) return null
  return a >= b ? k.last_used_at! : stat!.last_at!
}

type KeysPanelProps = {
  keys: GatewayKey[]
  keySecrets: Record<number, string>
  busy: boolean
  refreshing?: boolean
  onRefresh: () => void
  onCreate: () => void
  onEdit: (k: GatewayKey) => void
  onToggle: (k: GatewayKey) => void
  onDelete: (id: number) => void
  /** 各密钥 24h 用量（key 为密钥 id） */
  stats?: Record<string, GatewayUsageStat>
}

export function KeysPanel({
  keys,
  keySecrets,
  busy,
  refreshing = false,
  onRefresh,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
  stats,
}: KeysPanelProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        <Card className="overflow-hidden border-border shadow-none">
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">API 密钥</div>
                <p className="text-xs text-muted-foreground">
                  客户端使用组内密钥访问 /v1/*；用量为近 {SUMMARY_WINDOW_LABEL}，重试 / 顺延只算一次请求
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || refreshing}
                  title="刷新密钥列表"
                  onClick={() => onRefresh()}
                >
                  <RefreshCw
                    className={cn("size-3.5", refreshing && "animate-spin")}
                  />
                  刷新
                </Button>
                <Button size="sm" onClick={onCreate} disabled={busy || refreshing}>
                  <Plus className="size-3.5" /> 创建密钥
                </Button>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>{SUMMARY_WINDOW_LABEL} 用量</TableHead>
                  <TableHead>配额</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const secret = keySecrets[k.id] ?? ""
                  const stat = stats?.[String(k.id)]
                  const used = lastUsed(k, stat)
                  const quotaRatio = k.quota > 0 ? Math.min(1, k.quota_used / k.quota) : null
                  return (
                    <TableRow key={k.id} className={cn(k.status !== "active" && "opacity-60")}>
                      <TableCell className="font-medium">{k.name}</TableCell>
                      <TableCell>
                        <div className="flex min-w-[13rem] max-w-xs items-center gap-1.5">
                          <Input
                            className="h-8 font-mono text-xs"
                            readOnly
                            value={secret || k.key_prefix || ""}
                            placeholder="加载中…"
                          />
                          <Button
                            size="icon"
                            variant="outline"
                            className="size-8 shrink-0"
                            disabled={!secret}
                            title="复制密钥"
                            onClick={() => {
                              if (!secret) return
                              void copyText(secret)
                                .then(() => toast.success("已复制密钥"))
                                .catch(() => toast.error("复制失败"))
                            }}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatLine stat={stat} />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {quotaRatio != null ? (
                          <div className="w-28 space-y-1">
                            <div className="flex justify-between gap-2">
                              <span>{money(k.quota_used)}</span>
                              <span className="text-muted-foreground">/ {money(k.quota)}</span>
                            </div>
                            <div className="h-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  quotaRatio >= 0.9 ? "bg-red-500" : quotaRatio >= 0.7 ? "bg-amber-500" : "bg-primary",
                                )}
                                style={{ width: `${Math.max(2, quotaRatio * 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            已用 {money(k.quota_used)} · 不限
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {used ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                                {relativeTime(used)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">
                              最后使用：{fullDateTime(used)}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          "从未使用"
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={k.status === "active"}
                          onCheckedChange={() => void onToggle(k)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-0.5">
                          <Button size="icon" variant="ghost" className="size-8" title="编辑" onClick={() => onEdit(k)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            title="删除"
                            onClick={() => void onDelete(k.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {keys.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center text-muted-foreground"
                    >
                      组内暂无密钥，创建后客户端用该密钥访问 /v1/*
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  )
}
