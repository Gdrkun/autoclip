import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { SpeakerCaptionLayout, SpeakerDocument } from './types'
import { insertSpeakerCue, moveSpeakerCue, sortSpeakerCues } from './speakerSubtitleEditing'
import './speaker-subtitles.css'

type State = { job: { job_id?: string; status: string; error?: string }; document: SpeakerDocument | null }

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

export default function SpeakerSubtitles({ projectId, draftId, document, layout, enabled, dirty, currentTime, onChange, onLayout, onEnabled, onSeek }: {
  projectId: string; draftId: string; document?: SpeakerDocument | null; enabled: boolean; dirty: boolean; currentTime: number
  layout?: SpeakerCaptionLayout | null; onLayout: (value: SpeakerCaptionLayout | null) => void
  onChange: (value: SpeakerDocument) => void; onEnabled: (value: boolean) => void; onSeek: (seconds: number) => void
}) {
  const [backend, setBackend] = useState('whisper')
  const [prompt, setPrompt] = useState('')
  const [reuse, setReuse] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<State['job']>({ status: 'idle' })
  const [recognized, setRecognized] = useState<SpeakerDocument | null>(null)
  const apply = useRef(onChange)
  apply.current = onChange
  const requested = useRef(!document)
  const base = `/studio/${projectId}/speaker-subtitles`
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const state = await api.get<unknown, State>(base)
        if (!active) return
        setJob(state.job)
        setRecognized(state.document)
        if (state.document && requested.current && ['completed', 'idle'].includes(state.job.status)) {
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
  const processing = busy || ['queued', 'running'].includes(job.status)
  const layoutValue = layout || { font_scale: 1, x: .5, y: .91 }
  const outline = { enabled: layout?.outline_enabled !== false, width: layout?.outline_width ?? 2, color: layout?.outline_color || '#000000' }
  const patchOutline = (update: Partial<SpeakerCaptionLayout>) => onLayout({ ...layoutValue,
    outline_enabled: outline.enabled, outline_width: outline.width, outline_color: outline.color, ...update })
  const patch = (update: Partial<SpeakerDocument>) => { if (document) onChange({ ...document, ...update }) }
  return <details className="speaker-panel" open={!!document}>
    <summary className="speaker-panel-summary">
      <span className="speaker-panel-symbol"><Icon name="people"/></span>
      <span className="speaker-panel-title"><strong>{t('说话人字幕')}</strong><span>{t('本地识别和纠错，不重新分析高光。')}</span></span>
      {document && <span className="speaker-panel-count">{document.subtitles.length} {t('条字幕')}</span>}
      <span className="speaker-panel-chevron"><Icon name="chevron"/></span>
    </summary>
    <div className="speaker-panel-body">
      <details className="speaker-recognition" open={!document}>
        <summary><Icon name="settings"/><span>{t('识别设置')}</span><span className="speaker-recognition-status">{processing ? t('正在识别字幕…') : 'CPU'}</span><Icon name="chevron"/></summary>
        <div className="speaker-recognition-body">
          <div className="speaker-recognition-fields">
            <label className="speaker-field"><span>{t('转写模型')}</span><select className="ac-input" aria-label={t('转写模型')} value={backend} onChange={e => setBackend(e.target.value)}><option value="whisper">Whisper medium · CPU</option><option value="sensevoice">SenseVoiceSmall · CPU</option></select></label>
            <label className="speaker-field"><span>{t('转写提示词')}</span><input className="ac-input" aria-label={t('转写提示词')} value={prompt} maxLength={500} onChange={e => setPrompt(e.target.value)}/></label>
          </div>
          <div className="speaker-recognition-footer">
            <label className="speaker-check"><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)}/><span>{t('复用已有字幕')}</span></label>
            <div className="speaker-buttons"><Btn size="sm" disabled={processing} loading={processing} onClick={() => void recognize()}>{processing ? t('正在识别字幕…') : document ? t('重新识别说话人字幕') : t('识别说话人字幕')}</Btn>
              {recognized && job.status === 'completed' && <Btn size="sm" disabled={processing} onClick={() => onChange(recognized)}>{t('应用识别结果')}</Btn>}
            </div>
          </div>
        </div>
      </details>
      {(error || job.error) && <p role="alert" className="speaker-error">{t(error || job.error || '')}</p>}
      {document && <>
        <section className="speaker-section">
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
        <section className="speaker-section">
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
        <section className="speaker-section speaker-captions-section">
          <div className="speaker-section-head"><div><h3>{t('逐句校对')}<span className="speaker-small-count">{document.subtitles.length}</span></h3><p>{t('排序不改变字幕时间；播放顺序由时间决定。')}</p></div><Btn size="sm" onClick={() => patch({ subtitles: sortSpeakerCues(document.subtitles) })}>{t('按时间排序')}</Btn></div>
          <ol className="speaker-cues">
            {document.subtitles.map((cue, index) => {
              const update = (changes: Partial<typeof cue>) => patch({ subtitles: document.subtitles.map(c => c.id === cue.id ? { ...c, ...changes, assignment_reason: 'manual' } : c) })
              const active = cue.start_ms <= currentTime * 1000 && currentTime * 1000 < cue.end_ms
              const speaker = document.speakers.find(s => s.speaker_id === cue.speaker_id)
              return <li className={`speaker-cue${active ? ' speaker-cue--active' : ''}`} key={cue.id} style={{ '--speaker-color': speaker?.color || 'var(--ac-muted)' } as CSSProperties}>
                <div className="speaker-cue-head">
                  <span className="speaker-cue-number">{String(index + 1).padStart(2, '0')}</span>
                  <div className="speaker-cue-time">
                    <label><span>{t('起点（秒）')}</span><input className="ac-input" aria-label={`${t('起点（秒）')} ${cue.id}`} type="number" min={0} max={document.duration_ms / 1000} step={.01} value={cue.start_ms / 1000} onChange={e => update({ start_ms: Math.round(Number(e.target.value) * 1000) })}/></label>
                    <span className="speaker-time-arrow" aria-hidden="true">→</span>
                    <label><span>{t('终点（秒）')}</span><input className="ac-input" aria-label={`${t('终点（秒）')} ${cue.id}`} type="number" min={0} max={document.duration_ms / 1000} step={.01} value={cue.end_ms / 1000} onChange={e => update({ end_ms: Math.round(Number(e.target.value) * 1000) })}/></label>
                  </div>
                  <Btn className="speaker-audition" size="sm" onClick={() => onSeek(cue.start_ms / 1000)}><Icon name="play"/>{t('试听')}</Btn>
                </div>
                <textarea className="speaker-cue-text ac-input" aria-label={`${t('字幕文本')} ${cue.id}`} rows={2} maxLength={2000} value={cue.text} onChange={e => update({ text: e.target.value })}/>
                <div className="speaker-cue-footer">
                  <div className="speaker-cue-assignment"><span className="speaker-cue-dot"/>
                    <select className="speaker-inline-select" aria-label={`${t('说话人')} ${cue.id}`} value={cue.speaker_id || ''} onChange={e => update({ speaker_id: e.target.value || null })}>
                      <option value="">{t('未知')}</option>{document.speakers.map((s, i) => <option key={s.speaker_id} value={s.speaker_id}>{s.display_name && s.display_name !== s.speaker_id ? s.display_name : `${t('说话人')} ${i + 1}`}</option>)}
                    </select>
                    <span className="speaker-cue-divider"/>
                    <select className="speaker-inline-select" aria-label={`${t('字幕行')} ${cue.id}`} value={cue.layer} onChange={e => update({ layer: Number(e.target.value) })}><option value={0}>{t('下行')}</option><option value={1}>{t('上行')}</option></select>
                  </div>
                  <div className="speaker-cue-actions">
                    <Btn className="speaker-icon-button" variant="text" size="sm" title={t('上移')} aria-label={`${t('上移')} ${cue.id}`} disabled={index === 0} onClick={() => patch({ subtitles: moveSpeakerCue(document.subtitles, index, -1) })}><Icon name="up"/></Btn>
                    <Btn className="speaker-icon-button" variant="text" size="sm" title={t('下移')} aria-label={`${t('下移')} ${cue.id}`} disabled={index === document.subtitles.length - 1} onClick={() => patch({ subtitles: moveSpeakerCue(document.subtitles, index, 1) })}><Icon name="down"/></Btn>
                    <Btn className="speaker-icon-button" variant="text" size="sm" title={t('在此后补句')} aria-label={`${t('在此后补句')} ${cue.id}`} disabled={document.subtitles.length >= 10000} onClick={() => patch({ subtitles: insertSpeakerCue(document, currentTime, crypto.randomUUID(), t('新增字幕'), cue.id) })}><Icon name="plus"/></Btn>
                    <Btn className="speaker-icon-button" variant="danger" size="sm" title={t('移除')} aria-label={`${t('移除')} ${cue.id}`} onClick={() => patch({ subtitles: document.subtitles.filter(c => c.id !== cue.id) })}><Icon name="remove"/></Btn>
                  </div>
                </div>
              </li>
            })}
          </ol>
          {!document.subtitles.length && <p className="speaker-empty">{t('还没有字幕，播放视频后添加第一句。')}</p>}
          <div className="speaker-bottom-bar"><Btn className="speaker-add-button" disabled={document.subtitles.length >= 10000} onClick={() => patch({ subtitles: insertSpeakerCue(document, currentTime, crypto.randomUUID(), t('新增字幕')) })}><Icon name="plus"/>{t('补充字幕')}</Btn>
            {!dirty && <a className="speaker-ass-link" href={`${api.defaults.baseURL}/studio/${projectId}/drafts/${draftId}/speaker-subtitles.ass`} download>{t('下载 ASS')}<span aria-hidden="true">↗</span></a>}
          </div>
          <p className="speaker-save-hint">{t('修改后保存草稿，再导出字幕或成片。')}</p>
        </section>
      </>}
    </div>
  </details>
}
