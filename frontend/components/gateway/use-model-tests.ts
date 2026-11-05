import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api"
import { streamModelProbe } from "@/lib/model-probe-stream"
import type { GatewayModelTestResponse, GatewayModelTestResult, GatewayProbeSample } from "@/lib/api-types"
import { ModelTestPool, modelTaskKey, parseModelTaskKey } from "./model-test-tasks"
import { buildProbePlan, buildProbeRequest, randomSeed, type ProbeTemplate } from "./probe-presets"

export interface ProbeRun {
  /** snapshot of the template used, so later edits don't reinterpret old results */
  template: ProbeTemplate
  expect: string
  estimatedInputTokens: number
  samples: GatewayProbeSample[]
  state: "queued" | "running" | "waiting" | "done" | "cancelled" | "error"
  round: number
  total: number
  label?: string
  upstreamModel?: string
  upstreamPath?: string
  protocol?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

export const MAX_CONCURRENCY = 8

export function useModelTests(groupID?: number) {
  const pool = useRef(new ModelTestPool(3))
  const controllers = useRef(new Map<string, AbortController>())
  const [concurrency, setConcurrencyState] = useState(3)
  const [active, setActive] = useState<string[]>([])
  const [results, setResults] = useState<Record<string, GatewayModelTestResult>>({})
  const [probeRuns, setProbeRuns] = useState<Record<string, ProbeRun>>({})
  useEffect(() => {
    const requests = controllers.current
    return () => { for (const c of requests.values()) c.abort(); requests.clear() }
  }, [])

  /** testID undefined = any test on that model/route; "" = availability only. */
  const isTesting = (model: string, routeID?: number, testID?: string) => active.some((key) => {
    const k = parseModelTaskKey(key)
    return k.groupID === groupID && k.model === model && (routeID == null || k.routeID === routeID) && (testID == null || k.testID === testID)
  })
  const modelResults = useMemo(() => {
    const byModel: Record<string, GatewayModelTestResult[]> = {}
    for (const [key, result] of Object.entries(results)) {
      const k = parseModelTaskKey(key)
      if (k.groupID === groupID) (byModel[k.model] ??= []).push(result)
    }
    return byModel
  }, [results, groupID])

  async function track(key: string, job: (signal: AbortSignal) => Promise<void>, onError: (message: string, cancelled: boolean) => void, toastLabel: string) {
    if (controllers.current.has(key)) return
    const controller = new AbortController()
    controllers.current.set(key, controller)
    setActive((prev) => [...prev, key])
    try {
      await pool.current.run(controller.signal, () => job(controller.signal))
    } catch (error) {
      const cancelled = controller.signal.aborted
      const message = error instanceof Error ? error.message : "测试失败"
      onError(message, cancelled)
      if (!cancelled) toast.error(`${toastLabel}：${message}`)
    } finally {
      controllers.current.delete(key)
      setActive((prev) => prev.filter((x) => x !== key))
    }
  }

  function startAvailability(model: string, routeID: number) {
    if (!groupID) return
    const gid = groupID
    const key = modelTaskKey(gid, model, routeID)
    void track(key, async (signal) => {
      const res = await apiFetch<GatewayModelTestResponse>(`/gateway/groups/${gid}/models/test`, {
        method: "POST", body: JSON.stringify({ model, route_id: routeID }), signal,
      })
      if (signal.aborted) return
      const item = res.items?.[0]
      if (item) setResults((prev) => ({ ...prev, [key]: item }))
      else throw new Error("没有可测试的已保存线路")
    }, (message, cancelled) => {
      if (!cancelled) setResults((prev) => ({ ...prev, [key]: { route_id: routeID, channel_id: 0, label: "", requested_model: model, upstream_model: model, ok: false, status_code: 0, latency_ms: 0, error: message } }))
    }, model)
  }

  function startProbe(model: string, routeID: number, template: ProbeTemplate) {
    if (!groupID) return
    const gid = groupID
    const key = modelTaskKey(gid, model, routeID, template.id)
    if (controllers.current.has(key)) return
    const plan = buildProbePlan(template, randomSeed())
    const patch = (fn: (old: ProbeRun) => Partial<ProbeRun>) =>
      setProbeRuns((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...fn(prev[key]) } } : prev))
    setProbeRuns((prev) => ({ ...prev, [key]: {
      template: { ...template }, expect: plan.expect, estimatedInputTokens: plan.estimatedInputTokens,
      samples: [], state: "queued", round: 0, total: plan.rounds.length, startedAt: Date.now(),
    } }))
    void track(key, async (signal) => {
      patch(() => ({ state: "running", startedAt: Date.now() }))
      await streamModelProbe(gid, buildProbeRequest(template, plan, model, routeID), signal, (ev) => {
        patch((old) => ({
          state: ev.stage === "done" ? "done" : ev.stage === "waiting" ? "waiting" : ev.stage === "error" ? "error" : "running",
          round: ev.sample?.round ?? ev.round ?? old.round,
          total: ev.total ?? old.total,
          label: ev.label ?? old.label,
          upstreamModel: ev.upstream_model ?? old.upstreamModel,
          upstreamPath: ev.upstream_path ?? old.upstreamPath,
          protocol: ev.protocol ?? old.protocol,
          samples: ev.sample ? [...old.samples, ev.sample] : old.samples,
          error: ev.error ?? old.error,
          finishedAt: ev.stage === "done" || ev.stage === "error" ? Date.now() : old.finishedAt,
        }))
      })
    }, (message, cancelled) => {
      patch(() => ({ state: cancelled ? "cancelled" : "error", error: cancelled ? undefined : message, finishedAt: Date.now() }))
    }, `${model} · ${template.name}`)
  }

  return {
    results: modelResults,
    isTesting,
    activeCount: active.length,
    concurrency,
    setConcurrency: (n: number) => {
      const v = Math.min(MAX_CONCURRENCY, Math.max(1, n))
      pool.current.setLimit(v)
      setConcurrencyState(v)
    },
    /** quick availability check on each route */
    run: (model: string, routes: number[]) => { for (const id of routes) startAvailability(model, id) },
    runProbe: (model: string, routes: number[], template: ProbeTemplate) => { for (const id of routes) startProbe(model, id, template) },
    probeRun: (model: string, routeID: number, testID: string) => groupID ? probeRuns[modelTaskKey(groupID, model, routeID, testID)] : undefined,
    clearProbe: (model: string, routeID: number, testID: string) => {
      if (!groupID) return
      const key = modelTaskKey(groupID, model, routeID, testID)
      if (controllers.current.has(key)) return
      setProbeRuns((prev) => { const next = { ...prev }; delete next[key]; return next })
    },
    cancel: (model: string, routeID: number, testID = "") => { if (groupID) controllers.current.get(modelTaskKey(groupID, model, routeID, testID))?.abort() },
    cancelModel: (model: string) => {
      for (const [key, c] of controllers.current) {
        const k = parseModelTaskKey(key)
        if (k.groupID === groupID && k.model === model) c.abort()
      }
    },
  }
}

export type ModelTests = ReturnType<typeof useModelTests>
