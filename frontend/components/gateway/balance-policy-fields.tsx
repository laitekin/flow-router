import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { GroupFormState } from "./gateway-utils"
import { balancePolicySchema } from "./balance-policy-form"

type CooldownField = "balance_cooldown_seconds" | "balance_cooldown_max_seconds"

export function BalancePolicyFields({ form, onChange, busy }: {
  form: GroupFormState
  onChange: (form: GroupFormState) => void
  busy: boolean
}) {
  const [touched, setTouched] = useState<Partial<Record<CooldownField, boolean>>>({})
  const parsed = balancePolicySchema.safeParse(form)
  const errors = parsed.success ? {} : parsed.error.flatten().fieldErrors
  const configuredButInactive = form.balance_failover_enabled && (!form.retry_enabled || !form.failover_enabled)
  const fields: { key: CooldownField; label: string; hint: string }[] = [
    { key: "balance_cooldown_seconds", label: "初始冷却（秒）", hint: "默认 300 秒（5 分钟）；0 表示不新增冷却。" },
    { key: "balance_cooldown_max_seconds", label: "最长冷却（秒）", hint: "默认 1800 秒（30 分钟）；设为初始值可使用固定时长。" },
  ]
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <legend className="px-1 text-sm font-medium">余额不足专项策略</legend>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Label htmlFor="balance-failover-enabled" className="flex min-h-11 flex-1 cursor-pointer items-center">
          余额不足顺延
        </Label>
        <div className="flex min-h-11 min-w-11 items-center justify-center">
          <Switch id="balance-failover-enabled" checked={form.balance_failover_enabled} disabled={busy}
            aria-describedby="balance-failover-help"
            onCheckedChange={(value) => onChange({ ...form, balance_failover_enabled: value })} />
        </div>
      </div>
      <p id="balance-failover-help" className="text-xs leading-5 text-muted-foreground">
        只匹配明确的余额不足／额度耗尽。开启后仍受重试总开关、顺延开关与次数限制；关闭后直接返回该错误，即使开启了通用 4xx 顺延也不切换。
      </p>
      {configuredButInactive && <p role="status" className="rounded-md border border-border bg-background p-2 text-xs leading-5">
        当前仅保存此偏好：请同时开启上方的“开启重试”和“顺延下一个接口”，余额不足顺延才会执行。
      </p>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {fields.map(({ key, label, hint }) => {
          const error = touched[key] ? errors[key]?.[0] : undefined
          return <div key={key} className="min-w-0 space-y-1.5">
            <Label htmlFor={key}>{label}</Label>
            <Input id={key} type="number" inputMode="numeric" min={0} max={86400} step={1}
              className="h-11" disabled={busy} value={form[key]} aria-invalid={!!error}
              aria-describedby={`${key}-help${error ? ` ${key}-error` : ""}`}
              onBlur={() => setTouched((value) => ({ ...value, [key]: true }))}
              onChange={(event) => onChange({ ...form, [key]: event.target.value })} />
            <p id={`${key}-help`} className="text-xs leading-5 text-muted-foreground">{hint}</p>
            {error && <p id={`${key}-error`} role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
          </div>
        })}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        冷却独立于顺延开关。1 小时内连续失败按初始时长翻倍，最多达到上限；默认 300 → 600 → 1200 → 1800 秒。
        同端点、同凭据跨模型／分组共享冷却，以触发失败时该组的设置计算。修改只影响新发生的失败，不会清除或缩短已有冷却。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">已输出内容或绑定上游上下文时仍不会强行跨渠道重放。</p>
    </fieldset>
  )
}
