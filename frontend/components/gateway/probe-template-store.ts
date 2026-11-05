import { BUILTIN_TEMPLATES, normalizeTemplate, newTemplateID, type ProbeTemplate } from "./probe-presets.ts"

/**
 * Personal probe templates live in this browser's localStorage. Built-ins are
 * never stored; editing one and saving creates a personal copy. Everything is
 * wrapped in try/catch so private windows or blocked storage still work.
 */
const KEY = "flow-router:probe-templates:v1"
const LAST_KEY = "flow-router:probe-last-template:v1"

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const defaultStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function loadUserTemplates(storage = defaultStorage()): ProbeTemplate[] {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list.map((t) => ({ ...normalizeTemplate(t), builtin: undefined })).filter((t) => t.id.startsWith("user:")) : []
  } catch {
    return []
  }
}

export function saveUserTemplates(list: ProbeTemplate[], storage = defaultStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(list.map((t) => ({ ...t, builtin: undefined }))))
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

export function loadLastTemplateID(storage = defaultStorage()) {
  try {
    return storage?.getItem(LAST_KEY) || ""
  } catch {
    return ""
  }
}

export function saveLastTemplateID(id: string, storage = defaultStorage()) {
  try {
    storage?.setItem(LAST_KEY, id)
  } catch {
    /* ignore */
  }
}

export function allTemplates(user: ProbeTemplate[]) {
  return [...BUILTIN_TEMPLATES, ...user]
}

/** Upsert by id. A built-in (or unsaved draft of one) becomes a new personal template. */
export function upsertUserTemplate(list: ProbeTemplate[], t: ProbeTemplate, name?: string): { list: ProbeTemplate[]; saved: ProbeTemplate } {
  const asNew = t.builtin || !t.id.startsWith("user:") || name != null
  const saved = normalizeTemplate({ ...t, builtin: undefined, id: asNew ? newTemplateID() : t.id, name: name ?? t.name })
  const idx = list.findIndex((x) => x.id === saved.id)
  const next = idx >= 0 ? list.map((x, i) => (i === idx ? saved : x)) : [...list, saved]
  return { list: next, saved }
}

export function exportTemplates(list: ProbeTemplate[]) {
  return JSON.stringify({ version: 1, templates: list.map((t) => ({ ...t, builtin: undefined })) }, null, 2)
}

/** Imported templates always get fresh IDs so they never overwrite existing ones. */
export function importTemplates(list: ProbeTemplate[], json: string): { list: ProbeTemplate[]; added: number } {
  const parsed = JSON.parse(json)
  const raw: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.templates) ? parsed.templates : [parsed]
  const added = raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .slice(0, 100)
    .map((x) => normalizeTemplate({ ...x, id: newTemplateID(), builtin: undefined }))
  if (!added.length) throw new Error("文件里没有可导入的模板")
  return { list: [...list, ...added], added: added.length }
}
