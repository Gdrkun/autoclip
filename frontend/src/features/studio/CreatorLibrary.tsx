import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { Btn, Dialog } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { BackgroundReport } from './CharacterBackground'
import { emptyLibrary, sameContent, normalName, libraryValidation, rebaseLibrary, importSources, readLibraryDraft, containsReferences } from './creatorLibraryEditing'
import type { CharacterProfile, Library, LibraryConflict } from './creatorLibraryEditing'
import ReferenceLearning from './ReferenceLearning'
import './creator-library.css'

export type { CharacterProfile, VocabularyTerm, LibraryFeedback, Library } from './creatorLibraryEditing'
export const feedbackLabels: Record<string, string> = { singing: '唱歌', humor: '搞笑', interaction: '人物互动', meme: '玩梗', other: '其他' }
const split = (value: string) => value.split(/[、,，;；\n]+/).map(item => item.trim()).filter(Boolean)
const prefix = 'autoclip.creator-library.draft.v2.'
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : ''
const conflictText = (value: unknown): string => {
  if (value == null) return t('已删除')
  if (Array.isArray(value)) return value.map(conflictText).join('、') || t('空内容')
  if (typeof value === 'object') return Object.entries(value).filter(([key]) => ['name', 'background', 'memes', 'correct', 'variants', 'note', 'title', 'excerpt', 'url'].includes(key)).map(([, item]) => conflictText(item)).join('\n') || t('空内容')
  return String(value) || t('空内容')
}
function DelimitedInput({ value, onChange, label }: { value: string[]; onChange: (value: string[]) => void; label: string }) {
  const [text, setText] = useState(value.join('、'))
  const committed = useRef(value)
  useEffect(() => { if (value !== committed.current) setText(value.join('、')) }, [value])
  return <input className="ac-input" aria-label={label} maxLength={1800} value={text} onChange={event => {
    setText(event.target.value); const next = split(event.target.value); committed.current = next; onChange(next)
  }}/>
}
export default function CreatorLibrary({ query = '', report, onUse }: { query?: string; report?: BackgroundReport; onUse?: (name: string) => void }) {
  const [open, setOpen] = useState(false), [library, setLibrary] = useState<Library>(emptyLibrary)
  const [baseline, setBaseline] = useState<Library | null>(null)
  const [selected, setSelected] = useState(''), [tab, setTab] = useState('profiles')
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [storageError, setStorageError] = useState(false)
  const [search, setSearch] = useState(''), [sort, setSort] = useState('recent')
  const [closing, setClosing] = useState(false), [deleting, setDeleting] = useState(false)
  const [recovery, setRecovery] = useState<{ record: NonNullable<ReturnType<typeof readLibraryDraft>>; key: string } | null>(null)
  const [importing, setImporting] = useState<CharacterProfile | null>(null)
  const [conflict, setConflict] = useState<{ current: Library; fields: LibraryConflict[] } | null>(null)
  const [choices, setChoices] = useState<Record<string, 'local' | 'saved'>>({})
  const storageKey = useRef(''), recoveredKey = useRef<{ key: string; raw: string } | null>(null)
  const request = useRef<AbortController | null>(null), saveLock = useRef(false)
  const profile = library.profiles.find(item => item.id === selected)
  const dirty = !!baseline && !sameContent(library, baseline)
  const researchSaved = containsReferences(baseline, report?.sources || [])
  const researchStaged = containsReferences(library, report?.sources || [])
  const busy = loading || saving
  const blocked = busy || !baseline || !!recovery || !!conflict || closing
  const deleted = baseline?.profiles.filter(item => !library.profiles.some(current => current.id === item.id)) || []
  const persist = () => {
    if (!baseline || !dirty) return true
    try {
      if (!storageKey.current) storageKey.current = prefix + crypto.randomUUID()
      localStorage.setItem(storageKey.current, JSON.stringify({ version: 2, base: baseline, draft: library, savedAt: new Date().toISOString() }))
      setStorageError(false); return true
    } catch { setStorageError(true); return false }
  }
  const clearDraft = () => {
    try {
      if (storageKey.current) localStorage.removeItem(storageKey.current)
      const restored = recoveredKey.current
      if (restored && localStorage.getItem(restored.key) === restored.raw) localStorage.removeItem(restored.key)
    } catch { /* Server copy was saved. */ }
    recoveredKey.current = null
  }
  useEffect(() => { if (dirty) persist(); else if (baseline) clearDraft() }, [library, baseline])
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  useEffect(() => () => request.current?.abort(), [])
  const show = async () => {
    setOpen(true); setClosing(false); setError(''); setMessage('')
    if (dirty) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    setLoading(true); setBaseline(null)
    try {
      const value = await api.get<unknown, Library>('/studio/creator-library', { signal: controller.signal, timeout: 15000 })
      if (controller.signal.aborted) return
      setLibrary(value); setBaseline(value)
      const name = normalName(query.split(/[、,，]/)[0].replace(/[（(].*?[）)]/g, ''))
      setSelected(value.profiles.find(item => [item.name, ...item.aliases].some(alias => normalName(alias) === name))?.id || value.profiles[0]?.id || '')
      try {
        const drafts = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) || '').filter(key => key.startsWith(prefix))
          .map(key => ({ key, record: readLibraryDraft(localStorage.getItem(key)) })).filter((item): item is { key: string; record: NonNullable<ReturnType<typeof readLibraryDraft>> } => !!item.record)
          .sort((a, b) => b.record.savedAt.localeCompare(a.record.savedAt))
        setRecovery(drafts.find(item => !sameContent(item.record.draft, value)) || null)
      } catch { setStorageError(true) }
    } catch (e) { if (!controller.signal.aborted) setError(errorText(e)) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const close = () => {
    if (saving) return
    if (loading) { request.current?.abort(); setLoading(false) }
    if (dirty) { persist(); setClosing(true) } else setOpen(false)
  }
  const update = (next: Library) => { setLibrary(next); setMessage(''); setError(''); setDeleting(false) }
  const patch = (change: Partial<CharacterProfile>) => update({ ...library, profiles: library.profiles.map(item => item.id === selected ? { ...item, ...change } : item) })
  const add = () => {
    const item: CharacterProfile = { id: crypto.randomUUID(), name: '', aliases: [], background: '', memes: '', sources: [] }
    update({ ...library, profiles: [...library.profiles, item] }); setSelected(item.id); setSearch(''); setTab('profiles')
  }
  const previewImport = (name: string) => {
    const old = library.profiles.find(item => [item.name, ...item.aliases].some(alias => normalName(alias) === normalName(name)))
    setImporting(importSources(old || { id: crypto.randomUUID(), name, aliases: [], background: '', memes: '', sources: [] }, report?.sources.filter(source => source.subject === name) || []))
  }
  const save = async (closeAfter = false) => {
    if (!baseline || !dirty || saveLock.current || recovery || conflict) return
    const invalid = libraryValidation(library)
    if (invalid) { setError(t(invalid)); setClosing(false); return }
    saveLock.current = true; setSaving(true); setError(''); setMessage('')
    try {
      const result = await api.post<unknown, Library>('/studio/creator-library/changes', { base: baseline, draft: library }, { timeout: 15000 })
      setLibrary(result); setBaseline(result); clearDraft(); setClosing(false); setMessage(t('已保存到本机，后续转写和选片会使用。'))
      if (closeAfter) setOpen(false)
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: { code?: string; current?: Library } } } }).response?.data?.detail
      if (detail?.code === 'creator_library_conflict' && detail.current) {
        setConflict({ current: detail.current, fields: rebaseLibrary(baseline, library, detail.current).conflicts }); setChoices({}); setError(t('同一内容在其他页面有修改，请选择要保留的内容。'))
      } else setError(t('保存未完成，修改已保留，可以重试。') + ' ' + errorText(e))
      setClosing(false); persist()
    } finally { saveLock.current = false; setSaving(false) }
  }
  const found = library.profiles.filter(item => !search.trim() || [item.name, ...item.aliases].some(name => normalName(name).includes(normalName(search))))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (b.updated_at || '').localeCompare(a.updated_at || ''))
  return <><Btn size="sm" onClick={() => void show()}>{t(report ? '保存到角色档案' : '人物知识库')}</Btn>
    <Dialog open={open} onClose={close} title={t('人物知识库')} description={t('保存在本机；填写角色名后匹配档案。当前制作要求优先于历史偏好。')}
      footer={<div className="creator-save-bar"><span role="status" aria-live="polite" className={error ? 'creator-save-error' : dirty ? 'creator-unsaved' : ''}>{saving ? t('正在保存更改…') : error ? t('保存未完成') : dirty ? t('有未保存更改') : baseline ? t('已保存到本机') : t('尚未加载')}<small>{dateLabel(baseline?.updated_at)}</small></span>
        <div className="studio-actions"><Btn disabled={saving} onClick={close}>{t('关闭')}</Btn><Btn variant="cta" disabled={blocked || !dirty} loading={saving} onClick={() => void save()}>{t('保存更改')}</Btn></div></div>}>
      <div className="creator-library" aria-busy={busy}>
        <div className="creator-tabs" role="group" aria-label={t('知识库分类')}>{[['profiles', '角色与梗'], ['learning', '参考切片学习'], ['terms', '字幕词库'], ['feedback', '选片记忆']].map(([key, label]) => <button key={key} disabled={busy || closing} aria-pressed={tab === key} onClick={() => setTab(key)}>{t(label)}</button>)}</div>
        {loading && <p role="status">{t('正在加载档案…')}</p>}{error && <p className="studio-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
        {!loading && !baseline && <Btn onClick={() => void show()}>{t('重试加载')}</Btn>}
        {storageError && <p role="alert">{t('浏览器无法保留草稿，请保存后再离开。')}</p>}
        {recovery && <div className="creator-notice"><b>{t('发现未保存的档案草稿')}</b><small>{dateLabel(recovery.record.savedAt)}</small><p>{t('草稿尚未写入知识库，可以恢复后继续编辑。')}</p><div className="studio-actions"><Btn size="sm" onClick={() => { setBaseline(recovery.record.base); setLibrary(recovery.record.draft); setSelected(recovery.record.draft.profiles[0]?.id || ''); recoveredKey.current = { key: recovery.key, raw: JSON.stringify(recovery.record) }; setRecovery(null) }}>{t('恢复草稿')}</Btn><Btn size="sm" onClick={() => setRecovery(null)}>{t('暂不恢复')}</Btn></div></div>}
        {closing && <div className="creator-notice" role="alert"><b>{t('还有未保存的更改')}</b><p>{t('保存后关闭，或保留草稿下次继续。')}</p><div className="studio-actions"><Btn variant="cta" disabled={saving || !!conflict || !!recovery} onClick={() => void save(true)}>{t('保存并关闭')}</Btn><Btn onClick={() => { if (persist()) { setClosing(false); setOpen(false) } }}>{t('保留草稿并关闭')}</Btn><Btn onClick={() => setClosing(false)}>{t('继续编辑')}</Btn></div></div>}
        {conflict && <div className="creator-conflicts"><b>{t('对照并合并修改')}</b><p>{t('不同档案和未冲突的字段会自动合并。下面的冲突需要你选择。')}</p>{conflict.fields.map(field => <div className="creator-conflict" key={field.key}><strong>{library.profiles.find(item => item.id === field.id)?.name || t(field.section === 'terms' ? '字幕词库' : '选片记忆')} · {t(({ name: '角色名称', aliases: '别名（用顿号分隔）', background: '人物背景与关系', memes: '梗词典与适用语境', sources: '参考来源' } as Record<string, string>)[field.field] || '档案内容')}</strong><div>{(['local', 'saved'] as const).map(side => <label key={side}><input type="radio" name={field.key} checked={choices[field.key] === side} onChange={() => setChoices({ ...choices, [field.key]: side })}/>{t(side === 'local' ? '保留我的修改' : '使用已保存内容')}<pre>{conflictText(side === 'local' ? field.local : field.saved)}</pre></label>)}</div></div>)}<div className="studio-actions"><Btn disabled={conflict.fields.some(field => !choices[field.key])} onClick={() => { const result = rebaseLibrary(baseline!, library, conflict.current, choices); setLibrary(result.library); setBaseline(conflict.current); setConflict(null); setError(''); setMessage(t(sameContent(result.library, conflict.current) ? '已保存到本机' : '已合并到编辑草稿，请检查后保存。')) }}>{t('合并到草稿')}</Btn><Btn onClick={() => { setConflict(null); setError('') }}>{t('继续保留当前草稿')}</Btn></div></div>}
        {baseline && tab === 'profiles' && <>
          {!!report?.sources.length && <section className="creator-import-sources"><div><b>{t(researchSaved ? '本次查询资料已保存' : researchStaged ? '查询资料已加入草稿，尚未保存' : '本次查询结果尚未保存')}</b><p>{t('先预览导入；已有同名档案只追加新资料，保留人工修订。')}</p></div>{[...new Set(report.sources.map(source => source.subject))].map(name => <Btn key={name} size="sm" disabled={blocked} onClick={() => previewImport(name)}>{t('预览导入')} · {name}</Btn>)}</section>}
          {importing && <div className="creator-import-preview"><b>{importing.name} · {t('导入预览')}</b><p>{t('人物背景与关系')}</p><pre>{importing.background}</pre><small>{t('参考来源')} · {importing.sources.length}</small><div className="studio-actions"><Btn disabled={blocked || sameContent(importing, library.profiles.find(item => item.id === importing.id)) || (!library.profiles.some(item => item.id === importing.id) && library.profiles.length >= 100)} onClick={() => { update({ ...library, profiles: library.profiles.some(item => item.id === importing.id) ? library.profiles.map(item => item.id === importing.id ? importing : item) : [...library.profiles, importing] }); setSelected(importing.id); setSearch(''); setImporting(null) }}>{t('加入编辑草稿')}</Btn><Btn onClick={() => setImporting(null)}>{t('取消导入')}</Btn></div></div>}
          <div className="creator-manager"><aside className="creator-profile-list"><div className="creator-list-tools"><input className="ac-input" aria-label={t('搜索角色档案')} placeholder={t('搜索名称或别名')} value={search} onChange={event => setSearch(event.target.value)}/><div><select className="ac-input" aria-label={t('档案排序')} value={sort} onChange={event => setSort(event.target.value)}><option value="recent">{t('最近修改')}</option><option value="name">{t('按名称排序')}</option></select><Btn size="sm" disabled={blocked || library.profiles.length >= 100} onClick={add}>{t('新建角色')}</Btn></div></div><p>{t('角色档案')} · {library.profiles.length} / 100</p><div className="creator-profile-items">{found.map(item => <button className="creator-profile-card" key={item.id} disabled={blocked} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setDeleting(false); setImporting(null) }}><strong>{item.name || t('新角色')}</strong><span>{item.aliases.join('、') || t('暂无别名')}</span><small>{!sameContent(item, baseline.profiles.find(old => old.id === item.id)) ? t('未保存') : dateLabel(item.updated_at) || t('已保存')}</small></button>)}</div>{!found.length && <p>{t(library.profiles.length ? '没有匹配的角色档案' : '还没有角色档案，可新建或导入查询结果。')}</p>}</aside>
          <section className="creator-profile-detail">{profile ? <fieldset disabled={blocked || !!importing} className="creator-fields"><header><strong>{profile.name || t('新角色')}</strong><small>{!sameContent(profile, baseline.profiles.find(old => old.id === profile.id)) ? t('未保存') : t('已保存')} {dateLabel(profile.updated_at)}</small></header>
            {onUse && <Btn size="sm" disabled={dirty || blocked} onClick={() => { onUse(profile.name); setOpen(false) }}>{t('用于本次制作')}</Btn>}
            <label>{t('角色名称')}<input className="ac-input" maxLength={100} placeholder={t('填写准确角色名')} value={profile.name} onChange={event => patch({ name: event.target.value })}/></label>
            <label>{t('别名（用顿号分隔）')}<DelimitedInput key={profile.id} label={t('角色别名')} value={profile.aliases} onChange={aliases => patch({ aliases })}/></label>
            <label>{t('人物背景与关系')}<textarea className="ac-input" aria-label={t('人物背景与关系')} rows={5} maxLength={6000} value={profile.background} onChange={event => patch({ background: event.target.value })}/><small>{profile.background.length} / 6000</small></label>
            <label>{t('梗词典与适用语境')}<textarea className="ac-input" rows={4} maxLength={6000} placeholder={t('写清梗的含义、触发语境和容易误解的地方。')} value={profile.memes} onChange={event => patch({ memes: event.target.value })}/></label>
            {profile.sources.length > 0 && <details><summary>{t('参考来源')} · {profile.sources.length}</summary>{profile.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}</details>}
            {!deleting ? <Btn variant="text" size="sm" onClick={() => setDeleting(true)}>{t('删除此档案')}</Btn> : <div className="creator-notice"><p>{t('删除将在保存更改后生效。')}</p><div className="studio-actions"><Btn variant="danger" size="sm" onClick={() => { update({ ...library, profiles: library.profiles.filter(item => item.id !== selected) }); setSelected(library.profiles.find(item => item.id !== selected)?.id || '') }}>{t('确认删除档案')}</Btn><Btn size="sm" onClick={() => setDeleting(false)}>{t('取消')}</Btn></div></div>}
          </fieldset> : <p className="creator-profile-empty">{t('选择左侧档案，或新建角色开始整理。')}</p>}</section></div>
          {!!deleted.length && <div className="creator-notice">{t('待删除档案')}：{deleted.map(item => <Btn size="sm" key={item.id} disabled={blocked} onClick={() => update({ ...library, profiles: [...library.profiles, item] })}>{item.name} · {t('撤销删除')}</Btn>)}</div>}
        </>}
        {tab === 'learning' && <ReferenceLearning query={query || profile?.name || ''}/>}
        {baseline && tab === 'terms' && <><p>{t('正确写法用于 Whisper 热词；易错写法只生成纠错建议，确认后才改字幕。')}</p><p>{t('适用角色留空表示通用，多个角色用顿号分隔。SenseVoice 使用识别后纠错。')}</p>{library.terms.map((term, index) => <fieldset key={index} disabled={blocked} className="creator-term">
          <label>{t('正确写法')}<input className="ac-input" maxLength={80} value={term.correct} onChange={event => update({ ...library, terms: library.terms.map((item, i) => i === index ? { ...item, correct: event.target.value } : item) })}/></label>
          <label>{t('易错写法')}<DelimitedInput label={`${t('易错写法')} ${index + 1}`} value={term.variants} onChange={variants => update({ ...library, terms: library.terms.map((item, i) => i === index ? { ...item, variants } : item) })}/></label>
          <label>{t('适用角色')}<input className="ac-input" maxLength={200} value={term.scope} onChange={event => update({ ...library, terms: library.terms.map((item, i) => i === index ? { ...item, scope: event.target.value } : item) })}/></label><Btn variant="danger" size="sm" aria-label={`${t('删除词条')} ${index + 1}`} onClick={() => update({ ...library, terms: library.terms.filter((_, i) => i !== index) })}>{t('删除词条')}</Btn></fieldset>)}<Btn size="sm" disabled={blocked || library.terms.length >= 200} onClick={() => update({ ...library, terms: [...library.terms, { correct: '', variants: [], scope: '' }] })}>{t('添加词条')}</Btn></>}
        {baseline && tab === 'feedback' && <><p>{t('成片上的“多选这种 / 少选这种”会保存在这里，按角色用于以后选片。')}</p>{!library.feedback.length && <p>{t('还没有选片记忆。')}</p>}{[...library.feedback].reverse().map(item => <div className="creator-memory" key={item.id}><b>{t(item.direction === 'more' ? '多选这种' : '少选这种')} · {t(feedbackLabels[item.category])}</b><p>{item.title}</p><p>{item.note}</p>{item.excerpt && <blockquote>{item.excerpt}</blockquote>}<small>{item.query || t('通用偏好')}</small><Btn size="sm" variant="text" disabled={blocked} onClick={() => update({ ...library, feedback: library.feedback.filter(value => value.id !== item.id) })}>{t('忘记这条')}</Btn></div>)}</>}
      </div>
    </Dialog></>
}
