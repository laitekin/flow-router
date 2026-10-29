import { lazy, Suspense } from "react"
import { LoadBoundary, LoadingPanel } from "@/components/load-boundary"
import { OverviewPanel } from "@/components/monitor/overview-panel"
import { ChannelCards } from "@/components/monitor/channel-cards"
import { BottomPanels } from "@/components/monitor/bottom-panels"
const DispatchHealthPanel = lazy(() => import("@/components/monitor/dispatch-health-panel").then((m) => ({ default: m.DispatchHealthPanel })))

export default function Page() {
  return (
    <>
      <OverviewPanel />

      <LoadBoundary><Suspense fallback={<LoadingPanel label="调度图加载中…" />}><DispatchHealthPanel /></Suspense></LoadBoundary>

      <ChannelCards />

      <BottomPanels />
    </>
  )
}
