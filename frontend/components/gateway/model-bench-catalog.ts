import type { GatewayModelListItem, GatewayModelPreviewItem, GatewayModelRoutePull } from "@/lib/api-types"

export interface BenchModel {
  item: GatewayModelListItem
  /** true = already in the group's saved model list (its route bindings apply) */
  saved: boolean
  /** route IDs whose /v1/models currently report this model */
  reportedBy: number[]
}

/**
 * Saved models keep their configured bindings; models only reported by routes
 * become test-only entries bound to exactly the routes that reported them.
 */
export function mergeBenchModels(saved: GatewayModelListItem[], reported: GatewayModelPreviewItem[]): BenchModel[] {
  const reportedBy = new Map<string, number[]>()
  for (const p of reported) {
    const id = p.id.trim()
    if (!id) continue
    const ids = reportedBy.get(id) ?? []
    for (const s of p.sources ?? []) {
      const rid = Number(s.route_id)
      if (rid > 0 && !ids.includes(rid)) ids.push(rid)
    }
    reportedBy.set(id, ids)
  }

  const out: BenchModel[] = []
  const seen = new Set<string>()
  for (const m of saved) {
    const id = m.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ item: m, saved: true, reportedBy: reportedBy.get(id) ?? [] })
  }
  const extra: BenchModel[] = []
  for (const p of reported) {
    const id = p.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const routes = reportedBy.get(id) ?? []
    extra.push({
      item: {
        id,
        source: "sync",
        channel_ids: p.channel_ids,
        sources: (p.sources ?? []).filter((s) => Number(s.route_id) > 0),
      },
      saved: false,
      reportedBy: routes,
    })
  }
  extra.sort((a, b) => a.item.id.localeCompare(b.item.id))
  return [...out, ...extra]
}

/** Case-insensitive; every whitespace-separated term must appear in the ID. */
export function filterBenchModels(list: BenchModel[], query: string): BenchModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return list
  return list.filter((m) => {
    const id = m.item.id.toLowerCase()
    return terms.every((t) => id.includes(t))
  })
}

/** Route pulls worth surfacing: failures and skips other than "disabled". */
export function failedRoutePulls(routes: GatewayModelRoutePull[] | undefined): GatewayModelRoutePull[] {
  return (routes ?? []).filter((r) => !r.ok && (!r.skipped || r.skip_reason !== "路由已禁用"))
}
