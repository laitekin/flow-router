import { Component, type ReactNode } from "react"

export function LoadingPanel({ fullPage = false, label = "页面加载中…" }: { fullPage?: boolean; label?: string }) {
  return <div role="status" aria-live="polite"
    className={`flex items-center justify-center rounded-lg border border-border bg-background p-6 text-sm text-muted-foreground ${fullPage ? "min-h-screen" : "min-h-48"}`}>
    {label}
  </div>
}

// A stale deployment chunk or a temporary network failure must not leave a
// blank page. Refresh is explicit, never automatic while a form is being edited.
export class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <section role="alert" className="mx-auto my-6 max-w-xl space-y-3 rounded-lg border border-border bg-background p-6 text-foreground">
      <h2 className="text-base font-semibold">页面暂时无法加载</h2>
      <p className="text-sm leading-6 text-muted-foreground">可能是网络中断或页面版本更新。请确认网络后刷新重试；刷新会丢弃尚未保存的输入。</p>
      <button type="button" onClick={() => window.location.reload()}
        className="min-h-11 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        刷新页面重试
      </button>
    </section>
  }
}
