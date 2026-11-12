/**
 * 柔和色板（Linear 式彩色标签）：淡色底 + 同色系文字 + 低透明度描边，不用实心填充。
 * 类名必须写全，Tailwind 才能扫描到。
 */
export type SoftColor = "emerald" | "sky" | "violet" | "amber" | "rose" | "orange" | "blue" | "slate"

export interface SoftTone {
  /** 小标签：淡底 + 彩字 + 淡描边 */
  badge: string
  /** 大块表面（卡片 / chip）：极淡底 + 彩色描边 */
  surface: string
  /** 仅文字 */
  text: string
  /** 实心小点 / 竖条 */
  dot: string
}

export const SOFT: Record<SoftColor, SoftTone> = {
  emerald: {
    badge: "border-emerald-200 dark:border-emerald-800 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    surface: "border-emerald-200 dark:border-emerald-800 bg-emerald-500/[0.04] dark:bg-emerald-400/[0.06]",
    text: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  sky: {
    badge: "border-sky-200 dark:border-sky-800 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    surface: "border-sky-200 dark:border-sky-800 bg-sky-500/[0.04] dark:bg-sky-400/[0.06]",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500 dark:bg-sky-400",
  },
  violet: {
    badge: "border-violet-200 dark:border-violet-800 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    surface: "border-violet-200 dark:border-violet-800 bg-violet-500/[0.04] dark:bg-violet-400/[0.06]",
    text: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500 dark:bg-violet-400",
  },
  amber: {
    badge: "border-amber-200 dark:border-amber-800 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    surface: "border-amber-200 dark:border-amber-800 bg-amber-500/[0.05] dark:bg-amber-400/[0.06]",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  rose: {
    badge: "border-rose-200 dark:border-rose-800 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    surface: "border-rose-200 dark:border-rose-800 bg-rose-500/[0.04] dark:bg-rose-400/[0.06]",
    text: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500 dark:bg-rose-400",
  },
  orange: {
    badge: "border-orange-200 dark:border-orange-800 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    surface: "border-orange-200 dark:border-orange-800 bg-orange-500/[0.04] dark:bg-orange-400/[0.06]",
    text: "text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500 dark:bg-orange-400",
  },
  blue: {
    badge: "border-blue-200 dark:border-blue-800 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    surface: "border-blue-200 dark:border-blue-800 bg-blue-500/[0.04] dark:bg-blue-400/[0.06]",
    text: "text-blue-700 dark:text-blue-300",
    dot: "bg-blue-500 dark:bg-blue-400",
  },
  slate: {
    badge: "border-slate-200 dark:border-slate-800 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    surface: "border-slate-200 dark:border-slate-800 bg-slate-500/[0.04] dark:bg-slate-400/[0.06]",
    text: "text-slate-700 dark:text-slate-300",
    dot: "bg-slate-400 dark:bg-slate-500",
  },
}
