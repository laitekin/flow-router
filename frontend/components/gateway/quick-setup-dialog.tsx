"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, ChevronDown, Loader2, Search, Sparkles, X, Zap } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type {
  Channel,
  GatewayProviderOption,
  GatewayRoute,
  RateSnapshot,
} from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { SOFT } from "@/lib/soft-tone"
import { cn } from "@/lib/utils"
import { emptyRoute, formatRate, routeSourceKind } from "./gateway-utils"
import { assignRouteTiers } from "./route-tiers"
import { TierBadge } from "./tier-badge"

/**
 * 快速配置：勾选「渠道分组 / 直连渠道」→ 一键完成 保存路由 → 创建上游密钥 → 同步模型。
 * 代替逐条「添加路由 → 选渠道 → 选分组 → 保存 → 确保密钥 → 同步模型」。
 */

export interface QuickSetupOptions {
  ensureKeys: boolean
  syncModels: boolean
}

export type QuickSetupStep = "routes" | "keys" | "models"
export type QuickSetupStepState = { state: "pending" | "running" | "ok" | "error" | "skipped"; detail?: string }

interface QuickSetupDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  groupName: string
  channels: Channel[]
  providers: GatewayProviderOption[]
  existingRoutes: Partial<GatewayRoute>[]
  rateSort: string
  /** 执行配置；通过 onStep 回报每一步进度 */
  onApply: (
    newRoutes: Partial<GatewayRoute>[],
    options: QuickSetupOptions,
    onStep: (step: QuickSetupStep, s: QuickSetupStepState) => void,
  ) => Promise<void>
}

interface Candidate {
  key: string
  kind: "monitor" | "provider"
  channel?: Channel
  provider?: GatewayProviderOption
  group?: RateSnapshot
  label: string
  sub: string
  rate: number
}

function groupKey(channelID: number, g: { remote_group_id?: number | null; model_name?: string; source_group_id?: number | null; source_group_name?: string }) {
  const id = g.remote_group_id ?? g.source_group_id
  if (id != null) return `m:${channelID}:id:${id}`
  return `m:${channelID}:name:${(g.model_name ?? g.source_group_name ?? "").trim().toLowerCase()}`
}

function existingKey(r: Partial<GatewayRoute>): string {
  if (routeSourceKind(r) === "provider") return `p:${r.gateway_provider_id}`
  return groupKey(Number(r.source_channel_id) || 0, r)
}

const STEP_LABEL: Record<QuickSetupStep, string> = {
  routes: "保存路由",
  keys: "在上游自动创建密钥",
  models: "同步模型列表",
}

