import { useId, useState } from "react"
import { AlertTriangle, ArrowRight, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import type { GatewayModelListItem } from "@/lib/api-types"
import type { ModelSourceLabel } from "./gateway-utils"

type ModelPreferenceDialogProps = {
  model: GatewayModelListItem
  sources: ModelSourceLabel[]
  unavailableLabel?: string
  busy: boolean
  onClose: () => void
  onApply: (routeID?: number) => void
}

export function modelPreferenceTriggerID(modelID: string): string {
  return `model-preference-${encodeURIComponent(modelID)}`
}

export function ModelPreferenceDialog({
  model, sources, unavailableLabel, busy, onClose, onApply,
}: ModelPreferenceDialogProps) {
  const inputID = useId()
  const [value, setValue] = useState(
    model.preferred_route_id ? String(model.preferred_route_id) : "auto",
  )
  const chosen = sources.find((s) => String(s.route_id) === value)
  const valid = value === "auto" || chosen != null
  const backups = sources.filter((s) => String(s.route_id) !== value)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="max-w-[calc(100vw-2rem)] sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          document.getElementById(modelPreferenceTriggerID(model.id))?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="size-4 text-primary" /> 设置首选线路
          </DialogTitle>
          <DialogDescription>
            优先使用所选渠道；暂时不可用时，按分组规则选择其他可用线路。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-1">
          <code className="block break-all rounded-md bg-muted px-3 py-2 text-sm">
            {model.id}
          </code>
          <div className="space-y-2">
            <Label htmlFor={inputID}>首选线路</Label>
            <Select value={value} onValueChange={setValue} disabled={busy}>
              <SelectTrigger id={inputID} className="min-h-11 w-full" aria-invalid={!valid}>
                <SelectValue placeholder="选择首选线路" />
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-3rem)]">
                <SelectItem value="auto" description="不固定首选，使用分组的排序规则。">
                  自动选择
                </SelectItem>
                {unavailableLabel && model.preferred_route_id ? (
                  <SelectItem value={String(model.preferred_route_id)} disabled>
                    {unavailableLabel}（不可用）
                  </SelectItem>
                ) : null}
                {sources.map((s) => (
                  <SelectItem key={s.key} value={String(s.route_id)} className="min-h-11">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs leading-relaxed text-muted-foreground">
              仅显示此模型已绑定且启用的线路。
            </p>
          </div>
          {!valid ? (
            <div role="alert" className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>原首选已停用、被移除或不再绑定。请选择其他线路，或恢复自动选择。</p>
            </div>
          ) : (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
              <div className="flex items-start gap-2">
                <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="font-medium">{value === "auto" ? "按分组规则选择渠道" : "备用线路"}</p>
                  <p className="mt-1 break-words text-muted-foreground">
                    {backups.length ? backups.map((s) => s.label).join("、") : "当前没有其他可用线路。"}
                  </p>
                </div>
              </div>
              {value !== "auto" && backups.length ? (
                <p className="text-muted-foreground">请求失败后的自动切换需在分组中启用重试与顺延。</p>
              ) : null}
            </div>
          )}
          <p className="text-xs text-muted-foreground">应用后，点击模型列表上方的“保存模型配置”生效。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="min-h-11 sm:min-h-9">取消</Button>
          <Button disabled={busy || !valid} onClick={() => onApply(value === "auto" ? undefined : Number(value))} className="min-h-11 sm:min-h-9">
            应用首选
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
