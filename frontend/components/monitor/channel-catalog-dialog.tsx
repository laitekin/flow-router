"use client"

import { useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { Channel, GroupCatalog } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { GroupCatalogView } from "./group-catalog-view"

interface ChannelCatalogDialogProps {
  channel: Channel | null
  onOpenChange: (v: boolean) => void
}

/** 已保存渠道的「分组 · 分组价格 · 分组下的模型」。实时向上游拉取。 */
export function ChannelCatalogDialog({ channel, onOpenChange }: ChannelCatalogDialogProps) {
  const [groups, setGroups] = useState<GroupCatalog[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!channel) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiFetch<GroupCatalog[]>(`/channels/${channel.id}/catalog`)
      .then((d) => {
        if (!cancelled) setGroups(d)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || "加载失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel, tick])

  useEffect(() => {
    if (!channel) setGroups(null)
  }, [channel])

  return (
    <Dialog open={channel != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{channel?.name} · 分组与模型</DialogTitle>
          <DialogDescription>
            实时读取上游：每个分组的倍率（实际价 = 模型基础价 × 倍率）以及分组下能用的模型。搜模型可直接比较哪个分组最便宜。
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setTick((t) => t + 1)} disabled={loading}>
            {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            刷新
          </Button>
        </div>
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}
        {groups ? (
          <GroupCatalogView groups={groups} maxHeightClass="max-h-[55vh]" />
        ) : loading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">正在向上游读取分组…</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