export function QuickSetupDialog({
  open,
  onOpenChange,
  groupName,
  channels,
  providers,
  existingRoutes,
  rateSort,
  onApply,
}: QuickSetupDialogProps) {
  const [ratesByChannel, setRatesByChannel] = useState<Record<number, RateSnapshot[] | "error">>({})
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [options, setOptions] = useState<QuickSetupOptions>({ ensureKeys: true, syncModels: true })
  const [steps, setSteps] = useState<Partial<Record<QuickSetupStep, QuickSetupStepState>>>({})
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)

  const existing = useMemo(() => new Set(existingRoutes.map(existingKey)), [existingRoutes])

  useEffect(() => {
    if (!open) return
    setSelected(new Set())
    setSteps({})
    setDone(false)
    setQuery("")
    let cancelled = false
    setLoading(true)
    Promise.all(
      channels.map(async (c) => {
        try {
          return [c.id, await apiFetch<RateSnapshot[]>(`/channels/${c.id}/rates`)] as const
        } catch {
          return [c.id, "error" as const] as const
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      setRatesByChannel(Object.fromEntries(pairs))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, channels])

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: { id: string; title: string; type: string; items: Candidate[]; error?: boolean }[] = []
    for (const c of channels) {
      const rates = ratesByChannel[c.id]
      const items: Candidate[] =
        rates && rates !== "error"
          ? rates.map((g) => ({
              key: groupKey(c.id, g),
              kind: "monitor",
              channel: c,
              group: g,
              label: g.model_name,
              sub: g.description ?? "",
              rate: g.ratio,
            }))
          : []
      const filtered = q
        ? items.filter((it) => [c.name, it.label, it.sub].some((v) => v.toLowerCase().includes(q)))
        : items
      if (filtered.length > 0 || (!q && rates === "error")) {
        out.push({ id: `c${c.id}`, title: c.name, type: c.type === "newapi" ? "NewAPI" : "Sub2API", items: filtered.sort((a, b) => a.rate - b.rate), error: rates === "error" })
      }
    }
    const provItems: Candidate[] = providers
      .filter((p) => p.enabled !== false)
      .map<Candidate>((p) => ({
        key: `p:${p.id}`,
        kind: "provider",
        provider: p,
        label: p.name,
        sub: p.base_url,
        rate: p.default_billing_rate > 0 ? p.default_billing_rate : 1,
      }))
      .filter((it) => !q || [it.label, it.sub].some((v) => v.toLowerCase().includes(q)))
    if (provItems.length) out.push({ id: "providers", title: "直连渠道", type: "直连", items: provItems })
    return out
  }, [channels, providers, ratesByChannel, query])

  const allCandidates = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const candidateByKey = useMemo(() => new Map(allCandidates.map((c) => [c.key, c])), [allCandidates])
  const minRate = allCandidates.length ? Math.min(...allCandidates.map((c) => c.rate)) : 0

  // 主备预览：已有路由 + 新勾选，按网关规则分档
  const tierByKey = useMemo(() => {
    const inputs = [
      ...existingRoutes
        .filter((r) => r.enabled !== false)
        .map((r, i) => ({ item: existingKey(r), index: i, rate: Number(r.billing_rate_multiplier) || 1, weight: r.weight ?? 1, state: "active" as const })),
      ...[...selected].flatMap((k, i) => {
        const c = candidateByKey.get(k)
        return c ? [{ item: k, index: 10_000 + i, rate: c.rate, weight: 1, state: "active" as const }] : []
      }),
    ]
    return new Map(assignRouteTiers(inputs, rateSort).map((e) => [e.item, e]))
  }, [existingRoutes, selected, candidateByKey, rateSort])

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSection(items: Candidate[]) {
    const keys = items.filter((it) => !existing.has(it.key)).map((it) => it.key)
    const allOn = keys.length > 0 && keys.every((k) => selected.has(k))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (allOn) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }

  async function apply() {
    const routes = [...selected].flatMap((k): Partial<GatewayRoute>[] => {
      const c = candidateByKey.get(k)
      if (!c) return []
      if (c.kind === "provider" && c.provider) {
        return [{
          ...emptyRoute(),
          source_kind: "provider",
          source_channel_id: 0,
          gateway_provider_id: c.provider.id,
          rate_convert_mode: "custom",
          rate_convert_value: c.rate,
          billing_rate_multiplier: c.rate,
          upstream_protocol: c.provider.upstream_protocol || "auto",
        }]
      }
      return [{
        ...emptyRoute(),
        source_channel_id: c.channel!.id,
        source_group_id: c.group?.remote_group_id ?? null,
        source_group_name: (c.group?.model_name ?? "").trim(),
        billing_rate_multiplier: c.rate > 0 ? c.rate : 1,
      }]
    })
    const hasMonitor = routes.some((r) => r.source_kind !== "provider") || existingRoutes.some((r) => routeSourceKind(r) === "monitor" && !r.source_api_key_name)
    setSteps({
      routes: { state: "pending" },
      keys: { state: options.ensureKeys && hasMonitor ? "pending" : "skipped", detail: !hasMonitor ? "没有监控渠道路由" : undefined },
      models: { state: options.syncModels ? "pending" : "skipped" },
    })
    setRunning(true)
    try {
      await onApply(routes, { ...options, ensureKeys: options.ensureKeys && hasMonitor }, (step, st) =>
        setSteps((prev) => ({ ...prev, [step]: st })),
      )
      setDone(true)
      setSelected(new Set())
    } finally {
      setRunning(false)
    }
  }

  const progressView = Object.keys(steps).length > 0
  const selectedList = [...selected].map((k) => candidateByKey.get(k)).filter((c): c is Candidate => !!c)

  return (
    <Dialog open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <DialogContent className="grid-cols-1 sm:max-w-3xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className={cn("flex size-6 items-center justify-center rounded-md border", SOFT.blue.badge)}>
              <Zap className="size-3.5" />
            </span>
            快速配置 · {groupName}
          </DialogTitle>
          <DialogDescription>
            勾选要接入的渠道分组，一键完成：添加路由 → 在上游创建密钥 → 同步模型。主备按倍率自动排好，之后仍可在表格里微调。
          </DialogDescription>
        </DialogHeader>

        {progressView ? (
          <div className="space-y-3">
            <ol className="space-y-2">
              {(["routes", "keys", "models"] as QuickSetupStep[]).map((step) => {
                const st = steps[step] ?? { state: "pending" }
                return (
                  <li key={step} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                    <span
                      className={cn(
                        "mt-px flex size-5 shrink-0 items-center justify-center rounded-full border",
                        st.state === "ok" && SOFT.emerald.badge,
                        st.state === "error" && SOFT.rose.badge,
                        st.state === "running" && SOFT.sky.badge,
                        (st.state === "pending" || st.state === "skipped") && "border-border text-muted-foreground",
                      )}
                    >
                      {st.state === "running" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : st.state === "ok" ? (
                        <Check className="size-3" />
                      ) : st.state === "error" ? (
                        <X className="size-3" />
                      ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm", st.state === "skipped" ? "text-muted-foreground line-through" : "text-foreground")}>
                        {STEP_LABEL[step]}
                      </p>
                      {st.detail ? (
                        <p className={cn("mt-0.5 text-xs", st.state === "error" ? SOFT.rose.text : "text-muted-foreground")}>{st.detail}</p>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
            {done ? (
              <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">完成。到「渠道路由」「模型映射」查看结果，主备已按倍率排好。</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSteps({})}>
                    继续添加
                  </Button>
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    完成
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜渠道或分组" className="h-9 pl-8 text-xs" />
            </div>

            <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-0.5">
              {loading ? (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                  正在读取各渠道分组…
                </p>
              ) : sections.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
                  {query ? "没有匹配的分组" : "还没有渠道或直连渠道，先到概览页「导入渠道」"}
                </p>
              ) : (
                sections.map((sec) => {
                  const selectable = sec.items.filter((it) => !existing.has(it.key))
                  const allOn = selectable.length > 0 && selectable.every((it) => selected.has(it.key))
                  const someOn = selectable.some((it) => selected.has(it.key))
                  const isCollapsed = collapsed[sec.id]
                  return (
                    <section key={sec.id} className="overflow-hidden rounded-lg border border-border">
                      <header className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                        <Checkbox
                          checked={allOn ? true : someOn ? "indeterminate" : false}
                          disabled={selectable.length === 0}
                          onCheckedChange={() => toggleSection(sec.items)}
                          aria-label={`全选 ${sec.title}`}
                        />
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setCollapsed((p) => ({ ...p, [sec.id]: !isCollapsed }))}
                        >
                          <span className="truncate text-[13px] font-medium">{sec.title}</span>
                          <span
                            className={cn(
                              "rounded border px-1 text-[10px] leading-4 font-medium",
                              sec.type === "NewAPI" ? SOFT.violet.badge : sec.type === "直连" ? SOFT.orange.badge : SOFT.blue.badge,
                            )}
                          >
                            {sec.type}
                          </span>
                          <span className="text-[11px] text-muted-foreground">{sec.items.length} 个分组</span>
                          <ChevronDown className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")} />
                        </button>
                      </header>
                      {!isCollapsed ? (
                        sec.error ? (
                          <p className={cn("px-3 py-2 text-xs", SOFT.rose.text)}>读取分组失败，可先在概览页同步该渠道</p>
                        ) : (
                          <ul className="divide-y divide-border/70">
                            {sec.items.map((it) => {
                              const added = existing.has(it.key)
                              const on = selected.has(it.key)
                              const tier = tierByKey.get(it.key)
                              return (
                                <li key={it.key}>
                                  <label
                                    className={cn(
                                      "flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors",
                                      on ? "bg-sky-500/[0.04]" : "hover:bg-muted/30",
                                      added && "cursor-default opacity-60",
                                    )}
                                  >
                                    <Checkbox checked={on || added} disabled={added} onCheckedChange={() => toggle(it.key)} />
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-[13px]">{it.label}</p>
                                      {it.sub ? <p className="truncate text-[11px] text-muted-foreground">{it.sub}</p> : null}
                                    </div>
                                    {added ? (
                                      <span className="text-[11px] text-muted-foreground">已在路由中</span>
                                    ) : on && tier ? (
                                      <TierBadge tier={tier.tier} />
                                    ) : null}
                                    <span
                                      className={cn(
                                        "inline-flex h-6 min-w-14 items-center justify-center rounded-md border px-1.5 font-mono text-xs tabular-nums",
                                        it.rate === minRate ? SOFT.emerald.badge : it.rate > 1 ? SOFT.amber.badge : "border-border text-foreground/80",
                                      )}
                                    >
                                      ×{formatRate(it.rate)}
                                    </span>
                                  </label>
                                </li>
                              )
                            })}
                          </ul>
                        )
                      ) : null}
                    </section>
                  )
                })
              )}
            </div>

            {selectedList.length > 0 ? (
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                <p className="mb-1.5 text-[11px] text-muted-foreground">将新增 {selectedList.length} 条路由 · 主备预览</p>
                <div className="flex flex-wrap gap-1">
                  {selectedList
                    .map((c) => ({ c, t: tierByKey.get(c.key)?.tier ?? 99 }))
                    .sort((a, b) => a.t - b.t || a.c.rate - b.c.rate)
                    .map(({ c, t }) => (
                      <span key={c.key} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-background pr-1 pl-1.5 text-[11px]">
                        <TierBadge tier={t} bare />
                        <span className="max-w-[12rem] truncate">{c.channel ? `${c.channel.name} · ${c.label}` : c.label}</span>
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => toggle(c.key)} aria-label="移除">
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center">
              <div className="flex flex-1 flex-wrap gap-x-4 gap-y-1.5 text-xs">
                <label className="flex items-center gap-1.5">
                  <Switch checked={options.ensureKeys} onCheckedChange={(v) => setOptions((o) => ({ ...o, ensureKeys: v }))} className="scale-90" />
                  在上游自动创建密钥
                </label>
                <label className="flex items-center gap-1.5">
                  <Switch checked={options.syncModels} onCheckedChange={(v) => setOptions((o) => ({ ...o, syncModels: v }))} className="scale-90" />
                  同步模型列表
                </label>
              </div>
              <Button onClick={() => void apply()} disabled={selected.size === 0 || running}>
                <Sparkles className="size-3.5" />
                一键配置{selected.size ? `（${selected.size}）` : ""}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
