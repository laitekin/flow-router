import { z } from "zod"

const seconds = z.string().trim()
  .regex(/^\d+$/, "请输入 0–86400 的整数秒数")
  .transform(Number)
  .refine((n) => n <= 86400, "不能超过 86400 秒（24 小时）")

export const balancePolicySchema = z.object({
  balance_cooldown_seconds: seconds,
  balance_cooldown_max_seconds: seconds,
}).refine((v) => v.balance_cooldown_max_seconds >= v.balance_cooldown_seconds, {
  path: ["balance_cooldown_max_seconds"],
  message: "最长冷却不能小于初始冷却",
})
