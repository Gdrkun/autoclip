import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { t } from '../../i18n'
import { Btn, Dialog } from '../../ui'
import SubtitleTimeline from './SubtitleTimeline'
import SubtitleRepair from './SubtitleRepair'
import { splitSubtitle, mergeSubtitles, retimeSubtitle, addSubtitleRange, adjacentSubtitle, cueInsideWindow, clockTime } from './subtitleTimelineEditing'
import api from '../../services/api'
import { errorText } from './api'
import type { Scene, SpeakerCaptionLayout, SpeakerCue, SpeakerDocument } from './types'
import { insertSpeakerCueInScenes, moveSpeakerCueInScenes, sortSpeakerCuesInScenes, speakerCuesForScenes, speakerCueSeek, speakerCueTiming, shiftSpeakerCues, replaceSpeakerText, validSpeakerLayout } from './speakerSubtitleEditing'
import './speaker-subtitles.css'
import CorrectionSuggestions from './CorrectionSuggestions'

type State = { job: { job_id?: string; status: string; error?: string; percent?:number; completed_chunks?:number; total_chunks?:number }; document: SpeakerDocument | null; has_document?: boolean }

type IconName = 'people' | 'chevron' | 'play' | 'up' | 'down' | 'plus' | 'remove' | 'settings'
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    chevron: 'm9 5 7 7-7 7', play: 'm8 5 11 7-11 7V5Z', up: 'm5 15 7-7 7 7', down: 'm5 9 7 7 7-7',
    plus: 'M12 5v14M5 12h14', remove: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  }
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>
}

