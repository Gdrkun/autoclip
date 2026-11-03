import type { BackgroundReference } from './CharacterBackground'

export type CharacterProfile = { id: string; name: string; aliases: string[]; background: string; memes: string; sources: BackgroundReference[]; updated_at?: string }
export type VocabularyTerm = { correct: string; variants: string[]; scope: string }
export type LibraryFeedback = { id: string; query: string; direction: 'more' | 'less'; category: string; title: string; note: string; excerpt?: string }
export type Library = { schema_version: 1; revision: number; profiles: CharacterProfile[]; terms: VocabularyTerm[]; feedback: LibraryFeedback[]; updated_at?: string }
export type LibraryConflict = { key: string; section: string; id: string; field: string; local: unknown; saved: unknown }
export const emptyLibrary: Library = { schema_version: 1, revision: 0, profiles: [], terms: [], feedback: [] }
export const normalName = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}_]/gu, '')
const content = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(content)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['revision', 'updated_at'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, content(child)]))
}
export const sameContent = (a: unknown, b: unknown) => JSON.stringify(content(a)) === JSON.stringify(content(b))
export function containsReferences(library: Library | null, sources: BackgroundReference[]) {
  return sources.length > 0 && !!library && sources.every(source => library.profiles.some(profile =>
    [profile.name, ...profile.aliases].some(name => normalName(name) === normalName(source.subject)) &&
    profile.sources.some(saved => saved.url === source.url)))
}
export function libraryValidation(value: Library): string {
  const names = new Set<string>()
  for (const profile of value.profiles) {
    const keys = new Set([profile.name, ...profile.aliases].map(normalName))
    if (!normalName(profile.name)) return '请为每个档案填写角色名称'
    if (profile.aliases.length > 20 || profile.aliases.some(alias => !normalName(alias) || alias.length > 100)) return '每个角色最多 20 个别名，每个别名最多 100 字'
    if ([...keys].some(name => names.has(name))) return '角色名称或别名重复，请修改后保存'
    keys.forEach(name => names.add(name))
  }
  for (const term of value.terms) {
    if (!term.correct.trim()) return '请填写词条的正确写法'
    if (term.variants.length > 20 || term.variants.some(word => word.trim().length < 2 || word.length > 80 || word === term.correct)) return '易错写法应为 2 至 80 字，且不能与正确写法相同'
  }
  return ''
}

export function rebaseLibrary(base: Library, draft: Library, current: Library, choices: Record<string, 'local' | 'saved'> = {}) {
  const conflicts: LibraryConflict[] = []
  const choose = (before: unknown, local: unknown, saved: unknown, section: string, id = '', field = '') => {
    if (sameContent(local, before)) return saved
    if (sameContent(saved, before) || sameContent(saved, local)) return local
    const key = [section, id, field].join(':')
    if (!choices[key]) conflicts.push({ key, section, id, field, local, saved })
    return choices[key] === 'local' ? local : saved
  }
  const records = (section: 'profiles' | 'feedback') => {
    const versions = [base, draft, current].map(value => new Map<string, Record<string, unknown>>(value[section].map(item => [item.id, { ...item }])))
    const [before, edited, latest] = versions
    return [...new Set([...latest.keys(), ...edited.keys(), ...before.keys()])].flatMap(id => {
      const old = before.get(id), local = edited.get(id), saved = latest.get(id)
      let result
      if (old && local && saved) {
        result = Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(local), ...Object.keys(saved)])].map(key =>
          [key, key === 'updated_at' ? saved[key] : choose(old[key], local[key], saved[key], section, id, key)]))
      } else result = choose(old, local, saved, section, id)
      return result ? [result] : []
    })
  }
  const library = { ...current, profiles: records('profiles'), feedback: records('feedback'),
    terms: choose(base.terms, draft.terms, current.terms, 'terms') } as Library
  return { library, conflicts }
}

export function importSources(profile: CharacterProfile, sources: BackgroundReference[]): CharacterProfile {
  const fresh = sources.filter(source => !profile.sources.some(old => old.url === source.url)).slice(0, Math.max(0, 8 - profile.sources.length))
  return { ...profile, sources: [...profile.sources, ...fresh].slice(0, 8),
    background: [profile.background, ...fresh.map(source => source.excerpt)].filter(Boolean).join('\n\n').slice(0, 6000) }
}

export function readLibraryDraft(raw: string | null): { base: Library; draft: Library; savedAt: string } | null {
  try {
    const value = JSON.parse(raw || 'null')
    const valid = (library: Library) => library?.schema_version === 1 && Number.isInteger(library.revision) && library.revision >= 0 &&
      Array.isArray(library.profiles) && library.profiles.length <= 100 && library.profiles.every(profile => profile && typeof profile.id === 'string' &&
        typeof profile.name === 'string' && typeof profile.background === 'string' && typeof profile.memes === 'string' &&
        Array.isArray(profile.aliases) && profile.aliases.every(alias => typeof alias === 'string') && Array.isArray(profile.sources) && profile.sources.every(source =>
          source && typeof source.title === 'string' && typeof source.url === 'string' && /^https?:\/\//.test(source.url) && typeof source.excerpt === 'string')) &&
      Array.isArray(library.terms) && library.terms.length <= 200 && library.terms.every(term => term && typeof term.correct === 'string' &&
        typeof term.scope === 'string' && Array.isArray(term.variants) && term.variants.every(word => typeof word === 'string')) &&
      Array.isArray(library.feedback) && library.feedback.length <= 200 && library.feedback.every(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.note === 'string')
    return value?.version === 2 && typeof value.savedAt === 'string' && valid(value.base) && valid(value.draft) && !sameContent(value.base, value.draft) ? value : null
  } catch { return null }
}
