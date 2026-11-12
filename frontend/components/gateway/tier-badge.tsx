import { cn } from "@/lib/utils"
import { tierAccent, tierLabel } from "./route-tiers"

/**
 * Linear 风格的优先级「信号格」：三根竖条，主 = 3 格亮，备1 = 2 格，备2 及以后 = 1 格；
 * 不参与调度的显示为三根虚灰条。颜色只出现在亮起的竖条上，其余保持中性。
 */
export function TierBars({ tier, className }: { tier: number; className?: string }) {
  const lit = tier < 0 ? 0 : Math.max(1, 3 - tier)
  return (
    <span className={cn("inline-flex h-2.5 shrink-0 items-end gap-[2px]", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-[1px]",
            i === 0 ? "h-1" : i === 1 ? "h-[7px]" : "h-2.5",
            i < lit ? tierAccent(tier) : "bg-muted-foreground/20",
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
  /** 无边框，仅图标 + 文字（放在已有边框的元素里） */
  bare?: boolean
  className?: string
  title?: string
}

export function TierBadge({ tier, inactiveLabel = "停用", bare, className, title }: TierBadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] leading-none font-medium whitespace-nowrap",
        tier < 0 ? "text-muted-foreground" : "text-foreground/80",
        !bare && "h-5 rounded-md border border-border bg-background px-1.5",
        className,
      )}
    >
      <TierBars tier={tier} />
      {tier < 0 ? inactiveLabel : tierLabel(tier)}
    </span>
  )
}