export default function SpeakerSubtitles({ projectId, draftId, document, layout, enabled, dirty, currentTime, scenes, selectedScene = 0, autoEnabled = true, onChange, onApply, onLayout, onEnabled, onSeek, onTimingPendingChange, onAudition, onStyleEditingChange, onPause, onLoopChange }: {
  projectId: string; draftId: string; document?: SpeakerDocument | null; enabled: boolean; dirty: boolean; currentTime: number
  scenes?: Pick<Scene, 'start' | 'end'>[]; selectedScene?: number
  autoEnabled?: boolean
  layout?: SpeakerCaptionLayout | null; onLayout: (value: SpeakerCaptionLayout | null) => void
  onChange: (value: SpeakerDocument) => void; onApply: (value: SpeakerDocument) => void; onEnabled: (value: boolean) => void; onSeek: (seconds: number, sceneIndex?: number) => void
  onTimingPendingChange?: (pending: boolean) => void
  onAudition?: (start: number, end: number, sceneIndex: number, loop: boolean) => void
  onStyleEditingChange?: (editing: boolean) => void
  onPause?: () => void; onLoopChange?: (loop: boolean) => void
}) {
  const [backend, setBackend] = useState('whisper')
  const [prompt, setPrompt] = useState('')
  const [reuse, setReuse] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<State['job']>({ status: 'idle' })
  const [recognized, setRecognized] = useState<SpeakerDocument | null>(null)
  const apply = useRef(onApply)
  apply.current = onApply
  const requested = useRef(!document && enabled && autoEnabled)
  const autoRequested = useRef(false)
  const requestEpoch = useRef(0)
  const stopPolling = useRef<() => void>(() => undefined)
  const expectedJob = useRef<string | undefined>()
  const observedJob = useRef<string | undefined>()
  const latestDocument = useRef(document)
  latestDocument.current = document
  const applyBaseline = useRef(document)
  const settingsTouched = useRef(false)
  const [pollVersion, setPollVersion] = useState(0)
  const base = `/studio/${projectId}/speaker-subtitles`
  useEffect(() => {
    let active = true
    void api.get<unknown, { defaults?: { backend: string; prompt: string } }>('/studio/speaker-subtitles/status').then(state => {
      if (active && !settingsTouched.current && state.defaults) {
        setBackend(state.defaults.backend); setPrompt(state.defaults.prompt)
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [projectId])
  useEffect(() => {
    if (!document) requested.current = enabled && autoEnabled
  }, [document, enabled, autoEnabled])
  useEffect(() => {
    let active = true, inFlight = false, failures = 0
    const epoch = requestEpoch.current
    const controller = new AbortController()
    const current = () => active && epoch === requestEpoch.current
    const timer = window.setInterval(() => void refresh(), 2500)
    const refresh = async () => {
      if (inFlight || !current()) return
      inFlight = true
      try {
        let state = await api.get<unknown, State>(base, { params: { include_document: false }, signal: controller.signal })
        if (!current()) return
        if (expectedJob.current && state.job.job_id !== expectedJob.current) {
          // A later task in another window supersedes ours. Observe it without auto-applying its document.
          expectedJob.current = state.job.job_id; requested.current = false
          setRecognized(null); setToolMessage(t('识别任务已在其他窗口更新，当前修改已保留。'))
        }
        if (observedJob.current !== state.job.job_id && !requested.current) setRecognized(null)
        observedJob.current = state.job.job_id
        failures = 0
        setError(''); setJob(state.job)
        if (!state.document && state.has_document !== true && requested.current && !autoRequested.current && ['idle', 'failed'].includes(state.job.status)) {
          autoRequested.current = true
          const automatic = await api.post<unknown, State['job']>(base + '/ensure', undefined, { signal: controller.signal })
          if (!current()) return
          expectedJob.current = automatic.job_id
          setJob(automatic)
          if (['queued', 'running'].includes(automatic.status)) return
        }
        if (['queued', 'running'].includes(state.job.status)) return
        if (requested.current && (state.document || state.has_document)) {
          if (!state.document) state = await api.get<unknown, State>(base, { signal: controller.signal })
          if (!current() || (expectedJob.current && state.job.job_id !== expectedJob.current) || ['queued', 'running'].includes(state.job.status)) return
          setRecognized(state.document)
          if (state.document && !Object.keys(timingEditsRef.current).length && (!latestDocument.current || latestDocument.current === applyBaseline.current)) {
            apply.current({ ...state.document, speakers: state.document.speakers.map((speaker, index) => ({ ...speaker,
              color: speaker.color === '#FFFFFF' ? ['#FF91BD', '#C0A5FF'][index % 2] : speaker.color })) })
          }
          requested.current = false
        }
        window.clearInterval(timer)
      } catch (e) {
        if (current()) {
          setError(errorText(e))
          if (++failures >= 3 || (e as { response?: { status?: number } }).response?.status) window.clearInterval(timer)
        }
      } finally { inFlight = false }
    }
    const stop = () => { active = false; controller.abort(); window.clearInterval(timer) }
    stopPolling.current = stop
    void refresh()
    return stop
  }, [base, pollVersion])
  const recognize = async () => {
    ++requestEpoch.current; stopPolling.current()
    requested.current = false; applyBaseline.current = latestDocument.current
    setBusy(true); setError(''); setRecognized(null)
    try {
      const value = await api.post<unknown, State['job']>(base, { backend, prompt, reuse_subtitles: reuse })
      expectedJob.current = value.job_id
      requested.current = true
      setJob(value); setPollVersion(version => version + 1)
    } catch (e) { expectedJob.current = undefined; setError(errorText(e)); setPollVersion(version => version + 1) }
    finally { setBusy(false) }
  }
  const pause = async () => {
    ++requestEpoch.current; stopPolling.current(); requested.current = false
    try { await api.post(base + '/cancel'); setJob({ ...job, status: 'cancelled' }) }
    catch (e) { setError(errorText(e)); setPollVersion(version => version + 1) }
  }
  const [timingEdits, setTimingEdits] = useState<Record<string, { start: string; end: string }>>({})
  const timingEditsRef = useRef(timingEdits)
  const timingLoaded = useRef(false)
  const timingKey = `autoclip.studio.times.${projectId}.${draftId}`
  const changeTimingEdits = (next: typeof timingEdits) => {
    timingEditsRef.current = next
    setTimingEdits(next)
    try { if (Object.keys(next).length) localStorage.setItem(timingKey, JSON.stringify(next)); else localStorage.removeItem(timingKey) } catch { /* Keep editable state in memory when local storage is unavailable. */ }
    onTimingPendingChange?.(Object.keys(next).length > 0)
  }
  useEffect(() => {
    if (!document || timingLoaded.current) return
    timingLoaded.current = true
    try {
      const saved = JSON.parse(localStorage.getItem(timingKey) || 'null')
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
      const ids = new Set(document.subtitles.map(cue => cue.id))
      const next: typeof timingEdits = {}
      for (const [id, pair] of Object.entries(saved).slice(0, 10000)) {
        const value = pair as { start?: unknown; end?: unknown } | null
        if (ids.has(id) && value && typeof value.start === 'string' && typeof value.end === 'string' && value.start.length <= 80 && value.end.length <= 80) next[id] = { start: value.start, end: value.end }
      }
      if (Object.keys(next).length) changeTimingEdits(next)
    } catch { /* A malformed recovery record cannot replace the saved document. */ }
  }, [document?.subtitles])
  const scope = JSON.stringify([projectId, draftId, scenes])
  const [retained, setRetained] = useState({ scope, ids: [] as string[] })
  const retainedIds = [...(retained.scope === scope ? retained.ids : []), ...Object.keys(timingEdits)]
  const retain = (id: string) => setRetained({ scope, ids: Array.from(new Set([...retainedIds, id])) })
  const [removed, setRemoved] = useState<{ cue: SpeakerCue; index: number; following?: string; timing?: { start: string; end: string } } | null>(null)
  const [focusCue, setFocusCue] = useState<string | null>(null)
  const [editorView, setEditorView] = useState('captions')
  const [query, setQuery] = useState('')
  const [speakerFilter, setSpeakerFilter] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [editingCue, setEditingCue] = useState<string | null>(null)
  const [revealCue, setRevealCue] = useState<string | null>(null)
  const cueList = useRef<HTMLOListElement>(null)
  const activeText = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!focusCue) return
    const input = activeText.current?.dataset.cueId === focusCue ? activeText.current : Array.from(cueList.current?.querySelectorAll('textarea') || []).find(input => input.dataset.cueId === focusCue)
    if (input) { input.focus(); input.select(); input.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setFocusCue(null) }
  }, [focusCue, document])
  const visibleCues = useMemo(() => document ? speakerCuesForScenes(document.subtitles, scenes, retainedIds) : [],
    [document?.subtitles, scope, retained.scope, retained.ids, timingEdits])
  const needsReview = (cue: SpeakerCue) => {
    const timing = timingEdits[cue.id] || { start: String(cue.start_ms / 1000), end: String(cue.end_ms / 1000) }
    return !cue.text.trim() || !speakerCueTiming(timing.start, timing.end, document?.duration_ms ?? 0)
  }
  const reviewCount = useMemo(() => visibleCues.filter(needsReview).length, [visibleCues, timingEdits])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const cuePositions = useMemo(() => new Map(visibleCues.map((cue, index) => [cue.id, index])), [visibleCues])
  const shownCues = useMemo(() => visibleCues.filter(cue => {
    // Keep the focused row while its text/time changes no longer match a filter.
    if (cue.id === editingCue || cue.id === focusCue || timingEdits[cue.id]) return true
    return (!normalizedQuery || cue.text.toLocaleLowerCase().includes(normalizedQuery)) &&
      (!speakerFilter || (cue.speaker_id || '__unknown') === speakerFilter) && (!issuesOnly || needsReview(cue))
  }), [visibleCues, normalizedQuery, speakerFilter, issuesOnly, editingCue, focusCue, timingEdits])
  const playbackCue = visibleCues.find(cue => cue.start_ms <= currentTime * 1000 && currentTime * 1000 < cue.end_ms) ||
    visibleCues.reduce<SpeakerCue | undefined>((nearest, cue) => !nearest || Math.abs(cue.start_ms - currentTime * 1000) < Math.abs(nearest.start_ms - currentTime * 1000) ? cue : nearest, undefined)
  const [page, setPage] = useState(0)
  const pageSize = 60
  const pageCount = Math.max(1, Math.ceil(shownCues.length / pageSize))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageCues = shownCues.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [replacement, setReplacement] = useState('')
  const [offset, setOffset] = useState('0')
  const [loop, setLoop] = useState(false)
  const [activeCueId, setActiveCueId] = useState<string | null>(null)
  const textCarets = useRef<Record<string, number>>({})
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null)
  const [addition, setAddition] = useState<{ start: number; end: number; speaker: string | null; layer: number } | null>(null)
  const [additionText, setAdditionText] = useState('')
  const [additionError, setAdditionError] = useState('')
  const [toolMessage, setToolMessage] = useState('')
  const [favorite, setFavorite] = useState<SpeakerCaptionLayout | null>(null)
  const [projectPeople, setProjectPeople] = useState<SpeakerDocument['speakers'] | null>(null)
  const history = useRef<{ past: SpeakerDocument[]; future: SpeakerDocument[] }>({ past: [], future: [] })
  const [historyVersion, setHistoryVersion] = useState(0)
  const readOnlyPending = Object.keys(timingEdits).length > 0
  const selectCue = (cue: SpeakerCue) => {
    setActiveCueId(cue.id); clearFilters(); setPage(Math.floor((cuePositions.get(cue.id) || 0) / pageSize)); setRevealCue(cue.id)
    const target = speakerCueSeek(cue, scenes || [{ start: 0, end: (document?.duration_ms || 0) / 1000 }], selectedScene)
    if (target) onSeek(target.seconds, target.sceneIndex)
  }
  const audition = (cue: SpeakerCue) => {
    const windows = scenes || [{ start: 0, end: (document?.duration_ms || 0) / 1000 }]
    const target = speakerCueSeek(cue, windows, selectedScene)
    if (target) {
      if (onAudition) onAudition(target.seconds, Math.min(cue.end_ms / 1000, windows[target.sceneIndex].end), target.sceneIndex, loop)
      else onSeek(target.seconds, target.sceneIndex)
    }
  }
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('autoclip.speaker-layout.v1') || 'null')
      if (validSpeakerLayout(saved)) setFavorite(saved)
      const people = JSON.parse(localStorage.getItem(`autoclip.speaker-people.${projectId}`) || 'null')
      if (Array.isArray(people) && people.length <= 100 && people.every(person => person && /^spk_[0-9]+$/.test(person.speaker_id) &&
        typeof person.display_name === 'string' && person.display_name.length <= 40 && /^#[0-9a-fA-F]{6}$/.test(person.color))) setProjectPeople(people)
    } catch { /* Optional local preset must not prevent editing. */ }
  }, [])
  useEffect(() => { onStyleEditingChange?.(editorView === 'style'); return () => onStyleEditingChange?.(false) }, [editorView])
  const clearFilters = () => { setQuery(''); setSpeakerFilter(''); setIssuesOnly(false); setPage(0) }
  useEffect(() => {
    if (!revealCue) return
    const input = activeText.current?.dataset.cueId === revealCue ? activeText.current : Array.from(cueList.current?.querySelectorAll('textarea') || []).find(input => input.dataset.cueId === revealCue)
    if (input) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setRevealCue(null) }
  }, [revealCue, editorView, query, speakerFilter, issuesOnly, pageIndex])
  const processing = busy || ['queued', 'running'].includes(job.status)
  const layoutValue = layout || { font_scale: 1, x: .5, y: .91 }
  const outline = { enabled: layout?.outline_enabled !== false, width: layout?.outline_width ?? 2, color: layout?.outline_color || '#000000' }
  const patchOutline = (update: Partial<SpeakerCaptionLayout>) => onLayout({ ...layoutValue,
    outline_enabled: outline.enabled, outline_width: outline.width, outline_color: outline.color, ...update })
  const patch = (update: Partial<SpeakerDocument>) => {
    if (!document) return
    history.current.past = [...history.current.past.slice(-19), document]
    history.current.future = []; setHistoryVersion(historyVersion + 1)
    onChange({ ...document, ...update })
  }
  const travel = (redo: boolean) => {
    if (!document || readOnlyPending) return
    const from = redo ? history.current.future : history.current.past
    const value = from.pop()
    if (!value) return
    ;(redo ? history.current.past : history.current.future).push(document)
    onChange(value); setHistoryVersion(historyVersion + 1)
  }
  const batchIds = selectedIds.filter(id => visibleCues.some(cue => cue.id === id))
  const shift = () => {
    if (!document) return
    const subtitles = shiftSpeakerCues(document.subtitles, batchIds, offset, document.duration_ms)
    if (subtitles) { patch({ subtitles }); setToolMessage(t('已调整选中字幕的时间')) }
    else setToolMessage(t('时间偏移无效或会超出原片范围，请检查。'))
  }
  const replace = () => {
    if (!document || !query.trim()) return
    const result = replaceSpeakerText(document.subtitles, batchIds.length ? batchIds : visibleCues.map(cue => cue.id), query.trim(), replacement)
    if (!result) { setToolMessage(t('替换后字幕不能为空或超过 2000 字')); return }
    patch({ subtitles: result }); setToolMessage(t('已替换当前范围内的文字'))
  }
  const cancelTiming = (id: string) => {
    const next = { ...timingEditsRef.current }; delete next[id]; changeTimingEdits(next)
  }
  const applyTiming = (cue: SpeakerCue) => {
    const pending = timingEditsRef.current[cue.id]
    if (!document || !pending) return
    const timing = speakerCueTiming(pending.start, pending.end, document.duration_ms)
    if (!timing) return
    retain(cue.id)
    cancelTiming(cue.id)
    patch({ subtitles: document.subtitles.map(c => c.id === cue.id ? { ...c, ...timing, assignment_reason: 'manual' } : c) })
  }
  const editWindow = scenes?.[selectedScene] || scenes?.[0] || { start: 0, end: (document?.duration_ms || 0) / 1000 }
  const activeCue = visibleCues.find(cue => cue.id === activeCueId) || playbackCue
  const activate = (cue: SpeakerCue) => {
    setActiveCueId(cue.id); clearFilters(); setPage(Math.floor((cuePositions.get(cue.id) || 0) / pageSize))
  }
  const commitTime = (id: string, start: number, end: number) => {
    if (!document || readOnlyPending) return
    const subtitles = retimeSubtitle(document.subtitles, id, Math.round(start * 1000), Math.round(end * 1000), editWindow)
    if (!subtitles) { setToolMessage(t('调整后的字幕须位于当前镜头内，且至少持续 0.1 秒。')); return }
    retain(id); patch({ subtitles })
  }
  const splitCue = (cue = activeCue) => {
    if (!document || !cue || readOnlyPending) return
    const id = crypto.randomUUID(), caret = textCarets.current[cue.id]
    if (!caret || caret >= cue.text.length) {
      setFocusCue(cue.id); setToolMessage(t('先在字幕正文中把光标放到两句之间，再把播放头停在换人位置。')); return
    }
    const at = Math.round(currentTime * 1000)
    const subtitles = splitSubtitle(document.subtitles, cue.id, caret, at, id, null)
    if (!subtitles || currentTime < editWindow.start || currentTime > editWindow.end) {
      setToolMessage(t('播放头须位于这句字幕内部，拆分后每句至少 0.1 秒。')); return
    }
    clearFilters(); retain(id); patch({ subtitles }); setActiveCueId(id); setFocusCue(id)
    setToolMessage(t('已拆成两句，请确认新句的说话人。'))
  }
  const mergeCue = (cue = activeCue) => {
    if (!document || !cue || readOnlyPending) return
    const next = adjacentSubtitle(document.subtitles, cue.id, editWindow)
    const subtitles = next && mergeSubtitles(document.subtitles, cue.id, next.id)
    if (!subtitles) { setToolMessage(t('只能合并当前镜头中同一人物、同一字幕行的相邻句。')); return }
    patch({ subtitles }); setActiveCueId(cue.id); setFocusCue(cue.id)
    setToolMessage(t('已合并相邻字幕，可撤销。'))
  }
  const openAddition = (overlap = false) => {
    if (!document || readOnlyPending) return
    const start = overlap && activeCue ? Math.max(editWindow.start, activeCue.start_ms / 1000)
      : Math.max(editWindow.start, Math.min(selectedRange?.start ?? currentTime, editWindow.end - .1))
    const end = overlap && activeCue ? Math.min(editWindow.end, activeCue.end_ms / 1000)
      : Math.min(editWindow.end, selectedRange?.end ?? start + 2)
    const speaker = overlap && activeCue ? document.speakers.find(person => person.speaker_id !== activeCue.speaker_id)?.speaker_id ?? null : activeCue?.speaker_id ?? null
    setAddition({ start, end, speaker, layer: overlap && activeCue ? 1 - activeCue.layer : 0 })
    setAdditionText(''); setAdditionError('')
  }
  const confirmAddition = () => {
    if (!document || !addition || readOnlyPending) return
    const id = crypto.randomUUID()
    const subtitles = addSubtitleRange(document, editWindow, Math.round(addition.start * 1000), Math.round(addition.end * 1000), id,
      additionText, addition.speaker, addition.layer)
    if (!subtitles) { setAdditionError(t('请填写字幕正文，并确认有效的镜头内起止时间。')); return }
    clearFilters(); retain(id); patch({ subtitles }); setActiveCueId(id); setFocusCue(id); setAddition(null)
  }
  const addCue = (afterId?: string) => {
    if (!document) return
    const id = crypto.randomUUID()
    const subtitles = insertSpeakerCueInScenes(document, scenes, currentTime, id, t('新增字幕'), afterId)
    if (!subtitles.some(cue => cue.id === id)) return
    clearFilters(); retain(id); patch({ subtitles }); setFocusCue(id)
  }
  return <details className="speaker-panel" open={!!document}>
    <summary className="speaker-panel-summary">
      <span className="speaker-panel-symbol"><Icon name="people"/></span>
      <span className="speaker-panel-title"><strong>{t('说话人字幕')}</strong><span>{t('本地识别和纠错，不重新分析高光。')}</span></span>
      {document && <span className="speaker-panel-count">{visibleCues.length} {t('条字幕')}</span>}
      <span className="speaker-panel-chevron"><Icon name="chevron"/></span>
    </summary>
    <div className="speaker-panel-body">
      <details className="speaker-recognition" open={!document}>
        <summary><Icon name="settings"/><span>{t('识别设置')}</span><span className="speaker-recognition-status">{processing ? `${t('正在识别字幕…')} ${job.percent ?? 0}%` : 'CPU'}</span><Icon name="chevron"/></summary>
        <div className="speaker-recognition-body">
          <div className="speaker-recognition-fields">
            <label className="speaker-field"><span>{t('转写模型')}</span><select className="ac-input" aria-label={t('转写模型')} value={backend} onChange={e => { settingsTouched.current = true; setBackend(e.target.value) }}><option value="whisper">Whisper medium · CPU</option><option value="sensevoice">SenseVoiceSmall · CPU</option></select></label>
            <label className="speaker-field"><span>{t('转写提示词')}</span><input className="ac-input" aria-label={t('转写提示词')} value={prompt} maxLength={500} onChange={e => { settingsTouched.current = true; setPrompt(e.target.value) }}/></label>
          </div>
          <div className="speaker-recognition-footer">
            <label className="speaker-check"><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)}/><span>{t('复用已有字幕')}</span></label><span className="speaker-timing-hint">{t('识别设置沿用已保存配置，可临时调整。')}</span>
            <div className="speaker-buttons">{processing && <Btn size="sm" onClick={() => void pause()}>{t('暂停识别')}</Btn>}<Btn size="sm" disabled={processing} loading={processing} onClick={() => void recognize()}>{processing ? t('正在识别字幕…') : document ? t('重新识别说话人字幕') : t('识别说话人字幕')}</Btn>
              {recognized && job.status === 'completed' && <Btn size="sm" disabled={processing || readOnlyPending} onClick={() => onApply(recognized)}>{t('应用识别结果')}</Btn>}
            </div>
          </div>
        </div>
      </details>
      {job.total_chunks && <p className="studio-muted">{t('分段进度 {{done}} / {{total}}', {done:job.completed_chunks||0,total:job.total_chunks})}</p>}
      {toolMessage && <p role="status" className="speaker-timing-hint">{toolMessage}</p>}
      {(error || job.error) && <p role="alert" className="speaker-error">{t(error || job.error || '')}</p>}
      {document && <>
        <div className="speaker-view-switch" role="group" aria-label={t('字幕工具')}>
          <Btn size="sm" aria-pressed={editorView === 'captions'} onClick={() => setEditorView('captions')}>{t('字幕编辑')}</Btn>
          <Btn size="sm" aria-pressed={editorView === 'style'} onClick={() => setEditorView('style')}>{t('人物与样式')}</Btn>
        </div>
        <div hidden={editorView !== 'captions'}><CorrectionSuggestions projectId={projectId} document={document} cueIds={visibleCues.map(cue => cue.id)} onChange={value => patch(value)}/></div>
        <section className="speaker-section" hidden={editorView !== 'style'}>
          <div className="speaker-section-head"><div><h3>{t('人物与颜色')}</h3><p>{t('给说话人命名，颜色会跟随对应字幕。')}</p></div>
            <label className="speaker-color-switch"><input type="checkbox" aria-label={t('启用双色字幕')} checked={enabled} onChange={e => onEnabled(e.target.checked)}/><span className="speaker-switch-track"/><span>{t('启用双色字幕')}</span></label>
          </div>
          <div className="speaker-preset-bar">
            <Btn size="sm" disabled={!projectPeople} onClick={() => patch({ speakers: document.speakers.map(speaker => {
              const appearance = projectPeople?.find(person => person.speaker_id === speaker.speaker_id)
              return appearance ? { ...speaker, display_name: appearance.display_name, color: appearance.color } : speaker
            }) })}>{t('套用项目人物')}</Btn>
            <Btn size="sm" variant="text" onClick={() => {
              try { localStorage.setItem(`autoclip.speaker-people.${projectId}`, JSON.stringify(document.speakers)); setProjectPeople(document.speakers); setToolMessage(t('人物配置已保存在本机，可在本项目其他切片套用。')) }
              catch { setToolMessage(t('无法保存本机样式')) }
            }}>{t('记住本项目人物')}</Btn>
          </div>
          <div className="speaker-people">
            {document.speakers.map((speaker, index) => <div className="speaker-person" key={speaker.speaker_id} style={{ '--speaker-color': speaker.color } as CSSProperties}>
              <span className="speaker-person-avatar">{String(index + 1).padStart(2, '0')}</span>
              <div className="speaker-person-name"><input className="ac-input" aria-label={`${t('说话人名称')} ${speaker.speaker_id}`} placeholder={`${t('说话人')} ${index + 1}`} maxLength={40} value={speaker.display_name === speaker.speaker_id ? '' : speaker.display_name}
                onChange={e => patch({ speakers: document.speakers.map(s => s.speaker_id === speaker.speaker_id ? { ...s, display_name: e.target.value } : s) })}/><span>{speaker.speaker_id}</span></div>
              <label className="speaker-color-picker" title={t('字幕颜色')}><input type="color" aria-label={`${t('字幕颜色')} ${speaker.speaker_id}`} value={speaker.color}
                onChange={e => patch({ speakers: document.speakers.map(s => s.speaker_id === speaker.speaker_id ? { ...s, color: e.target.value } : s) })}/><span aria-hidden="true" style={{ background: speaker.color }}/></label>
            </div>)}
          </div>
        </section>
        <section className="speaker-section" hidden={editorView !== 'style'}>
          <div className="speaker-section-head"><div><h3>{t('字幕样式与位置')}</h3><p>{t('100% 为默认字号；位置按画面百分比。')}</p></div><Btn variant="text" size="sm" onClick={() => onLayout(null)}>{t('恢复字幕布局')}</Btn></div>
          <div className="speaker-preset-bar">
            <Btn size="sm" onClick={() => onLayout({ ...layoutValue, font_scale: 1, x: .5, y: .91 })}>{t('标准底部')}</Btn>
            <Btn size="sm" onClick={() => onLayout({ ...layoutValue, font_scale: 1.25, x: .5, y: .82 })}>{t('大字安全区')}</Btn>
            <Btn size="sm" disabled={!favorite} onClick={() => favorite && onLayout({ ...favorite })}>{t('应用我的样式')}</Btn>
            <Btn size="sm" variant="text" onClick={() => {
              try { localStorage.setItem('autoclip.speaker-layout.v1', JSON.stringify(layoutValue)); setFavorite({ ...layoutValue }); setToolMessage(t('样式已保存到本机')) }
              catch { setToolMessage(t('无法保存本机样式')) }
            }}>{t('记住此样式')}</Btn>
          </div>
          <p className="speaker-timing-hint">{t('可在左侧预览拖动字幕，或用方向键微调位置。')}</p>
          <div className="speaker-layout-controls">
            <label className="speaker-slider"><span>{t('字幕大小（%）')}<input className="speaker-number" type="number" aria-label={t('字幕大小（%）数值')} min={50} max={250} step={1} value={Math.round(layoutValue.font_scale * 100)} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 50 && value <= 250) onLayout({ ...layoutValue, font_scale: value / 100 }) }}/></span><input type="range" aria-label={t('字幕大小（%）')} min={50} max={250} step={5} value={Math.round(layoutValue.font_scale * 100)} onChange={e => onLayout({ ...layoutValue, font_scale: Number(e.target.value) / 100 })}/></label>
            <label className="speaker-slider"><span>{t('横向位置（%）')}<input className="speaker-number" type="number" aria-label={t('横向位置（%）数值')} min={5} max={95} step={1} value={Math.round(layoutValue.x * 100)} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 5 && value <= 95) onLayout({ ...layoutValue, x: value / 100 }) }}/></span><input type="range" aria-label={t('横向位置（%）')} min={5} max={95} step={1} value={Math.round(layoutValue.x * 100)} onChange={e => onLayout({ ...layoutValue, x: Number(e.target.value) / 100 })}/></label>
            <label className="speaker-slider"><span>{t('纵向位置（%）')}<input className="speaker-number" type="number" aria-label={t('纵向位置（%）数值')} min={15} max={95} step={1} value={Math.round(layoutValue.y * 100)} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 15 && value <= 95) onLayout({ ...layoutValue, y: value / 100 }) }}/></span><input type="range" aria-label={t('纵向位置（%）')} min={15} max={95} step={1} value={Math.round(layoutValue.y * 100)} onChange={e => onLayout({ ...layoutValue, y: Number(e.target.value) / 100 })}/></label>
          </div>
          <details className="speaker-outline-controls"><summary>{t('描边与高级样式')}</summary>
            <div className="speaker-outline-heading"><label className="speaker-color-switch"><input type="checkbox" aria-label={t('字幕描边')} checked={outline.enabled} onChange={event => patchOutline({ outline_enabled: event.target.checked })}/><span className="speaker-switch-track"/><span>{t('字幕描边')}</span></label><span className="speaker-outline-hint">{t('粗细随字号缩放，关闭后不显示描边。')}</span></div>
            <div className="speaker-outline-options">
              <label className={`speaker-outline-color${outline.enabled ? '' : ' speaker-outline-color--disabled'}`}><span>{t('描边颜色')}</span><span className="speaker-color-picker"><input type="color" aria-label={t('描边颜色')} disabled={!outline.enabled} value={outline.color} onChange={event => patchOutline({ outline_color: event.target.value })}/><span aria-hidden="true" style={{ background: outline.color }}/></span><span className="speaker-outline-hex" aria-hidden="true">{outline.color.toUpperCase()}</span></label>
              <label className={`speaker-slider${outline.enabled ? '' : ' speaker-slider--disabled'}`}><span>{t('描边粗细（px）')}<output>{outline.width}px</output></span><input type="range" aria-label={t('描边粗细（px）')} min={.5} max={8} step={.5} disabled={!outline.enabled} value={outline.width} onChange={event => patchOutline({ outline_width: Number(event.target.value) })}/></label>
            </div>
          </details>
        </section>
        <section className="speaker-section speaker-captions-section" hidden={editorView !== 'captions'}>
          <div className="speaker-section-head"><div><h3>{t('逐句校对')}<span className="speaker-small-count">{visibleCues.length}</span></h3><p>{t('仅显示当前切片的字幕；时间按原视频计。')}</p></div><Btn size="sm" onClick={() => patch({ subtitles: sortSpeakerCuesInScenes(document.subtitles, scenes, retainedIds) })}>{t('按时间排序')}</Btn></div>
          <SubtitleTimeline projectId={projectId} document={document} scene={editWindow} time={currentTime} selectedId={activeCue?.id}
            onSelect={activate} onSeek={seconds => onSeek(seconds, selectedScene)} onPause={onPause}
            onCommit={commitTime} onRange={setSelectedRange} disabled={readOnlyPending}/>
          <SubtitleRepair projectId={projectId} draftId={draftId} document={document} activeCue={activeCue} range={selectedRange} scene={editWindow}
            backend={backend} prompt={prompt} disabled={readOnlyPending || processing} onApply={subtitles => patch({ subtitles })}
            onAudition={onAudition ? (start, end) => onAudition(start, end, selectedScene, loop) : undefined}/>
          {activeCue && <div className="subtitle-active-editor">
            <div className="subtitle-active-heading"><strong>{t('当前字幕')}</strong>
              <select className="ac-input" aria-label={t('当前字幕说话人')} value={activeCue.speaker_id || ''} onChange={event => patch({
                subtitles: document.subtitles.map(cue => cue.id === activeCue.id ? { ...cue, speaker_id: event.target.value || null, assignment_reason: 'manual' } : cue) })}>
                <option value="">{t('未知')}</option>{document.speakers.map(speaker => <option key={speaker.speaker_id} value={speaker.speaker_id}>{speaker.display_name || speaker.speaker_id}</option>)}</select>
              <Btn size="sm" onClick={() => audition(activeCue)}>{t('试听当前句')}</Btn>
            </div>
            <textarea ref={activeText} data-cue-id={activeCue.id} className="ac-input" rows={2} maxLength={2000} aria-label={t('当前字幕正文')}
              value={activeCue.text} onSelect={event => { textCarets.current[activeCue.id] = event.currentTarget.selectionStart }}
              onKeyDown={event => {
                if (event.nativeEvent?.isComposing) return
                if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); audition(activeCue) }
                if (event.altKey && ['ArrowUp','ArrowDown'].includes(event.key)) {
                  event.preventDefault()
                  const index = cuePositions.get(activeCue.id) || 0
                  selectCue(visibleCues[Math.max(0, Math.min(visibleCues.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))])
                }
              }} onChange={event => patch({ subtitles: document.subtitles.map(cue => cue.id === activeCue.id ? { ...cue, text: event.target.value, assignment_reason: 'manual' } : cue) })}/>
          </div>}
          <div className="subtitle-edit-actions">
            <Btn size="sm" disabled={!activeCue || readOnlyPending} onClick={() => splitCue()}>{t('光标处拆句')}</Btn>
            <Btn size="sm" disabled={!activeCue || readOnlyPending} onClick={() => mergeCue()}>{t('合并下一句')}</Btn>
            {activeCue && !cueInsideWindow(activeCue, editWindow) && <Btn size="sm" disabled={readOnlyPending} onClick={() => commitTime(activeCue.id,
              Math.max(editWindow.start, activeCue.start_ms / 1000), Math.min(editWindow.end, activeCue.end_ms / 1000))}>{t('裁到当前镜头')}</Btn>}
            <Btn size="sm" disabled={readOnlyPending || document.subtitles.length >= 10000} onClick={() => openAddition()}>{t(selectedRange ? '选区补句' : '补一句')}</Btn>
            <Btn size="sm" disabled={!activeCue || readOnlyPending || document.subtitles.length >= 10000} onClick={() => openAddition(true)}>{t('补重叠字幕')}</Btn>
            {selectedRange && onAudition && <Btn size="sm" onClick={() => onAudition(selectedRange.start, selectedRange.end, selectedScene, loop)}>{t('试听选区')}</Btn>}
          </div>
          {activeCue && <details className="subtitle-time-details"><summary>{t('精确时间与微调')}</summary><div className="subtitle-exact-times" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) applyTiming(activeCue)
          }}>
            {(['start','end'] as const).map(field => <label key={field}>{t(field === 'start' ? '原片起点' : '原片终点')}
              <div className="subtitle-time-nudge"><Btn size="sm" aria-label={t(field === 'start' ? '起点提前 0.1 秒' : '终点提前 0.1 秒')} disabled={readOnlyPending}
                onClick={() => commitTime(activeCue.id, activeCue.start_ms / 1000 - (field === 'start' ? .1 : 0), activeCue.end_ms / 1000 - (field === 'end' ? .1 : 0))}>−</Btn>
                <input className="ac-input" aria-label={t(field === 'start' ? '时间轴起点' : '时间轴终点')}
                  value={timingEdits[activeCue.id]?.[field] ?? clockTime((field === 'start' ? activeCue.start_ms : activeCue.end_ms) / 1000)}
                  onChange={event => changeTimingEdits({ ...timingEditsRef.current, [activeCue.id]: {
                    start: timingEditsRef.current[activeCue.id]?.start ?? String(activeCue.start_ms / 1000),
                    end: timingEditsRef.current[activeCue.id]?.end ?? String(activeCue.end_ms / 1000), [field]: event.target.value } })}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyTiming(activeCue) } if (event.key === 'Escape') cancelTiming(activeCue.id) }}/>
                <Btn size="sm" aria-label={t(field === 'start' ? '起点延后 0.1 秒' : '终点延后 0.1 秒')} disabled={readOnlyPending}
                  onClick={() => commitTime(activeCue.id, activeCue.start_ms / 1000 + (field === 'start' ? .1 : 0), activeCue.end_ms / 1000 + (field === 'end' ? .1 : 0))}>+</Btn></div>
            </label>)}
          </div></details>}
          <p className="subtitle-repair-hint">{t('拆句时，文字光标决定分开哪几个字，播放头决定分开的时间。')}</p>
          <div className="speaker-editor-toolbar">
            <div className="speaker-toolbar-actions">
              <Btn size="sm" disabled={readOnlyPending || !history.current.past.length} onClick={() => travel(false)}>{t('撤销')}</Btn>
              <Btn size="sm" disabled={readOnlyPending || !history.current.future.length} onClick={() => travel(true)}>{t('重做')}</Btn>
              <Btn size="sm" disabled={!visibleCues.length} onClick={() => {
                const index = visibleCues.findIndex(cue => cue.id === (editingCue || playbackCue?.id))
                selectCue(visibleCues[Math.max(0, index - 1)])
              }}>{t('上一句')}</Btn>
              <Btn size="sm" disabled={!visibleCues.length} onClick={() => {
                const index = visibleCues.findIndex(cue => cue.id === (editingCue || playbackCue?.id))
                selectCue(visibleCues[Math.min(visibleCues.length - 1, index + 1)])
              }}>{t('下一句')}</Btn>
              <label className="speaker-check"><input type="checkbox" checked={loop} onChange={event => { setLoop(event.target.checked); onLoopChange?.(event.target.checked) }}/>{t('循环试听')}</label>
            </div>
            <div className="speaker-search-row">
              <input className="ac-input speaker-search" type="search" aria-label={t('搜索字幕文字')} placeholder={t('搜索字幕文字')} value={query} onChange={event => setQuery(event.target.value)}/>
              <select className="ac-input speaker-filter" aria-label={t('筛选说话人')} value={speakerFilter} onChange={event => setSpeakerFilter(event.target.value)}>
                <option value="">{t('全部说话人')}</option><option value="__unknown">{t('未知')}</option>
                {document.speakers.map((speaker, index) => <option key={speaker.speaker_id} value={speaker.speaker_id}>{speaker.display_name && speaker.display_name !== speaker.speaker_id ? speaker.display_name : `${t('说话人')} ${index + 1}`}</option>)}
              </select>
            </div>
            <div className="speaker-toolbar-actions">
              <Btn size="sm" aria-pressed={issuesOnly} onClick={() => setIssuesOnly(!issuesOnly)}>{t('待修正')}<span className="speaker-review-count">{reviewCount}</span></Btn>
              <Btn size="sm" disabled={!playbackCue} onClick={() => { if (playbackCue) selectCue(playbackCue) }}>{t('定位播放位置')}</Btn>
              <Btn size="sm" disabled={document.subtitles.length >= 10000} onClick={() => addCue()}><Icon name="plus"/>{t('在播放位置补句')}</Btn>
            </div>
            <div className="speaker-filter-status"><span role="status">{t('显示 {{shown}} / {{total}} 条', { shown: shownCues.length, total: visibleCues.length })}</span>
              {(query || speakerFilter || issuesOnly) && <Btn size="sm" variant="text" onClick={clearFilters}>{t('清除筛选')}</Btn>}
            </div>
          </div>
          <details className="speaker-batch-tools"><summary>{t('批量修改与替换')}</summary>
            <div className="speaker-toolbar-actions">
              <Btn size="sm" onClick={() => setSelectedIds(pageCues.map(cue => cue.id))}>{t('选择当前页')}</Btn>
              <Btn size="sm" disabled={!selectedIds.length} onClick={() => setSelectedIds([])}>{t('取消选择')}</Btn>
              <span>{t('已选 {{count}} 条', { count: batchIds.length })}</span>
              <select aria-label={t('批量设置说话人')} className="ac-input" value="" disabled={!batchIds.length || readOnlyPending} onChange={event => {
                if (event.target.value) patch({ subtitles: document.subtitles.map(cue => batchIds.includes(cue.id) ? { ...cue, speaker_id: event.target.value === '__unknown' ? null : event.target.value, assignment_reason: 'manual' } : cue) })
              }}><option value="">{t('批量设置说话人')}</option><option value="__unknown">{t('未知')}</option>{document.speakers.map(speaker => <option key={speaker.speaker_id} value={speaker.speaker_id}>{speaker.display_name || speaker.speaker_id}</option>)}</select>
            </div>
            <div className="speaker-toolbar-actions">
              <label>{t('时间偏移（秒）')}<input className="ac-input" aria-label={t('时间偏移（秒）')} type="text" inputMode="decimal" value={offset} onChange={event => setOffset(event.target.value)}/></label>
              <Btn size="sm" disabled={!batchIds.length || readOnlyPending} onClick={shift}>{t('偏移选中字幕')}</Btn>
            </div>
            <div className="speaker-toolbar-actions"><input className="ac-input" aria-label={t('替换为')} placeholder={t('替换为')} value={replacement} maxLength={2000} onChange={event => setReplacement(event.target.value)}/>
              <Btn size="sm" disabled={!query.trim() || readOnlyPending} onClick={replace}>{t('替换搜索文字')}</Btn></div>
            <p className="speaker-timing-hint">{t('替换作用于选中字幕；未选择时作用于当前切片。支持撤销。')}</p>
          </details>
          <p className="speaker-timing-hint">{t('时间支持秒或 分:秒；离开时间框或按 Enter 应用，Esc 取消。')} {t('Alt + 上下键切换句子，Ctrl + Enter 试听。')}</p>
          <details className="subtitle-all-cues"><summary>{t('展开字幕列表')} · {visibleCues.length}</summary><ol className="speaker-cues" ref={cueList}>
            {pageCues.map(cue => {
              const index = cuePositions.get(cue.id)!
              const update = (changes: Partial<typeof cue>) => patch({ subtitles: document.subtitles.map(c => c.id === cue.id ? { ...c, ...changes, assignment_reason: 'manual' } : c) })
              const active = cue.start_ms <= currentTime * 1000 && currentTime * 1000 < cue.end_ms
              const speaker = document.speakers.find(s => s.speaker_id === cue.speaker_id)
              const timing = timingEdits[cue.id] || { start: String(cue.start_ms / 1000), end: String(cue.end_ms / 1000) }
              const invalidTiming = !!timingEdits[cue.id] && !speakerCueTiming(timing.start, timing.end, document.duration_ms)
              const inputTiming = (field: 'start' | 'end', value: string) => changeTimingEdits({ ...timingEditsRef.current,
                [cue.id]: { ...timing, [field]: value } })
              return <li className={`speaker-cue${active ? ' speaker-cue--active' : ''}${activeCue?.id === cue.id ? ' speaker-cue--selected' : ''}`} key={cue.id} onFocusCapture={() => { setEditingCue(cue.id); setActiveCueId(cue.id); const target = speakerCueSeek(cue, scenes || [editWindow], selectedScene); if (target && target.sceneIndex !== selectedScene) onSeek(target.seconds, target.sceneIndex) }} onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditingCue(null)
              }} style={{ '--speaker-color': speaker?.color || 'var(--ac-muted)' } as CSSProperties}>
                <div className="speaker-cue-head">
                  <input className="speaker-cue-select" type="checkbox" aria-label={`${t('选择字幕')} ${cue.id}`} checked={selectedIds.includes(cue.id)} onChange={event => setSelectedIds(event.target.checked ? [...selectedIds, cue.id] : selectedIds.filter(id => id !== cue.id))}/>
                  <span className="speaker-cue-number">{String(index + 1).padStart(2, '0')}</span>
                  <div className="speaker-cue-time" onBlur={event => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) applyTiming(cue)
                  }} onKeyDown={event => {
                    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'BUTTON') return
                    if (event.key === 'Enter' || event.key === 'Escape') {
                      event.preventDefault(); event.stopPropagation()
                      if (event.key === 'Escape') cancelTiming(cue.id); else applyTiming(cue)
                    }
                  }}>
                    <label><span>{t('起点（秒）')}</span><input className="ac-input" aria-label={`${t('起点（秒）')} ${cue.id}`} type="text" inputMode="decimal" aria-invalid={invalidTiming} value={timing.start} onChange={e => inputTiming('start', e.target.value)}/></label>
                    <span className="speaker-time-arrow" aria-hidden="true">→</span>
                    <label><span>{t('终点（秒）')}</span><input className="ac-input" aria-label={`${t('终点（秒）')} ${cue.id}`} type="text" inputMode="decimal" aria-invalid={invalidTiming} value={timing.end} onChange={e => inputTiming('end', e.target.value)}/></label>
                    <div className="speaker-time-tools">
                      <Btn size="sm" variant="text" aria-label={`${t('取播放位置为起点')} ${cue.id}`} onClick={() => inputTiming('start', String(Math.round(currentTime * 1000) / 1000))}>{t('取播放位置为起点')}</Btn>
                      <Btn size="sm" variant="text" aria-label={`${t('取播放位置为终点')} ${cue.id}`} onClick={() => inputTiming('end', String(Math.round(currentTime * 1000) / 1000))}>{t('取播放位置为终点')}</Btn>
                      {timingEdits[cue.id] && <>
                        <Btn size="sm" aria-label={`${t('应用时间')} ${cue.id}`} disabled={invalidTiming} onClick={() => applyTiming(cue)}>{t('应用时间')}</Btn>
                        <Btn size="sm" variant="text" aria-label={`${t('取消时间修改')} ${cue.id}`} onClick={() => cancelTiming(cue.id)}>{t('取消')}</Btn>
                      </>}
                    </div>
                  </div>
                  <Btn className="speaker-audition" size="sm" onClick={() => audition(cue)}><Icon name="play"/>{t('试听')}</Btn>
                </div>
                {invalidTiming && <p className="speaker-error" role="alert">{t('时间尚未应用：请填写有效起止时间，终点须晚于起点且不超过原片时长。')}</p>}
                {!timingEdits[cue.id] && needsReview(cue) && <p className="speaker-error" role="alert">{t('字幕文字不能为空，结束时间必须晚于开始时间。')}</p>}
                {!speakerCuesForScenes([cue], scenes).length && <p className="speaker-timing-hint">{t('此句已移出当前切片，仍保留在此处供修改。')}</p>}
                <textarea className="speaker-cue-text ac-input" data-cue-id={cue.id} aria-label={`${t('字幕文本')} ${cue.id}`} rows={2} maxLength={2000} value={cue.text} onSelect={event => { textCarets.current[cue.id] = event.currentTarget.selectionStart }} onKeyDown={event => {
                  if (event.nativeEvent?.isComposing) return
                  if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); audition(cue) }
                  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                    event.preventDefault()
                    selectCue(visibleCues[Math.max(0, Math.min(visibleCues.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))])
                  }
                }} onChange={e => update({ text: e.target.value })}/>
                <div className="speaker-cue-footer">
                  <div className="speaker-cue-assignment"><span className="speaker-cue-dot"/>
                    <select className="speaker-inline-select" aria-label={`${t('说话人')} ${cue.id}`} value={cue.speaker_id || ''} onChange={e => update({ speaker_id: e.target.value || null })}>
                      <option value="">{t('未知')}</option>{document.speakers.map((s, i) => <option key={s.speaker_id} value={s.speaker_id}>{s.display_name && s.display_name !== s.speaker_id ? s.display_name : `${t('说话人')} ${i + 1}`}</option>)}
                    </select>
                    <span className="speaker-cue-divider"/>
                    <select className="speaker-inline-select" aria-label={`${t('字幕行')} ${cue.id}`} value={cue.layer} onChange={e => update({ layer: Number(e.target.value) })}><option value={0}>{t('下行')}</option><option value={1}>{t('上行')}</option></select>
                  </div>
                  <div className="speaker-cue-actions">
                    <Btn size="sm" variant="text" aria-label={`${t('拆句')} ${cue.id}`} disabled={readOnlyPending} onClick={() => splitCue(cue)}>{t('拆句')}</Btn>
                    <Btn size="sm" variant="text" aria-label={`${t('合句')} ${cue.id}`} disabled={readOnlyPending} onClick={() => mergeCue(cue)}>{t('合句')}</Btn>
                    <Btn className="speaker-icon-button" variant="text" size="sm" title={t('上移')} aria-label={`${t('上移')} ${cue.id}`} disabled={index === 0} onClick={() => patch({ subtitles: moveSpeakerCueInScenes(document.subtitles, scenes, cue.id, -1, retainedIds) })}><Icon name="up"/></Btn>
                    <Btn className="speaker-icon-button" variant="text" size="sm" title={t('下移')} aria-label={`${t('下移')} ${cue.id}`} disabled={index === visibleCues.length - 1} onClick={() => patch({ subtitles: moveSpeakerCueInScenes(document.subtitles, scenes, cue.id, 1, retainedIds) })}><Icon name="down"/></Btn>
                    <Btn className="speaker-icon-button" variant="text" size="sm" title={t('在此后补句')} aria-label={`${t('在此后补句')} ${cue.id}`} disabled={document.subtitles.length >= 10000} onClick={() => addCue(cue.id)}><Icon name="plus"/></Btn>
                    <Btn className="speaker-icon-button speaker-delete-button" variant="danger" size="sm" title={t('移除')} aria-label={`${t('移除')} ${cue.id}`} onClick={() => {
                      const index = document.subtitles.findIndex(c => c.id === cue.id)
                      setRemoved({ cue, index, following: document.subtitles[index + 1]?.id, timing: timingEditsRef.current[cue.id] }); cancelTiming(cue.id)
                      patch({ subtitles: document.subtitles.filter(c => c.id !== cue.id) })
                    }}><Icon name="remove"/></Btn>
                  </div>
                </div>
              </li>
            })}
          </ol></details>
          {pageCount > 1 && <div className="speaker-pagination">
            <Btn size="sm" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>{t('上一页')}</Btn>
            <span>{pageIndex + 1} / {pageCount}</span>
            <Btn size="sm" disabled={pageIndex + 1 >= pageCount} onClick={() => setPage(pageIndex + 1)}>{t('下一页')}</Btn>
          </div>}
          {!shownCues.length && <p className="speaker-empty">{t(visibleCues.length ? '没有符合筛选条件的字幕。' : '当前切片没有对应字幕，可补充字幕。')}</p>}
          {removed && <div className="speaker-undo" role="status"><span>{t('已删除一条字幕')}</span><Btn size="sm" variant="text" disabled={document.subtitles.length >= 10000} onClick={() => {
            const subtitles = [...document.subtitles]
            const following = subtitles.findIndex(c => c.id === removed.following)
            if (!subtitles.some(c => c.id === removed.cue.id)) subtitles.splice(following < 0 ? Math.min(removed.index, subtitles.length) : following, 0, removed.cue)
            clearFilters(); retain(removed.cue.id)
            if (removed.timing) changeTimingEdits({ ...timingEditsRef.current, [removed.cue.id]: removed.timing })
            patch({ subtitles }); setFocusCue(removed.cue.id); setRemoved(null)
          }}>{t('撤销删除')}</Btn></div>}
          <div className="speaker-bottom-bar"><Btn className="speaker-add-button" disabled={document.subtitles.length >= 10000} onClick={() => addCue()}><Icon name="plus"/>{t('补充字幕')}</Btn>
            {!dirty && !Object.keys(timingEdits).length && <a className="speaker-ass-link" href={`${api.defaults.baseURL}/studio/${projectId}/drafts/${draftId}/speaker-subtitles.ass`} download>{t('下载 ASS')}<span aria-hidden="true">↗</span></a>}
          </div>
          <p className="speaker-save-hint">{t('修改后保存草稿，再导出字幕或成片。')}</p>
        </section>
      </>}
    </div>
    <Dialog open={!!addition} title={t('补充字幕')} onClose={() => setAddition(null)}
      footer={<div className="studio-actions"><Btn onClick={() => setAddition(null)}>{t('取消')}</Btn><Btn variant="cta" onClick={confirmAddition}>{t('加入当前草稿')}</Btn></div>}>
      {addition && <div className="subtitle-add-dialog"><p className="subtitle-repair-hint">{clockTime(addition.start)} — {clockTime(addition.end)} · {t('原片时间')}</p>
        <label>{t('字幕正文')}<textarea className="ac-input" autoFocus aria-label={t('补句正文')} value={additionText} maxLength={2000} onChange={event => setAdditionText(event.target.value)}/></label>
        <label>{t('说话人')}<select className="ac-input" aria-label={t('补句说话人')} value={addition.speaker || ''} onChange={event => setAddition({ ...addition, speaker: event.target.value || null })}>
          <option value="">{t('未知')}</option>{document?.speakers.map(speaker => <option key={speaker.speaker_id} value={speaker.speaker_id}>{speaker.display_name || speaker.speaker_id}</option>)}</select></label>
        <label>{t('字幕行')}<select className="ac-input" aria-label={t('补句字幕行')} value={addition.layer} onChange={event => setAddition({ ...addition, layer: Number(event.target.value) })}><option value={0}>{t('下行')}</option><option value={1}>{t('上行')}</option></select></label>
        {additionError && <p role="alert" className="speaker-error">{additionError}</p>}
      </div>}
    </Dialog>
  </details>
}
