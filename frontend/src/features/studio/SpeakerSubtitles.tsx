import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { Scene, SpeakerCaptionLayout, SpeakerCue, SpeakerDocument } from './types'
import { insertSpeakerCueInScenes, moveSpeakerCueInScenes, sortSpeakerCuesInScenes, speakerCuesForScenes, speakerCueSeek, speakerCueTiming } from './speakerSubtitleEditing'
import './speaker-subtitles.css'
import CorrectionSuggestions from './CorrectionSuggestions'

type State = { job: { job_id?: string; status: string; error?: string; percent?:number; completed_chunks?:number; total_chunks?:number }; document: SpeakerDocument | null }

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

export default function SpeakerSubtitles({ projectId, draftId, document, layout, enabled, dirty, currentTime, scenes, selectedScene = 0, autoEnabled = true, onChange, onApply, onLayout, onEnabled, onSeek, onTimingPendingChange }: {
  projectId: string; draftId: string; document?: SpeakerDocument | null; enabled: boolean; dirty: boolean; currentTime: number
  scenes?: Pick<Scene, 'start' | 'end'>[]; selectedScene?: number
  autoEnabled?: boolean
  layout?: SpeakerCaptionLayout | null; onLayout: (value: SpeakerCaptionLayout | null) => void
  onChange: (value: SpeakerDocument) => void; onApply: (value: SpeakerDocument) => void; onEnabled: (value: boolean) => void; onSeek: (seconds: number, sceneIndex?: number) => void
  onTimingPendingChange?: (pending: boolean) => void
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
  const base = `/studio/${projectId}/speaker-subtitles`
  useEffect(() => {
    if (!document) requested.current = enabled && autoEnabled
  }, [document, enabled, autoEnabled])
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const state = await api.get<unknown, State>(base)
        if (!active) return
        setJob(state.job)
        setRecognized(state.document)
        if (!state.document && requested.current && !autoRequested.current && ['idle', 'failed'].includes(state.job.status)) {
          autoRequested.current = true
          const automatic = await api.post<unknown, State['job']>(base + '/ensure')
          if (!active) return
          setJob(automatic)
        }
        if (state.document && requested.current && !['queued', 'running'].includes(state.job.status)) {
          requested.current = false
          apply.current({ ...state.document, speakers: state.document.speakers.map((speaker, index) => ({ ...speaker,
            color: speaker.color === '#FFFFFF' ? ['#FF91BD', '#C0A5FF'][index % 2] : speaker.color })) })
        }
      } catch (e) { if (active) setError(errorText(e)) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [base])
  const recognize = async () => {
    setBusy(true); setError('')
    try {
      const value = await api.post<unknown, State['job']>(base, { backend, prompt, reuse_subtitles: reuse })
      requested.current = true
      setJob(value)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const [timingEdits, setTimingEdits] = useState<Record<string, { start: string; end: string }>>({})
  const timingEditsRef = useRef(timingEdits)
  const changeTimingEdits = (next: typeof timingEdits) => {
    timingEditsRef.current = next
    setTimingEdits(next)
    onTimingPendingChange?.(Object.keys(next).length > 0)
  }
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
  useEffect(() => {
    if (!focusCue) return
    const input = Array.from(cueList.current?.querySelectorAll('textarea') || []).find(input => input.dataset.cueId === focusCue)
    if (input) { input.focus(); input.select(); input.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setFocusCue(null) }
  }, [focusCue, document])
  const visibleCues = document ? speakerCuesForScenes(document.subtitles, scenes, retainedIds) : []
  const needsReview = (cue: SpeakerCue) => {
    const timing = timingEdits[cue.id] || { start: String(cue.start_ms / 1000), end: String(cue.end_ms / 1000) }
    return !cue.text.trim() || !speakerCueTiming(timing.start, timing.end, document?.duration_ms ?? 0)
  }
  const reviewCount = visibleCues.filter(needsReview).length
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const cuePositions = new Map(visibleCues.map((cue, index) => [cue.id, index]))
  const shownCues = visibleCues.filter(cue => {
    // Keep the focused row while its text/time changes no longer match a filter.
    if (cue.id === editingCue || cue.id === focusCue || timingEdits[cue.id]) return true
    return (!normalizedQuery || cue.text.toLocaleLowerCase().includes(normalizedQuery)) &&
      (!speakerFilter || (cue.speaker_id || '__unknown') === speakerFilter) && (!issuesOnly || needsReview(cue))
  })
  const playbackCue = visibleCues.find(cue => cue.start_ms <= currentTime * 1000 && currentTime * 1000 < cue.end_ms) ||
    visibleCues.reduce<SpeakerCue | undefined>((nearest, cue) => !nearest || Math.abs(cue.start_ms - currentTime * 1000) < Math.abs(nearest.start_ms - currentTime * 1000) ? cue : nearest, undefined)
  const clearFilters = () => { setQuery(''); setSpeakerFilter(''); setIssuesOnly(false) }
  useEffect(() => {
    if (!revealCue) return
    const input = Array.from(cueList.current?.querySelectorAll('textarea') || []).find(input => input.dataset.cueId === revealCue)
    if (input) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setRevealCue(null) }
  }, [revealCue, editorView, query, speakerFilter, issuesOnly])
  const processing = busy || ['queued', 'running'].includes(job.status)
  const layoutValue = layout || { font_scale: 1, x: .5, y: .91 }
  const outline = { enabled: layout?.outline_enabled !== false, width: layout?.outline_width ?? 2, color: layout?.outline_color || '#000000' }
  const patchOutline = (update: Partial<SpeakerCaptionLayout>) => onLayout({ ...layoutValue,
    outline_enabled: outline.enabled, outline_width: outline.width, outline_color: outline.color, ...update })
  const patch = (update: Partial<SpeakerDocument>) => { if (document) onChange({ ...document, ...update }) }
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
            <label className="speaker-field"><span>{t('转写模型')}</span><select className="ac-input" aria-label={t('转写模型')} value={backend} onChange={e => setBackend(e.target.value)}><option value="whisper">Whisper medium · CPU</option><option value="sensevoice">SenseVoiceSmall · CPU</option></select></label>
            <label className="speaker-field"><span>{t('转写提示词')}</span><input className="ac-input" aria-label={t('转写提示词')} value={prompt} maxLength={500} onChange={e => setPrompt(e.target.value)}/></label>
          </div>
          <div className="speaker-recognition-footer">
            <label className="speaker-check"><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)}/><span>{t('复用已有字幕')}</span></label>
            <div className="speaker-buttons">{processing && <Btn size="sm" onClick={()=>void api.post(base+'/cancel').catch(e=>setError(errorText(e)))}>{t('暂停识别')}</Btn>}<Btn size="sm" disabled={processing} loading={processing} onClick={() => void recognize()}>{processing ? t('正在识别字幕…') : document ? t('重新识别说话人字幕') : t('识别说话人字幕')}</Btn>
              {recognized && job.status === 'completed' && <Btn size="sm" disabled={processing} onClick={() => onApply(recognized)}>{t('应用识别结果')}</Btn>}
            </div>
          </div>
        </div>
      </details>
      {job.total_chunks && <p className="studio-muted">{t('分段进度 {{done}} / {{total}}', {done:job.completed_chunks||0,total:job.total_chunks})}</p>}
      {(error || job.error) && <p role="alert" className="speaker-error">{t(error || job.error || '')}</p>}
      {document && <>
        <div className="speaker-view-switch" role="group" aria-label={t('字幕工具')}>
          <Btn size="sm" aria-pressed={editorView === 'captions'} onClick={() => setEditorView('captions')}>{t('字幕编辑')}</Btn>
          <Btn size="sm" aria-pressed={editorView === 'style'} onClick={() => setEditorView('style')}>{t('人物与样式')}</Btn>
        </div>
        <div hidden={editorView !== 'captions'}><CorrectionSuggestions projectId={projectId} document={document} cueIds={visibleCues.map(cue => cue.id)} onChange={onChange}/></div>
        <section className="speaker-section" hidden={editorView !== 'style'}>
          <div className="speaker-section-head"><div><h3>{t('人物与颜色')}</h3><p>{t('给说话人命名，颜色会跟随对应字幕。')}</p></div>
            <label className="speaker-color-switch"><input type="checkbox" aria-label={t('启用双色字幕')} checked={enabled} onChange={e => onEnabled(e.target.checked)}/><span className="speaker-switch-track"/><span>{t('启用双色字幕')}</span></label>
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
          <div className="speaker-layout-controls">
            <label className="speaker-slider"><span>{t('字幕大小（%）')}<output>{Math.round(layoutValue.font_scale * 100)}%</output></span><input type="range" aria-label={t('字幕大小（%）')} min={50} max={250} step={5} value={Math.round(layoutValue.font_scale * 100)} onChange={e => onLayout({ ...layoutValue, font_scale: Number(e.target.value) / 100 })}/></label>
            <label className="speaker-slider"><span>{t('横向位置（%）')}<output>{Math.round(layoutValue.x * 100)}%</output></span><input type="range" aria-label={t('横向位置（%）')} min={5} max={95} step={1} value={Math.round(layoutValue.x * 100)} onChange={e => onLayout({ ...layoutValue, x: Number(e.target.value) / 100 })}/></label>
            <label className="speaker-slider"><span>{t('纵向位置（%）')}<output>{Math.round(layoutValue.y * 100)}%</output></span><input type="range" aria-label={t('纵向位置（%）')} min={15} max={95} step={1} value={Math.round(layoutValue.y * 100)} onChange={e => onLayout({ ...layoutValue, y: Number(e.target.value) / 100 })}/></label>
          </div>
          <div className="speaker-outline-controls">
            <div className="speaker-outline-heading"><label className="speaker-color-switch"><input type="checkbox" aria-label={t('字幕描边')} checked={outline.enabled} onChange={event => patchOutline({ outline_enabled: event.target.checked })}/><span className="speaker-switch-track"/><span>{t('字幕描边')}</span></label><span className="speaker-outline-hint">{t('粗细随字号缩放，关闭后不显示描边。')}</span></div>
            <div className="speaker-outline-options">
              <label className={`speaker-outline-color${outline.enabled ? '' : ' speaker-outline-color--disabled'}`}><span>{t('描边颜色')}</span><span className="speaker-color-picker"><input type="color" aria-label={t('描边颜色')} disabled={!outline.enabled} value={outline.color} onChange={event => patchOutline({ outline_color: event.target.value })}/><span aria-hidden="true" style={{ background: outline.color }}/></span><span className="speaker-outline-hex" aria-hidden="true">{outline.color.toUpperCase()}</span></label>
              <label className={`speaker-slider${outline.enabled ? '' : ' speaker-slider--disabled'}`}><span>{t('描边粗细（px）')}<output>{outline.width}px</output></span><input type="range" aria-label={t('描边粗细（px）')} min={.5} max={8} step={.5} disabled={!outline.enabled} value={outline.width} onChange={event => patchOutline({ outline_width: Number(event.target.value) })}/></label>
            </div>
          </div>
        </section>
        <section className="speaker-section speaker-captions-section" hidden={editorView !== 'captions'}>
          <div className="speaker-section-head"><div><h3>{t('逐句校对')}<span className="speaker-small-count">{visibleCues.length}</span></h3><p>{t('仅显示当前切片的字幕；时间按原视频计。')}</p></div><Btn size="sm" onClick={() => patch({ subtitles: sortSpeakerCuesInScenes(document.subtitles, scenes, retainedIds) })}>{t('按时间排序')}</Btn></div>
          <div className="speaker-editor-toolbar">
            <div className="speaker-search-row">
              <input className="ac-input speaker-search" type="search" aria-label={t('搜索字幕文字')} placeholder={t('搜索字幕文字')} value={query} onChange={event => setQuery(event.target.value)}/>
              <select className="ac-input speaker-filter" aria-label={t('筛选说话人')} value={speakerFilter} onChange={event => setSpeakerFilter(event.target.value)}>
                <option value="">{t('全部说话人')}</option><option value="__unknown">{t('未知')}</option>
                {document.speakers.map((speaker, index) => <option key={speaker.speaker_id} value={speaker.speaker_id}>{speaker.display_name && speaker.display_name !== speaker.speaker_id ? speaker.display_name : `${t('说话人')} ${index + 1}`}</option>)}
              </select>
            </div>
            <div className="speaker-toolbar-actions">
              <Btn size="sm" aria-pressed={issuesOnly} onClick={() => setIssuesOnly(!issuesOnly)}>{t('待修正')}<span className="speaker-review-count">{reviewCount}</span></Btn>
              <Btn size="sm" disabled={!playbackCue} onClick={() => { clearFilters(); setRevealCue(playbackCue?.id || null) }}>{t('定位播放位置')}</Btn>
              <Btn size="sm" disabled={document.subtitles.length >= 10000} onClick={() => addCue()}><Icon name="plus"/>{t('在播放位置补句')}</Btn>
            </div>
            <div className="speaker-filter-status"><span role="status">{t('显示 {{shown}} / {{total}} 条', { shown: shownCues.length, total: visibleCues.length })}</span>
              {(query || speakerFilter || issuesOnly) && <Btn size="sm" variant="text" onClick={clearFilters}>{t('清除筛选')}</Btn>}
            </div>
          </div>
          <p className="speaker-timing-hint">{t('时间支持秒或 分:秒；离开时间框或按 Enter 应用，Esc 取消。')}</p>
          <ol className="speaker-cues" ref={cueList}>
            {shownCues.map(cue => {
              const index = cuePositions.get(cue.id)!
              const update = (changes: Partial<typeof cue>) => patch({ subtitles: document.subtitles.map(c => c.id === cue.id ? { ...c, ...changes, assignment_reason: 'manual' } : c) })
              const active = cue.start_ms <= currentTime * 1000 && currentTime * 1000 < cue.end_ms
              const speaker = document.speakers.find(s => s.speaker_id === cue.speaker_id)
              const timing = timingEdits[cue.id] || { start: String(cue.start_ms / 1000), end: String(cue.end_ms / 1000) }
              const invalidTiming = !!timingEdits[cue.id] && !speakerCueTiming(timing.start, timing.end, document.duration_ms)
              const inputTiming = (field: 'start' | 'end', value: string) => changeTimingEdits({ ...timingEditsRef.current,
                [cue.id]: { ...timing, [field]: value } })
              return <li className={`speaker-cue${active ? ' speaker-cue--active' : ''}`} key={cue.id} onFocusCapture={() => setEditingCue(cue.id)} onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditingCue(null)
              }} style={{ '--speaker-color': speaker?.color || 'var(--ac-muted)' } as CSSProperties}>
                <div className="speaker-cue-head">
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
                  <Btn className="speaker-audition" size="sm" onClick={() => {
                    const target = speakerCueSeek(cue, scenes || [{ start: 0, end: document.duration_ms / 1000 }], selectedScene)
                    if (target) onSeek(target.seconds, target.sceneIndex)
                  }}><Icon name="play"/>{t('试听')}</Btn>
                </div>
                {invalidTiming && <p className="speaker-error" role="alert">{t('时间尚未应用：请填写有效起止时间，终点须晚于起点且不超过原片时长。')}</p>}
                {!timingEdits[cue.id] && needsReview(cue) && <p className="speaker-error" role="alert">{t('字幕文字不能为空，结束时间必须晚于开始时间。')}</p>}
                {!speakerCuesForScenes([cue], scenes).length && <p className="speaker-timing-hint">{t('此句已移出当前切片，仍保留在此处供修改。')}</p>}
                <textarea className="speaker-cue-text ac-input" data-cue-id={cue.id} aria-label={`${t('字幕文本')} ${cue.id}`} rows={2} maxLength={2000} value={cue.text} onChange={e => update({ text: e.target.value })}/>
                <div className="speaker-cue-footer">
                  <div className="speaker-cue-assignment"><span className="speaker-cue-dot"/>
                    <select className="speaker-inline-select" aria-label={`${t('说话人')} ${cue.id}`} value={cue.speaker_id || ''} onChange={e => update({ speaker_id: e.target.value || null })}>
                      <option value="">{t('未知')}</option>{document.speakers.map((s, i) => <option key={s.speaker_id} value={s.speaker_id}>{s.display_name && s.display_name !== s.speaker_id ? s.display_name : `${t('说话人')} ${i + 1}`}</option>)}
                    </select>
                    <span className="speaker-cue-divider"/>
                    <select className="speaker-inline-select" aria-label={`${t('字幕行')} ${cue.id}`} value={cue.layer} onChange={e => update({ layer: Number(e.target.value) })}><option value={0}>{t('下行')}</option><option value={1}>{t('上行')}</option></select>
                  </div>
                  <div className="speaker-cue-actions">
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
          </ol>
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
  </details>
}
