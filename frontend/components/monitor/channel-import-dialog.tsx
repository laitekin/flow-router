"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  ExternalLink,
  Globe,
  KeyRound,
  ListPlus,
  Loader2,
  LogIn,
  MousePointerClick,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type {
  Channel,
  ChannelDetectResult,
  ChannelPreviewResult,
  ChannelType,
} from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { useCaptchaConfigs } from "@/lib/queries"
import { syncChannelStream } from "@/lib/sync-stream"
import {
  BROWSER_IMPORT_SNIPPET,
  draftMissing,
  draftTokenCredential,
  emptyDraft,
  hostOf,
  parseImportJSON,
  parseImportLines,
  type ImportDraft,
} from "@/lib/channel-import"
import { cn } from "@/lib/utils"
import { SOFT } from "@/lib/soft-tone"
import { CaptchaProviderPicker } from "./captcha-provider-picker"
import { GroupCatalogView, formatUSD } from "./group-catalog-view"

interface ChannelImportDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 打开完整的手动表单（高级字段） */
  onOpenAdvanced?: () => void
}

type Method = "browser" | "password" | "token"

const TYPE_LABEL: Record<ChannelType, string> = { sub2api: "Sub2API", newapi: "NewAPI" }

// ---------------------------------------------------------------- API helpers

async function detectSite(siteURL: string, type?: ChannelType, proxy = false) {
  return apiFetch<ChannelDetectResult>("/channels/detect", {
    method: "POST",
    body: JSON.stringify({ site_url: siteURL, type: type ?? "", proxy_enabled: proxy }),
  })
}

interface ConnectOptions {
  type: ChannelType
  siteURL: string
  draft: ImportDraft
  turnstile: boolean
  captchaID: string
  proxy: boolean
}

function credentialBody(o: ConnectOptions) {
  const token = o.draft.credential_mode === "token"
  const useCaptcha = !token && o.turnstile
  return {
    type: o.type,
    site_url: o.siteURL,
    username: o.draft.username.trim(),
    credential_mode: o.draft.credential_mode,
    password: token ? "" : o.draft.password,
    token_credential: token ? draftTokenCredential(o.draft, o.type) : "",
    turnstile_enabled: useCaptcha,
    captcha_config_id: useCaptcha && o.captchaID ? Number(o.captchaID) : null,
    proxy_enabled: o.proxy,
  }
}

async function previewChannel(o: ConnectOptions) {
  if (o.draft.credential_mode === "password" && o.turnstile && !o.captchaID) {
    throw new Error("站点开启了 Turnstile 人机验证：请选择打码 provider，或改用「浏览器导入」免打码")
  }
  return apiFetch<ChannelPreviewResult>("/channels/preview", {
    method: "POST",
    body: JSON.stringify(credentialBody(o)),
  })
}

function isDuplicateNameError(e: unknown) {
  return /unique|duplicate/i.test((e as Error)?.message ?? "") && /name/i.test((e as Error)?.message ?? "")
}

async function createChannel(o: ConnectOptions, name: string, ticket?: string): Promise<Channel> {
  try {
    return await createChannelOnce(o, name, ticket)
  } catch (e) {
    if (isDuplicateNameError(e)) throw new Error(`渠道名「${name}」已存在，请换一个名字`)
    throw e
  }
}

/** 批量导入：重名时自动加后缀（账号 / 序号）再试。 */
async function createChannelUnique(o: ConnectOptions, name: string, ticket?: string): Promise<Channel> {
  const candidates = [name, o.draft.username ? `${name} · ${o.draft.username}` : "", `${name} 2`, `${name} 3`].filter(Boolean)
  let last: unknown
  for (const n of candidates) {
    try {
      return await createChannelOnce(o, n, ticket)
    } catch (e) {
      last = e
      if (!isDuplicateNameError(e)) throw e
    }
  }
  throw new Error(`渠道名「${name}」已存在：${(last as Error)?.message ?? ""}`)
}

