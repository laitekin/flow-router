/**
 * 主备分档：与后端 gateway/select.go 的 SortRoutes 对齐。
 *
 *  1. 只有可调度路由参与（启用、未在冷却中）
 *  2. 按有效倍率排序（分组 rate_sort_direction：asc 低倍率优先 / desc 高倍率优先）
 *  3. 同倍率 = 同一档：按权重加权分流（不是谁先谁后）；同档内列表顺序 = 路由 position
 *  4. 档与档之间是 failover：前一档全部失败 / 冷却才顺延到下一档
 *
 * 第 0 档叫「主」，之后依次「备1」「备2」…
 */

export type TierState = "active" | "paused" | "disabled"

export interface TierInput<T> {
  item: T
  /** 原列表下标（= position 顺序） */
  index: number
  rate: number
  weight: number
  state: TierState
}

export interface TierEntry<T> extends TierInput<T> {
  /** 0 = 主，1 = 备1 …；不可调度为 -1 */
  tier: number
  /** 同档内按权重的流量占比（0–1）；不可调度为 0 */
  share: number
  /** 同档路由数 */
  tierSize: number
}

export function assignRouteTiers<T>(inputs: TierInput<T>[], direction: string = "asc"): TierEntry<T>[] {
  const dir = direction === "desc" ? -1 : 1
  const active = inputs
    .filter((x) => x.state === "active")
    .sort((a, b) => {
      if (a.rate !== b.rate) return (a.rate - b.rate) * dir
      return a.index - b.index
    })

  const out: TierEntry<T>[] = []
  let tier = -1
  let i = 0
  while (i < active.length) {
    let j = i + 1
    while (j < active.length && active[j].rate === active[i].rate) j++
    tier++
    const seg = active.slice(i, j)
    // 后端 weightedPermute：Weight<=0 的只作末位兜底，不参与首选抽签
    const positive = seg.reduce((sum, x) => sum + Math.max(0, x.weight), 0)
    for (const x of seg) {
      const share = positive > 0 ? Math.max(0, x.weight) / positive : 1 / seg.length
      out.push({ ...x, tier, share, tierSize: seg.length })
    }
    i = j
  }

  const inactive = inputs
    .filter((x) => x.state !== "active")
    .sort((a, b) => a.index - b.index)
    .map<TierEntry<T>>((x) => ({ ...x, tier: -1, share: 0, tierSize: 0 }))
  return [...out, ...inactive]
}

export function tierLabel(tier: number): string {
  if (tier < 0) return "—"
  return tier === 0 ? "主" : `备${tier}`
}

/**
 * 每档的强调色：只用在小号「信号格」图标上，表面保持中性（Linear 风格）。
 * 主 = 柔和绿，备1 = 柔和蓝，备2 = 柔和紫，更后 = 灰。
 */
export function tierAccent(tier: number): string {
  switch (tier) {
    case 0:
      return "bg-emerald-500/85 dark:bg-emerald-400/80"
    case 1:
      return "bg-sky-500/75 dark:bg-sky-400/70"
    case 2:
      return "bg-violet-400/80 dark:bg-violet-400/70"
    default:
      return "bg-zinc-400/80 dark:bg-zinc-500"
  }
}
