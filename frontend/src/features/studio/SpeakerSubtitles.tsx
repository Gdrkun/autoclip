import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { SpeakerCaptionLayout, SpeakerDocument } from './types'
import { insertSpeakerCue, moveSpeakerCue, sortSpeakerCues } from './speakerSubtitleEditing'

type State = { job: { job_id?: string; status: string; error?: string }; document: SpeakerDocument | null }

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
  const patch = (update: Partial<SpeakerDocument>) => { if (document) onChange({ ...document, ...update }) }
  return <details className="studio-details" open={!!document}>
    <summary>{t('说话人字幕')}</summary>
    <p className="studio-muted">{t('本地识别和纠错，不重新分析高光。')}</p>
    <div className="studio-row" style={{ flexWrap: 'wrap', gap: 12 }}>
      <label>{t('转写模型')} <select aria-label={t('转写模型')} value={backend} onChange={e => setBackend(e.target.value)}><option value="whisper">Whisper medium · CPU</option><option value="sensevoice">SenseVoiceSmall · CPU</option></select></label>
      <label>{t('转写提示词')} <input aria-label={t('转写提示词')} value={prompt} maxLength={500} onChange={e => setPrompt(e.target.value)}/></label>
      <label><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)}/>{t('复用已有字幕')}</label>
      <Btn disabled={processing} onClick={() => void recognize()}>{processing ? t('正在识别字幕…') : document ? t('重新识别说话人字幕') : t('识别说话人字幕')}</Btn>
      {recognized && job.status === 'completed' && <Btn disabled={processing} onClick={() => onChange(recognized)}>{t('应用识别结果')}</Btn>}
    </div>
    {(error || job.error) && <p role="alert" className="studio-error">{t(error || job.error || '')}</p>}
    {document && <>
      <label><input type="checkbox" checked={enabled} onChange={e => onEnabled(e.target.checked)}/>{t('启用双色字幕')}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '12px 0' }}>
        {document.speakers.map(speaker => <div key={speaker.speaker_id}>
          <span>{speaker.speaker_id} </span>
          <input aria-label={`${t('说话人名称')} ${speaker.speaker_id}`} placeholder={speaker.speaker_id} maxLength={40} value={speaker.display_name}
            onChange={e => patch({ speakers: document.speakers.map(s => s.speaker_id === speaker.speaker_id ? { ...s, display_name: e.target.value } : s) })}/>
          <input type="color" aria-label={`${t('字幕颜色')} ${speaker.speaker_id}`} value={speaker.color}
            onChange={e => patch({ speakers: document.speakers.map(s => s.speaker_id === speaker.speaker_id ? { ...s, color: e.target.value } : s) })}/>
        </div>)}
      </div>
      <div className="studio-row" style={{ flexWrap: 'wrap', gap: 16 }}>
        <label>{t('字幕大小（%）')} <input type="range" aria-label={t('字幕大小（%）')} min={50} max={250} step={5} value={Math.round(layoutValue.font_scale * 100)} onChange={e => onLayout({ ...layoutValue, font_scale: Number(e.target.value) / 100 })}/><output>{Math.round(layoutValue.font_scale * 100)}%</output></label>
        <label>{t('横向位置（%）')} <input type="range" aria-label={t('横向位置（%）')} min={5} max={95} step={1} value={Math.round(layoutValue.x * 100)} onChange={e => onLayout({ ...layoutValue, x: Number(e.target.value) / 100 })}/><output>{Math.round(layoutValue.x * 100)}%</output></label>
        <label>{t('纵向位置（%）')} <input type="range" aria-label={t('纵向位置（%）')} min={15} max={95} step={1} value={Math.round(layoutValue.y * 100)} onChange={e => onLayout({ ...layoutValue, y: Number(e.target.value) / 100 })}/><output>{Math.round(layoutValue.y * 100)}%</output></label>
        <Btn size="sm" onClick={() => onLayout(null)}>{t('恢复字幕布局')}</Btn>
      </div>
      <p className="studio-muted">{t('100% 为默认字号；位置按画面百分比。')}</p>
      <div className="studio-row" style={{ flexWrap: 'wrap', gap: 12 }}><Btn size="sm" onClick={() => patch({ subtitles: sortSpeakerCues(document.subtitles) })}>{t('按时间排序')}</Btn><span className="studio-muted">{t('排序不改变字幕时间；播放顺序由时间决定。')}</span></div>
      <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
        <table style={{ width: '100%', textAlign: 'left' }}>
          <thead><tr><th>{t('起点（秒）')}</th><th>{t('终点（秒）')}</th><th>{t('字幕文本')}</th><th>{t('说话人')}</th><th>{t('字幕行')}</th><th>{t('操作')}</th></tr></thead>
          <tbody>{document.subtitles.map((cue, index) => {
            const update = (changes: Partial<typeof cue>) => patch({ subtitles: document.subtitles.map(c => c.id === cue.id ? { ...c, ...changes, assignment_reason: 'manual' } : c) })
            return <tr key={cue.id}>
              <td><input aria-label={`${t('起点（秒）')} ${cue.id}`} type="number" min={0} max={document.duration_ms / 1000} step={.01} style={{ width: 85 }} value={cue.start_ms / 1000} onChange={e => update({ start_ms: Math.round(Number(e.target.value) * 1000) })}/></td>
              <td><input aria-label={`${t('终点（秒）')} ${cue.id}`} type="number" min={0} max={document.duration_ms / 1000} step={.01} style={{ width: 85 }} value={cue.end_ms / 1000} onChange={e => update({ end_ms: Math.round(Number(e.target.value) * 1000) })}/></td>
              <td><textarea aria-label={`${t('字幕文本')} ${cue.id}`} rows={2} maxLength={2000} style={{ width: '100%', minWidth: 180 }} value={cue.text} onChange={e => update({ text: e.target.value })}/></td>
              <td><select aria-label={`${t('说话人')} ${cue.id}`} value={cue.speaker_id || ''} onChange={e => update({ speaker_id: e.target.value || null })}>
                <option value="">{t('未知')}</option>{document.speakers.map(s => <option key={s.speaker_id} value={s.speaker_id}>{s.display_name || s.speaker_id}</option>)}
              </select></td>
              <td><select aria-label={`${t('字幕行')} ${cue.id}`} value={cue.layer} onChange={e => update({ layer: Number(e.target.value) })}><option value={0}>{t('下行')}</option><option value={1}>{t('上行')}</option></select></td>
              <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <Btn size="sm" onClick={() => onSeek(cue.start_ms / 1000)}>{t('试听')}</Btn>
                <Btn size="sm" aria-label={`${t('上移')} ${cue.id}`} disabled={index === 0} onClick={() => patch({ subtitles: moveSpeakerCue(document.subtitles, index, -1) })}>{t('上移')}</Btn>
                <Btn size="sm" aria-label={`${t('下移')} ${cue.id}`} disabled={index === document.subtitles.length - 1} onClick={() => patch({ subtitles: moveSpeakerCue(document.subtitles, index, 1) })}>{t('下移')}</Btn>
                <Btn size="sm" aria-label={`${t('在此后补句')} ${cue.id}`} disabled={document.subtitles.length >= 10000} onClick={() => patch({ subtitles: insertSpeakerCue(document, currentTime, crypto.randomUUID(), t('新增字幕'), cue.id) })}>{t('在此后补句')}</Btn>
                <Btn size="sm" onClick={() => patch({ subtitles: document.subtitles.filter(c => c.id !== cue.id) })}>{t('移除')}</Btn>
              </div></td>
            </tr>
          })}</tbody>
        </table>
      </div>
      <div className="studio-actions">
        <Btn disabled={document.subtitles.length >= 10000} onClick={() => patch({ subtitles: insertSpeakerCue(document, currentTime, crypto.randomUUID(), t('新增字幕')) })}>{t('补充字幕')}</Btn>
        {!dirty && <a className="studio-link" href={`${api.defaults.baseURL}/studio/${projectId}/drafts/${draftId}/speaker-subtitles.ass`} download>{t('下载 ASS')}</a>}
        <span className="studio-muted">{t('修改后保存草稿，再导出字幕或成片。')}</span>
      </div>
    </>}
  </details>
}
