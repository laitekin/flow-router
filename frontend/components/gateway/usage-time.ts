/** 使用记录时间范围快捷项：统一生成 datetime-local 字符串（本地时区，含秒）。 */

export type UsageRangePreset = "1h" | "24h" | "today" | "7d" | "30d" | "all"

export const USAGE_RANGE_PRESETS: { id: UsageRangePreset; label: string }[] = [
  { id: "1h", label: "近 1 小时" },
  { id: "24h", label: "近 24 小时" },
  { id: "today", label: "今天" },
  { id: "7d", label: "近 7 天" },
  { id: "30d", label: "近 30 天" },
  // 不限时间：原来「重置」后的默认行为，大表上统计会慢一些
  { id: "all", label: "全部" },
]

/** 默认查询范围：全量统计在大表上必然慢，默认只看今天 */
export const DEFAULT_USAGE_RANGE: UsageRangePreset = "today"

export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

/**
 * 「近 N 小时」不设结束时间，开着自动刷新时新请求才会持续出现；
 * 「今天 / 近 N 天」按自然日：起始日 00:00:00 ~ 今天 23:59:59。
 */
export function usageRangeFor(
  preset: UsageRangePreset,
  now: Date = new Date(),
): { from: string; to: string } {
  if (preset === "all") return { from: "", to: "" }
  if (preset === "1h" || preset === "24h") {
    const hours = preset === "1h" ? 1 : 24
    return { from: toLocalInput(new Date(now.getTime() - hours * 3600_000)), to: "" }
  }
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    0,
  )
  const from = startOfDay(now)
  if (preset === "7d") from.setDate(from.getDate() - 6)
  if (preset === "30d") from.setDate(from.getDate() - 29)
  return { from: toLocalInput(from), to: toLocalInput(endOfToday) }
}
