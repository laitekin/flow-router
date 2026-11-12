import type { ChannelType } from "@/lib/api-types"

/**
 * 快速导入的纯函数部分（解析粘贴内容、生成浏览器脚本），不依赖 React，便于单测。
 */

export type ImportCredentialMode = "password" | "token"

/** 一条待导入的渠道草稿。 */
export interface ImportDraft {
  site_url: string
  type?: ChannelType
  credential_mode: ImportCredentialMode
  username: string
  password: string
  /** token 模式：Sub2API access_token / NewAPI 系统访问令牌 */
  access_token: string
  /** token 模式：Sub2API refresh_token */
  refresh_token: string
  /** token 模式：NewAPI 用户 ID */
  user_id: string
}

export function emptyDraft(partial: Partial<ImportDraft> = {}): ImportDraft {
  return {
    site_url: "",
    credential_mode: "password",
    username: "",
    password: "",
    access_token: "",
    refresh_token: "",
    user_id: "",
    ...partial,
  }
}

/** 浏览器脚本复制出来的 JSON 标记字段。 */
export const IMPORT_MARKER = "flow_router_import"

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""
}

/** 解析浏览器脚本导出的一条 JSON；不是导入串返回 null。 */
export function parseImportJSON(raw: string): ImportDraft | null {
  const text = raw.trim()
  if (!text.startsWith("{")) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object" || !(IMPORT_MARKER in obj)) return null
  const type = str(obj.type)
  return emptyDraft({
    site_url: str(obj.site_url),
    type: type === "newapi" || type === "sub2api" ? type : undefined,
    credential_mode: "token",
    username: str(obj.username),
    access_token: str(obj.access_token),
    refresh_token: str(obj.refresh_token),
    user_id: str(obj.user_id),
  })
}

/**
 * 解析批量文本：每行一条。
 *  - 浏览器脚本导出的 JSON
 *  - `站点 账号 密码`（分隔符可以是空格 / 逗号 / 竖线 / 制表符 / ----）
 *  - 只有站点（之后再填凭据）
 * 空行与 # 开头的注释行忽略。
 */
export function parseImportLines(text: string): ImportDraft[] {
  const out: ImportDraft[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const json = parseImportJSON(line)
    if (json) {
      out.push(json)
      continue
    }
    const parts = line.split(/\s*(?:----|[,，|｜\t]|\s)\s*/).filter(Boolean)
    if (parts.length === 0) continue
    const [site, username = "", ...rest] = parts
    out.push(emptyDraft({ site_url: site, username, password: rest.join(" ") }))
  }
  return out
}

/** 后端 token_credential JSON。 */
export function draftTokenCredential(draft: ImportDraft, type: ChannelType): string {
  if (type === "newapi") {
    return JSON.stringify({ access_token: draft.access_token.trim(), user_id: draft.user_id.trim() })
  }
  const refresh = draft.refresh_token.trim()
  return JSON.stringify({
    access_token: draft.access_token.trim(),
    ...(refresh ? { refresh_token: refresh } : {}),
  })
}

/** 草稿凭据是否填全；返回缺失项说明，填全返回 null。 */
export function draftMissing(draft: ImportDraft, type: ChannelType | undefined): string | null {
  if (!draft.site_url.trim()) return "缺少站点地址"
  if (!type) return "未识别站点类型"
  if (draft.credential_mode === "password") {
    if (!draft.username.trim()) return "缺少账号"
    if (!draft.password) return "缺少密码"
    return null
  }
  if (!draft.access_token.trim()) return type === "newapi" ? "缺少系统访问令牌" : "缺少 Access Token"
  if (type === "newapi" && !draft.user_id.trim()) return "缺少 User ID"
  return null
}

export function hostOf(siteURL: string): string {
  try {
    return new URL(siteURL.includes("://") ? siteURL : `https://${siteURL}`).host
  } catch {
    return siteURL
  }
}

/**
 * 在「已登录的上游站点」页面 DevTools Console 里运行的脚本：
 *  - Sub2API：读 localStorage 的 auth_token / refresh_token
 *  - NewAPI：用当前登录态调 /api/user/token 生成「系统访问令牌」+ 读 user.id
 * 结果复制到剪贴板（DevTools 的 copy()，不可用时弹窗让用户手动复制）。
 * 整个过程只在用户自己的浏览器里发生，不经过任何第三方。
 */
export const BROWSER_IMPORT_SNIPPET = `(async () => {
  const ls = localStorage, out = { ${IMPORT_MARKER}: 1, site_url: location.origin };
  const parse = (k) => { try { return JSON.parse(ls.getItem(k) || "null"); } catch { return null; } };
  if (ls.getItem("auth_token")) {
    const u = parse("auth_user") || {};
    Object.assign(out, { type: "sub2api", access_token: ls.getItem("auth_token"), refresh_token: ls.getItem("refresh_token") || "", username: u.email || u.username || "" });
  } else {
    const u = parse("user");
    if (!u || !u.id) { alert("没检测到登录状态：请先在本站登录，再运行脚本"); return; }
    const headers = { "New-Api-User": String(u.id) };
    const bearer = ls.getItem("access_token") || ls.getItem("token");
    if (bearer) headers.Authorization = "Bearer " + bearer;
    const r = await fetch("/api/user/token", { headers, credentials: "include" }).then((x) => x.json()).catch((e) => ({ message: String(e) }));
    if (!r || !r.success || !r.data) { alert("生成系统访问令牌失败：" + ((r && r.message) || "未知错误")); return; }
    Object.assign(out, { type: "newapi", access_token: r.data, user_id: String(u.id), username: u.username || "" });
  }
  const text = JSON.stringify(out);
  if (typeof copy === "function") { copy(text); alert("已复制，回到 Flow Router 粘贴即可"); }
  else { prompt("复制下面这段，回到 Flow Router 粘贴：", text); }
})();`