async function createChannelOnce(o: ConnectOptions, name: string, ticket?: string) {
  const created = await apiFetch<Channel>("/channels", {
    method: "POST",
    body: JSON.stringify({
      ...credentialBody(o),
      name,
      sort_order: 1,
      login_extra_params: "",
      balance_threshold: 0,
      recharge_url: "",
      recharge_multiplier: 0,
      recharge_multiplier_mode: "divide",
      monitor_enabled: true,
      only_created_key_groups_enabled: false,
      ignore_announcements: false,
      subscription_enabled: false,
      preview_ticket: ticket ?? "",
    }),
  })
  // 立刻拉一次余额 + 分组倍率，卡片上马上能看到；失败不影响导入结果。
  void syncChannelStream(created.id, { onEvent: () => {} }).catch(() => {})
  return created
}

// ---------------------------------------------------------------- dialog

export function ChannelImportDialog({ open, onOpenChange, onOpenAdvanced }: ChannelImportDialogProps) {
  const [tab, setTab] = useState<"single" | "batch">("single")
  // 每次打开都给子组件一个新 key，状态自动清空
  const [session, setSession] = useState(0)
  useEffect(() => {
    if (open) setSession((s) => s + 1)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-1 sm:max-w-3xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className={cn("flex size-6 items-center justify-center rounded-md border", SOFT.blue.badge)}>
              <Sparkles className="size-3.5" />
            </span>
            快速导入渠道
          </DialogTitle>
          <DialogDescription>
            贴站点地址自动识别类型和人机验证；连接后先看分组、分组价格和分组下的模型，再决定保存。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-lg bg-muted p-0.5" role="tablist">
            {(
              [
                ["single", "单个导入"],
                ["batch", "批量导入"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-all",
                  tab === key
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {onOpenAdvanced ? (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                onOpenChange(false)
                onOpenAdvanced()
              }}
            >
              需要附加登录参数 / 充值倍率等？用完整表单
            </button>
          ) : null}
        </div>

        {tab === "single" ? (
          <SingleImport key={`s${session}`} active={open} onDone={() => onOpenChange(false)} />
        ) : (
          <BatchImport key={`b${session}`} active={open} />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- single

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums",
            done
              ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border bg-background text-muted-foreground",
          )}
        >
          {done ? <Check className="size-3" /> : n}
        </span>
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
      </div>
      <div className="min-w-0 pl-7">{children}</div>
    </section>
  )
}

function SingleImport({ active, onDone }: { active: boolean; onDone: () => void }) {
  const refresh = useTriggerRefresh()
  const captchas = useCaptchaConfigs(active)

  const [siteInput, setSiteInput] = useState("")
  const [detect, setDetect] = useState<ChannelDetectResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [typeOverride, setTypeOverride] = useState<ChannelType | undefined>()
  const [method, setMethod] = useState<Method>("browser")
  const [draft, setDraft] = useState<ImportDraft>(() => emptyDraft())
  const [pasteText, setPasteText] = useState("")
  const [turnstile, setTurnstile] = useState(false)
  const [captchaID, setCaptchaID] = useState("")
  const [proxy, setProxy] = useState(false)
  const [preview, setPreview] = useState<ChannelPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const autoPreview = useRef(false)

  const type = typeOverride ?? detect?.site?.type
  const siteURL = detect?.site_url ?? ""
  const site = detect?.site ?? null
  const effectiveDraft: ImportDraft = { ...draft, site_url: siteURL, credential_mode: method === "password" ? "password" : "token" }
  const missing = draftMissing(effectiveDraft, type)

  // 凭据变了，旧预览（及其会话票据）作废
  useEffect(() => {
    setPreview(null)
  }, [draft, method, type, turnstile, captchaID, proxy, siteURL])

  async function runDetect(raw: string, hint?: ChannelType) {
    const value = raw.trim()
    if (!value) return null
    setDetecting(true)
    setError(null)
    try {
      const res = await detectSite(value, hint, proxy)
      setDetect(res)
      setTurnstile(!!res.site?.turnstile_enabled)
      if (!name.trim()) setName(res.site?.site_name || hostOf(res.site_url))
      if (res.site?.turnstile_enabled && method === "password" && !draft.password) setMethod("browser")
      return res
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setDetecting(false)
    }
  }

  /** 粘贴了浏览器脚本导出的 JSON：站点、类型、token 一次填齐，并自动连接。 */
  function applyImportJSON(text: string): boolean {
    const parsed = parseImportJSON(text)
    if (!parsed) return false
    setDraft(parsed)
    setMethod("browser")
    setPasteText(text)
    setSiteInput(parsed.site_url)
    if (parsed.type) setTypeOverride(parsed.type)
    autoPreview.current = true
    void runDetect(parsed.site_url, parsed.type)
    return true
  }

  // 识别完成且凭据齐全时，自动连接一次（粘贴导入串的场景）
  useEffect(() => {
    if (!autoPreview.current || detecting || !siteURL || missing) return
    autoPreview.current = false
    void connect()
  }, [detecting, siteURL, missing])

  async function connect() {
    if (!type || missing) {
      setError(missing ?? "未识别站点类型")
      return
    }
    setPreviewing(true)
    setError(null)
    try {
      const res = await previewChannel({ type, siteURL, draft: effectiveDraft, turnstile, captchaID, proxy })
      setPreview(res)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPreviewing(false)
    }
  }

  async function save() {
    if (!type || !preview) return
    setSaving(true)
    setError(null)
    try {
      const created = await createChannel(
        { type, siteURL, draft: effectiveDraft, turnstile, captchaID, proxy },
        name.trim() || site?.site_name || hostOf(siteURL),
        preview.ticket,
      )
      toast.success(`已导入「${created.name}」，正在同步余额与分组倍率`)
      refresh()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const methodTabs: { key: Method; label: string; icon: typeof LogIn; hint: string }[] = [
    { key: "browser", label: "浏览器导入", icon: MousePointerClick, hint: "推荐 · 免密码免打码" },
    { key: "password", label: "账号密码", icon: LogIn, hint: site?.turnstile_enabled ? "需打码" : "自动续期" },
    { key: "token", label: "手动 Token", icon: KeyRound, hint: "粘贴令牌" },
  ]

  return (
    <div className="min-w-0 space-y-5">
      <Step n={1} title="站点" done={!!site}>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Globe className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={siteInput}
              onChange={(e) => setSiteInput(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text")
                if (applyImportJSON(text)) e.preventDefault()
              }}
              onBlur={() => {
                if (siteInput.trim() && hostOf(siteInput) !== hostOf(siteURL)) void runDetect(siteInput)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void runDetect(siteInput)
                }
              }}
              placeholder="https://站点地址 —— 也可以直接粘贴浏览器脚本复制的导入串"
              className="pl-8"
            />
          </div>
          <Button type="button" variant="outline" onClick={() => void runDetect(siteInput)} disabled={detecting || !siteInput.trim()}>
            {detecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            识别
          </Button>
        </div>

        {detect ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            {site ? (
              <>
                <span className={cn("rounded-md border px-1.5 py-0.5 font-medium", site.type === "newapi" ? SOFT.violet.badge : SOFT.blue.badge)}>
                  {TYPE_LABEL[site.type]}
                </span>
                {site.site_name ? <span className="text-muted-foreground">{site.site_name}</span> : null}
                <span className="text-muted-foreground">{siteURL}</span>
                {site.turnstile_enabled ? (
                  <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5", SOFT.amber.badge)}>
                    <ShieldCheck className="size-3" />
                    开启了 Turnstile 人机验证
                  </span>
                ) : (
                  <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5", SOFT.emerald.badge)}>
                    <Check className="size-3" />
                    无人机验证
                  </span>
                )}
                {site.oauth_providers?.length ? (
                  <span className="text-muted-foreground">支持 {site.oauth_providers.join(" / ")} 登录</span>
                ) : null}
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3" />
                {detect.error || "无法自动识别"}，请手动选择类型：
              </span>
            )}
            <span className="ml-auto inline-flex gap-1">
              {(["sub2api", "newapi"] as ChannelType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeOverride(t === site?.type ? undefined : t)}
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 transition-colors",
                    type === t
                      ? "border-foreground/25 bg-muted text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </span>
          </div>
        ) : null}
      </Step>

      <Step n={2} title="登录方式" done={!!preview}>
        <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
          {methodTabs.map(({ key, label, icon: Icon, hint }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMethod(key)}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-xs transition-all sm:flex-row sm:justify-center sm:gap-1.5",
                method === key
                  ? "bg-background text-foreground shadow-xs ring-1 ring-border/60"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className={cn("size-3.5", method === key ? SOFT.blue.text : "")} />
              <span className="font-medium">{label}</span>
              <span
                className={cn(
                  "text-[10px]",
                  key === "browser" ? SOFT.emerald.text : key === "password" && site?.turnstile_enabled ? SOFT.amber.text : "text-muted-foreground",
                )}
              >
                {hint}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3">
          {method === "browser" ? (
            <BrowserImportPanel
              siteURL={siteURL}
              type={type}
              pasteText={pasteText}
              onPasteText={(text) => {
                setPasteText(text)
                const parsed = parseImportJSON(text)
                if (parsed) {
                  if (parsed.site_url && hostOf(parsed.site_url) !== hostOf(siteURL)) {
                    applyImportJSON(text)
                  } else {
                    setDraft(parsed)
                    if (parsed.type) setTypeOverride(parsed.type)
                    autoPreview.current = true
                  }
                }
              }}
              parsed={draft.access_token ? draft : null}
            />
          ) : method === "password" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="imp-user">账号 / 邮箱</Label>
                  <Input id="imp-user" value={draft.username} autoComplete="off" onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="imp-pass">密码</Label>
                  <Input id="imp-pass" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
                </div>
              </div>
              {site && !site.password_login_enabled ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">该站点关闭了密码登录，请用「浏览器导入」。</p>
              ) : null}
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Turnstile 人机验证</p>
                  <p className="text-[11px] text-muted-foreground">
                    {site ? (site.turnstile_enabled ? "已自动识别：站点开启了人机验证" : "已自动识别：站点未开启") : "识别站点后自动设置"}
                  </p>
                </div>
                <Switch checked={turnstile} onCheckedChange={setTurnstile} />
              </div>
              {turnstile ? (
                <div className="space-y-1.5">
                  <Label htmlFor="imp-captcha">打码 provider</Label>
                  <CaptchaProviderPicker
                    id="imp-captcha"
                    value={captchaID}
                    onChange={setCaptchaID}
                    configs={captchas.data}
                    loading={captchas.loading}
                    onCreated={() => captchas.refetch()}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    每次登录都会消耗一次打码。不想配打码？
                    <button type="button" className="text-foreground underline underline-offset-2" onClick={() => setMethod("browser")}>
                      改用浏览器导入
                    </button>
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <TokenFields type={type} draft={draft} onChange={setDraft} />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void connect()} disabled={previewing || !!missing || detecting}>
            {previewing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {preview ? "重新连接" : "连接并预览分组"}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={proxy} onCheckedChange={setProxy} className="scale-90" />
            走代理 IP
          </label>
          {missing && siteURL && !previewing ? <span className="text-[11px] text-muted-foreground">{missing}</span> : null}
        </div>
      </Step>

      {error ? (
        <p className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", SOFT.rose.badge)} role="alert">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {preview ? (
        <Step n={3} title="分组 · 价格 · 模型">
          <div className="mb-2 grid grid-cols-3 gap-2">
            <Stat label="余额" value={preview.balance != null ? formatUSD(preview.balance) : "—"} hint={preview.balance_error} />
            <Stat label="分组" value={String(preview.groups.length)} hint={preview.groups_error} />
            <Stat
              label="最低分组倍率"
              value={preview.groups.length ? `×${Math.min(...preview.groups.map((g) => g.ratio))}` : "—"}
            />
          </div>
          <GroupCatalogView groups={preview.groups} />

          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="imp-name">渠道名</Label>
              <Input id="imp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={site?.site_name || hostOf(siteURL)} />
            </div>
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              保存渠道
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">直接复用刚才的登录会话，不会再登录 / 打码第二次；保存后自动同步余额与倍率。</p>
        </Step>
      ) : null}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2" title={hint}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-sm font-semibold tabular-nums", hint && "text-amber-700 dark:text-amber-300")}>{hint ? "获取失败" : value}</p>
    </div>
  )
}

function BrowserImportPanel({
  siteURL,
  type,
  pasteText,
  onPasteText,
  parsed,
}: {
  siteURL: string
  type?: ChannelType
  pasteText: string
  onPasteText: (v: string) => void
  parsed: ImportDraft | null
}) {
  const [copied, setCopied] = useState(false)
  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(BROWSER_IMPORT_SNIPPET)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error("复制失败，请手动选中脚本复制")
    }
  }
  return (
    <div className="space-y-2.5 text-xs">
      <ol className="space-y-2">
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground">①</span>
          <span>
            在浏览器里打开{" "}
            {siteURL ? (
              <a href={`${siteURL}/login`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2">
                {hostOf(siteURL)}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              "上游站点"
            )}{" "}
            并正常登录（人机验证、两步验证、第三方登录都由你自己完成）
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground">②</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p>
              在该站点按 <kbd className="rounded border border-border bg-muted px-1">F12</kbd> → Console，粘贴下面脚本回车（Chrome 首次粘贴需先输入
              <code className="mx-0.5 rounded bg-muted px-1">allow pasting</code>）
            </p>
            <div className="relative">
              <pre className="max-h-24 max-w-full overflow-auto rounded-md border border-border bg-muted/50 p-2 pr-24 font-mono text-[10px] leading-snug whitespace-pre-wrap break-all text-muted-foreground">
                {BROWSER_IMPORT_SNIPPET}
              </pre>
              <Button type="button" size="sm" variant="secondary" className="absolute top-1.5 right-1.5 h-7 gap-1 text-[11px]" onClick={() => void copySnippet()}>
                {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
                {copied ? "已复制" : "复制脚本"}
              </Button>
            </div>
            {type === "newapi" ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                NewAPI 会重新生成「系统访问令牌」，旧的系统访问令牌（如有）会失效；API 密钥不受影响。
              </p>
            ) : null}
          </div>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground">③</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p>脚本会把登录凭据复制到剪贴板，回来粘贴到这里（也可以直接粘到上面的站点输入框）</p>
            <Textarea
              value={pasteText}
              onChange={(e) => onPasteText(e.target.value)}
              placeholder='{"flow_router_import":1, ...}'
              rows={2}
              className="field-sizing-fixed font-mono text-[11px] break-all"
            />
            {parsed ? (
              <p className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                <Check className="size-3" />
                已识别 {parsed.type ? TYPE_LABEL[parsed.type] : ""} 凭据{parsed.username ? ` · ${parsed.username}` : ""}
                {parsed.refresh_token ? " · 含 refresh_token（可自动续期）" : ""}
              </p>
            ) : pasteText.trim() ? (
              <p className="text-[11px] text-destructive">这段内容不是导入串，请重新运行脚本复制</p>
            ) : null}
          </div>
        </li>
      </ol>
    </div>
  )
}

function TokenFields({ type, draft, onChange }: { type?: ChannelType; draft: ImportDraft; onChange: (d: ImportDraft) => void }) {
  if (!type) return <p className="text-xs text-muted-foreground">先识别站点类型</p>
  if (type === "newapi") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem]">
        <div className="space-y-1">
          <Label htmlFor="imp-at">系统访问令牌</Label>
          <Input id="imp-at" className="font-mono text-xs" value={draft.access_token} onChange={(e) => onChange({ ...draft, access_token: e.target.value })} placeholder="个人设置 → 生成系统访问令牌" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="imp-uid">User ID</Label>
          <Input id="imp-uid" value={draft.user_id} onChange={(e) => onChange({ ...draft, user_id: e.target.value })} placeholder="整数" />
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor="imp-at">Access Token</Label>
        <Textarea id="imp-at" rows={2} className="field-sizing-fixed font-mono text-[11px] break-all" value={draft.access_token} onChange={(e) => onChange({ ...draft, access_token: e.target.value })} placeholder="localStorage.auth_token" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="imp-rt">Refresh Token（建议填，用于自动续期）</Label>
        <Textarea id="imp-rt" rows={2} className="field-sizing-fixed font-mono text-[11px] break-all" value={draft.refresh_token} onChange={(e) => onChange({ ...draft, refresh_token: e.target.value })} placeholder="localStorage.refresh_token" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- batch

type RowStatus = "pending" | "working" | "ready" | "error" | "saved"

interface BatchRow {
  key: number
  draft: ImportDraft
  type?: ChannelType
  siteURL?: string
  siteName?: string
  turnstile?: boolean
  status: RowStatus
  message?: string
  preview?: ChannelPreviewResult
}

let rowSeq = 0

function BatchImport({ active }: { active: boolean }) {
  const refresh = useTriggerRefresh()
  const captchas = useCaptchaConfigs(active)
  const [text, setText] = useState("")
  const [rows, setRows] = useState<BatchRow[]>([])
  const [captchaID, setCaptchaID] = useState("")
  const [proxy, setProxy] = useState(false)
  const [running, setRunning] = useState(false)
  const [openRow, setOpenRow] = useState<number | null>(null)

  const readyCount = rows.filter((r) => r.status === "ready").length
  const needCaptcha = rows.some((r) => r.turnstile && r.draft.credential_mode === "password")

  function parse() {
    const drafts = parseImportLines(text)
    if (drafts.length === 0) {
      toast.error("没有解析到任何一行")
      return
    }
    setRows((prev) => [
      ...prev,
      ...drafts.map<BatchRow>((d) => ({ key: ++rowSeq, draft: d, type: d.type, status: "pending" })),
    ])
    setText("")
  }

  function patch(key: number, p: Partial<BatchRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }

  async function checkAll() {
    setRunning(true)
    // 顺序执行：同站点并发登录容易触发风控；打码也按量计费
    for (const row of rows) {
      if (row.status === "saved" || row.status === "ready") continue
      patch(row.key, { status: "working", message: "识别站点…" })
      try {
        const det = await detectSite(row.draft.site_url, row.type, proxy)
        const type = row.type ?? det.site?.type
        const turnstile = !!det.site?.turnstile_enabled
        patch(row.key, { siteURL: det.site_url, siteName: det.site?.site_name, type, turnstile })
        if (!type) throw new Error(det.error || "无法识别站点类型")
        const missing = draftMissing({ ...row.draft, site_url: det.site_url }, type)
        if (missing) throw new Error(missing)
        patch(row.key, { message: turnstile && row.draft.credential_mode === "password" ? "打码并登录…" : "登录并读取分组…" })
        const preview = await previewChannel({
          type,
          siteURL: det.site_url,
          draft: row.draft,
          turnstile,
          captchaID,
          proxy,
        })
        patch(row.key, {
          status: "ready",
          preview,
          message: `${preview.groups.length} 个分组${preview.balance != null ? ` · 余额 ${formatUSD(preview.balance)}` : ""}`,
        })
      } catch (e) {
        patch(row.key, { status: "error", message: (e as Error).message })
      }
    }
    setRunning(false)
  }

  async function importReady() {
    setRunning(true)
    let ok = 0
    const usedNames = new Set<string>()
    for (const row of rows) {
      if (row.status !== "ready" || !row.type || !row.siteURL) continue
      let name = row.siteName || hostOf(row.siteURL)
      if (usedNames.has(name) && row.draft.username) name = `${name} · ${row.draft.username}`
      usedNames.add(name)

      try {
        const created = await createChannelUnique(
          { type: row.type, siteURL: row.siteURL, draft: row.draft, turnstile: !!row.turnstile, captchaID, proxy },
          name,
          row.preview?.ticket,
        )
        patch(row.key, { status: "saved", message: `已导入为「${created.name}」` })
        ok++
      } catch (e) {
        patch(row.key, { status: "error", message: (e as Error).message })
      }
    }
    setRunning(false)
    if (ok > 0) {
      toast.success(`已导入 ${ok} 个渠道`)
      refresh()
    }
  }

  const statusTone: Record<RowStatus, string> = {
    pending: "text-muted-foreground",
    working: SOFT.sky.text,
    ready: SOFT.emerald.text,
    error: SOFT.rose.text,
    saved: SOFT.emerald.text,
  }

  const openPreview = useMemo(() => rows.find((r) => r.key === openRow)?.preview ?? null, [rows, openRow])

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1.5">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="field-sizing-fixed font-mono text-xs"
          placeholder={[
            "每行一个账号，分隔符可用 空格 / 逗号 / | / ----：",
            "https://a.example.com  user@mail.com  password",
            "b.example.com,user2,password2",
            '{"flow_router_import":1,...}   ← 浏览器脚本复制的导入串也行',
          ].join("\n")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={parse} disabled={!text.trim() || running}>
            <ListPlus className="size-3.5" />
            加入列表
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={proxy} onCheckedChange={setProxy} className="scale-90" />
            走代理 IP
          </label>
        </div>
      </div>

      {rows.length > 0 ? (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="w-14 shrink-0">
                    {r.type ? (
                      <span className={cn("rounded border px-1 py-0.5 text-[10px] font-medium", r.type === "newapi" ? SOFT.violet.badge : SOFT.blue.badge)}>
                        {TYPE_LABEL[r.type]}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">待识别</span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {r.siteName || hostOf(r.draft.site_url)}
                      {r.turnstile ? <ShieldCheck className={cn("ml-1 inline size-3", SOFT.amber.text)} aria-label="Turnstile" /> : null}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {r.draft.credential_mode === "token" ? "Token" : r.draft.username || "（无账号）"}
                    </p>
                  </div>
                  <p className={cn("min-w-0 flex-[1.4] truncate text-[11px]", statusTone[r.status])} title={r.message}>
                    {r.status === "working" ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null}
                    {r.message ?? "待检测"}
                  </p>
                  {r.preview ? (
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setOpenRow(openRow === r.key ? null : r.key)}>
                      {openRow === r.key ? "收起" : "看分组"}
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                    disabled={running}
                    onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                    aria-label="移除"
                  >
                    {r.status === "saved" ? <X className="size-3.5" /> : <Trash2 className="size-3.5" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {openPreview ? <GroupCatalogView groups={openPreview.groups} maxHeightClass="max-h-64" /> : null}

          {needCaptcha ? (
            <div className="space-y-1.5">
              <Label>开启 Turnstile 的站点用这个打码 provider</Label>
              <CaptchaProviderPicker
                value={captchaID}
                onChange={setCaptchaID}
                configs={captchas.data}
                loading={captchas.loading}
                onCreated={() => captchas.refetch()}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <span className="mr-auto text-[11px] text-muted-foreground">逐个识别 + 登录预览，确认无误后再导入；导入时复用预览的登录会话。</span>
            <Button type="button" variant="outline" onClick={() => void checkAll()} disabled={running}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              检测全部
            </Button>
            <Button type="button" onClick={() => void importReady()} disabled={running || readyCount === 0}>
              <Check className="size-3.5" />
              导入 {readyCount} 个
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
