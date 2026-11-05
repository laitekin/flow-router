import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api"
import { streamModelCacheTest } from "@/lib/model-cache-stream"
import type { GatewayCacheTestSample, GatewayModelTestResponse, GatewayModelTestResult } from "@/lib/api-types"
import { ModelTestPool, modelTaskKey } from "./model-test-tasks"

export interface CacheTestRun {
  samples: GatewayCacheTestSample[]
  state: "queued" | "running" | "waiting" | "done" | "cancelled" | "error"
  round: number
  total: number
  label?: string
  upstreamModel?: string
  upstreamPath?: string
  error?: string
}

export function useModelTests(groupID?: number) {
  const pool = useRef(new ModelTestPool(3))
  const controllers = useRef(new Map<string, AbortController>())
  const [active, setActive] = useState<string[]>([])
  const [results, setResults] = useState<Record<string, GatewayModelTestResult>>({})
  const [cacheRuns, setCacheRuns] = useState<Record<string, CacheTestRun>>({})
  useEffect(() => {
    const requests = controllers.current
    return () => { for (const c of requests.values()) c.abort(); requests.clear() }
  }, [])

  const isTesting = (model: string, routeID?: number) => active.some((key) => {
    const [gid, mid, rid] = JSON.parse(key) as [number, string, number]
    return gid === groupID && mid === model && (routeID == null || rid === routeID)
  })
  const modelResults = useMemo(() => {
    const byModel: Record<string, GatewayModelTestResult[]> = {}
    for (const [key, result] of Object.entries(results)) {
      const [gid, model] = JSON.parse(key) as [number, string]
      if (gid === groupID) (byModel[model] ??= []).push(result)
    }
    return byModel
  }, [results, groupID])

  async function start(model: string, routeID: number, cache?: { protocol: string; interval_sec: number }) {
    if (!groupID) return
    const gid = groupID
    const key = modelTaskKey(gid, model, routeID)
    if (controllers.current.has(key)) return
    const controller = new AbortController()
    controllers.current.set(key, controller)
    setActive((prev) => [...prev, key])
    if (cache) setCacheRuns((prev) => ({ ...prev, [key]: { samples: [], state: "queued", round: 0, total: 5 } }))
    try {
      await pool.current.run(controller.signal, async () => {
        if (cache) {
          await streamModelCacheTest(gid, { model, route_id: routeID, ...cache }, controller.signal, (ev) => {
            setCacheRuns((prev) => {
              const old = prev[key]
              if (!old) return prev
              return { ...prev, [key]: {
                ...old,
                state: ev.stage === "done" ? "done" : ev.stage === "waiting" ? "waiting" : ev.stage === "error" ? "error" : "running",
                round: ev.sample?.round ?? ev.round ?? old.round,
                total: ev.total ?? old.total,
                label: ev.label ?? old.label,
                upstreamModel: ev.upstream_model ?? old.upstreamModel,
                upstreamPath: ev.upstream_path ?? old.upstreamPath,
                samples: ev.sample ? [...old.samples, ev.sample] : old.samples,
                error: ev.error ?? old.error,
              } }
            })
          })
        } else {
          const res = await apiFetch<GatewayModelTestResponse>(`/gateway/groups/${gid}/models/test`, {
            method: "POST", body: JSON.stringify({ model, route_id: routeID }), signal: controller.signal,
          })
          if (controller.signal.aborted) return
          const item = res.items?.[0]
          if (item) setResults((prev) => ({ ...prev, [key]: item }))
          else throw new Error("没有可测试的已保存线路")
        }
      })
    } catch (error) {
      const cancelled = controller.signal.aborted
      const message = error instanceof Error ? error.message : "测试失败"
      if (cache) setCacheRuns((prev) => ({ ...prev, [key]: { ...prev[key], state: cancelled ? "cancelled" : "error", error: cancelled ? undefined : message } }))
      else if (!cancelled) setResults((prev) => ({ ...prev, [key]: { route_id: routeID, channel_id: 0, label: "", requested_model: model, upstream_model: model, ok: false, status_code: 0, latency_ms: 0, error: message } }))
      if (!cancelled) toast.error(`${model}：${message}`)
    } finally {
      controllers.current.delete(key)
      setActive((prev) => prev.filter((x) => x !== key))
    }
  }

  return {
    results: modelResults, isTesting, activeCount: active.length,
    run: (model: string, routes: number[]) => { for (const id of routes) void start(model, id) },
    runCache: (model: string, routeID: number, protocol: string, interval_sec: number) => void start(model, routeID, { protocol, interval_sec }),
    cacheRun: (model: string, routeID: number) => groupID ? cacheRuns[modelTaskKey(groupID, model, routeID)] : undefined,
    cancel: (model: string, routeID: number) => { if (groupID) controllers.current.get(modelTaskKey(groupID, model, routeID))?.abort() },
  }
}
