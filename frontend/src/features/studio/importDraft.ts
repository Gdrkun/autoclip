import { defaultImportOptions, type ImportOptions } from './types'

export interface ImportDraft {
  source: 'link' | 'file'; url: string; options: ImportOptions; browser: string; platforms: string[]
  file: File | null; subtitle: File | null; fileName: string; subtitleName: string
}
const key = 'autoclip.importDraft.v1'
let current: ImportDraft | null = null
const text = (value: unknown, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : ''
function choice<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}
export function normalizeImportOptions(value: Partial<ImportOptions> = {}): ImportOptions {
  return {
    goal: choice(value.goal, ['auto', 'content', 'highlight', 'promo'], 'auto'),
    language: choice(value.language, ['source', 'zh', 'en', 'ja'], 'source'),
    aspect: choice(value.aspect, ['original', 'portrait', 'landscape', null], null),
    duration: choice(value.duration, [15, 30, 60, 90, 120, null], null),
    instruction: text(value.instruction), background_query: text(value.background_query),
    detect_singing: value.detect_singing === true, visual_reactions: value.visual_reactions === true,
    reaction_budget: choice(value.reaction_budget, [4, 8, 12], 8),
    auto_render_limit: choice(value.auto_render_limit, [1, 3, 10] as const, 3), quick_preview: value.quick_preview === true,
    portrait_style: choice(value.portrait_style, ['auto', 'interview', 'podcast'] as const, 'auto'),
    html_template: choice(value.html_template, ['editorial', 'street', 'classic', undefined] as const, undefined),
  }
}

/** Files stay in this tab's memory; session storage only keeps names and form fields. */
export function loadImportDraft(): ImportDraft | null {
  if (current) return current
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null')
    if (!value || value.version !== 1 || !value.options || typeof value.options !== 'object') return null
    const platforms = Array.isArray(value.platforms) ? value.platforms.filter((id: unknown) => typeof id === 'string' && /^[a-z_]{1,40}$/.test(id)) : []
    current = { source: value.source === 'file' ? 'file' : 'link', url: text(value.url, 10000), options: normalizeImportOptions(value.options),
      browser: choice(value.browser, ['', 'chrome', 'edge', 'safari', 'firefox'], ''), platforms: platforms.length ? [...new Set<string>(platforms)] : ['douyin'],
      file: null, subtitle: null, fileName: text(value.fileName, 255), subtitleName: text(value.subtitleName, 255) }
    return current
  } catch { return null }
}

export function saveImportDraft(value: ImportDraft) {
  const meaningful = value.url.trim() || value.fileName || value.subtitleName || value.source !== 'link'
    || value.browser || JSON.stringify(value.platforms) !== '["douyin"]'
    || JSON.stringify(normalizeImportOptions(value.options)) !== JSON.stringify(normalizeImportOptions(defaultImportOptions))
  if (!meaningful) { clearImportDraft(); return }
  current = value
  const { file, subtitle, ...fields } = value
  try { sessionStorage.setItem(key, JSON.stringify({ ...fields, version: 1 })) } catch { /* In-memory navigation recovery remains available. */ }
}

export function clearImportDraft() {
  current = null
  try { sessionStorage.removeItem(key) } catch { /* Storage can be unavailable. */ }
}
