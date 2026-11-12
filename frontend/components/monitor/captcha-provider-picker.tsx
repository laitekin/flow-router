"use client"

import { useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { CaptchaConfig, CaptchaProviderType } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"

const PROVIDER_LABEL: Record<CaptchaProviderType, string> = {
  "2captcha": "2Captcha",
  capsolver: "CapSolver",
  anticaptcha: "Anti-Captcha",
  yescaptcha: "YesCaptcha",
}

interface CaptchaProviderPickerProps {
  id?: string
  value: string
  onChange: (id: string) => void
  configs: CaptchaConfig[] | null
  loading?: boolean
  disabled?: boolean
  /** 新建 provider 成功后回调（调用方刷新列表） */
  onCreated?: (cfg: CaptchaConfig) => void
}

/**
 * 打码 provider 选择器。
 *
 * 修复旧表单「无法选择」的问题：没有可用 provider 时下拉是空的、提示还指向一张已经不存在的
 * 「验证码服务」卡片。这里在没有 provider（或只有被禁用的）时直接内联新建，不用离开当前弹窗。
 */
export function CaptchaProviderPicker({
  id,
  value,
  onChange,
  configs,
  loading,
  disabled,
  onCreated,
}: CaptchaProviderPickerProps) {
  const enabled = (configs ?? []).filter((c) => c.enabled)
  const disabledCount = (configs ?? []).length - enabled.length
  const selectedDisabled = value !== "" && !enabled.some((c) => String(c.id) === value)
  const [creating, setCreating] = useState(false)
  const showCreate = creating || (!loading && enabled.length === 0)

  return (
    <div className="space-y-2">
      {enabled.length > 0 ? (
        <div className="flex gap-2">
          <Select value={selectedDisabled ? "" : value} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger id={id} className="w-full">
              <SelectValue placeholder="选择打码 provider" />
            </SelectTrigger>
            <SelectContent>
              {enabled.map((c) => (
                <SelectItem key={c.id} value={String(c.id)} description={PROVIDER_LABEL[c.type] ?? c.type}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!showCreate ? (
            <Button type="button" variant="outline" size="icon" className="shrink-0" title="新建打码 provider" onClick={() => setCreating(true)} disabled={disabled}>
              <Plus className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {selectedDisabled ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">原来绑定的 provider 已被禁用或删除，请重新选择。</p>
      ) : null}

      {showCreate ? (
        <InlineCaptchaCreate
          disabled={disabled}
          hint={
            enabled.length === 0
              ? disabledCount > 0
                ? `已有 ${disabledCount} 个 provider 但都被禁用了；可以去「打码平台」启用，或在这里新建一个。`
                : "还没有打码 provider，在这里填一个就能用（也可以在 Dock 的「打码平台」里管理）。"
              : undefined
          }
          onCancel={enabled.length > 0 ? () => setCreating(false) : undefined}
          onCreated={(cfg) => {
            setCreating(false)
            onCreated?.(cfg)
            onChange(String(cfg.id))
          }}
        />
      ) : null}
    </div>
  )
}

function InlineCaptchaCreate({
  disabled,
  hint,
  onCreated,
  onCancel,
}: {
  disabled?: boolean
  hint?: string
  onCreated: (cfg: CaptchaConfig) => void
  onCancel?: () => void
}) {
  const [type, setType] = useState<CaptchaProviderType>("2captcha")
  const [apiKey, setAPIKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!apiKey.trim()) {
      setError("请填写 API Key")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const cfg = await apiFetch<CaptchaConfig>("/captcha-configs", {
        method: "POST",
        body: JSON.stringify({ name: PROVIDER_LABEL[type], type, api_key: apiKey.trim(), enabled: true }),
      })
      setAPIKey("")
      onCreated(cfg)
    } catch (e) {
      setError((e as Error).message || "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={cn("space-y-2 rounded-lg border border-dashed border-border bg-muted/30 p-2.5")}>
      {hint ? <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8.5rem_1fr_auto]">
        <Select value={type} onValueChange={(v) => setType(v as CaptchaProviderType)} disabled={disabled || saving}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PROVIDER_LABEL) as CaptchaProviderType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {PROVIDER_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={apiKey}
          onChange={(e) => setAPIKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void save()
            }
          }}
          placeholder={`${PROVIDER_LABEL[type]} clientKey`}
          disabled={disabled || saving}
          autoComplete="off"
        />
        <div className="flex gap-1.5">
          <Button type="button" size="sm" className="h-9" onClick={() => void save()} disabled={disabled || saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存并选用
          </Button>
          {onCancel ? (
            <Button type="button" size="sm" variant="ghost" className="h-9" onClick={onCancel} disabled={saving}>
              取消
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}
