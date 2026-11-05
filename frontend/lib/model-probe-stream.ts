import { getToken, notifyUnauthorized } from "./api"
import type { GatewayProbeEvent, GatewayProbeRequest } from "./api-types"

export async function streamModelProbe(
  groupID: number,
  body: GatewayProbeRequest,
  signal: AbortSignal,
  onEvent: (event: GatewayProbeEvent) => void,
) {
  const token = getToken()
  const res = await fetch(`/api/gateway/groups/${groupID}/models/probe`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status === 401) notifyUnauthorized()
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  if (!res.body) throw new Error("浏览器不支持流式响应")
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let finished = false
  const consume = (block: string) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (!data) return
    const ev = JSON.parse(data) as GatewayProbeEvent
    onEvent(ev)
    if (ev.stage === "error") throw new Error(ev.error || "测试失败")
    if (ev.stage === "done") finished = true
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n")
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        consume(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
      }
      if (done) {
        if (buffer.trim()) consume(buffer)
        if (!finished) throw new Error("测试连接提前断开，可重新测试")
        return
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
