import { cn } from "@/lib/utils"
import { SOFT } from "@/lib/soft-tone"
import { tierColor, tierLabel } from "./route-tiers"

/**
 * 优先级「信号格」：三根竖条，主 = 3 格亮，备1 = 2 格，备2 及以后 = 1 格；
 * 不参与调度为三根虚灰条。亮起的竖条用该档的柔和色。
 */
export function TierBars({ tier, className }: { tier: number; className?: string }) {
  const lit = tier < 0 ? 0 : Math.max(1, 3 - tier)
  const color = tierColor(tier)
  return (
    <span className={cn("inline-flex h-2.5 shrink-0 items-end gap-[2px]", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-[1px]",
            i === 0 ? "h-1" : i === 1 ? "h-[7px]" : "h-2.5",
            i < lit && color ? SOFT[color].dot : "bg-current opacity-20",
          )}
        />
      ))}
    </span>
  )
}

interface TierBadgeProps {
  tier: number
  /** tier < 0 时显示的文字（停用 / 冷却） */
  inactiveLabel?: string
  /** 无底色描边，仅图标 + 彩色文字 */
  bare?: boolean
  className?: string
  title?: string
}

/** 柔和彩色标签：淡底 + 同色文字 + 信号格。 */
export function TierBadge({ tier, inactiveLabel = "停用", bare, className, title }: TierBadgeProps) {
  const color = tierColor(tier)
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] leading-none font-medium whitespace-nowrap",
        color ? SOFT[color].text : "text-muted-foreground",
        !bare && "h-5 rounded-md border px-1.5",
        !bare && (color ? SOFT[color].badge : "border-dashed border-border bg-muted/40"),
        className,
      )}
    >
      <TierBars tier={tier} />
      {tier < 0 ? inactiveLabel : tierLabel(tier)}
    </span>
  )
}
