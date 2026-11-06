import { useEffect, useRef, useState } from 'react'
import api from '../../services/api'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import { errorText } from './api'
import { clockTime } from './subtitleTimelineEditing'
import { applyRepair, repairCandidates, repairCues, repairSignature, type RepairJob } from './subtitleRepairEditing'
import type { SpeakerCue, SpeakerDocument } from './types'

export default function SubtitleRepair({ projectId, draftId, document, range, scene, backend, prompt, disabled, onApply, onAudition, activeCue }: {
  projectId: string; draftId: string; document: SpeakerDocument; range: { start: number; end: number } | null;
  scene: { start: number; end: number }; backend: string; prompt: string; disabled: boolean;
  onApply: (cues: SpeakerCue[]) => void; onAudition?: (start: number, end: number) => void
  activeCue?: SpeakerCue
}) {
  const [job, setJob] = useState<RepairJob | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0)
  const [candidates, setCandidates] = useState<SpeakerCue[]>([]), [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<'replace' | 'append'>('replace'), [allowManual, setAllowManual] = useState(false)
  const signature = useRef(''), latest = useRef(document), lock = useRef(false), epoch = useRef(0), blocked = useRef(disabled)
  const request = useRef<AbortController | null>(null)
  latest.current = document
  blocked.current = disabled
  const key = `autoclip.subtitle-repair.${projectId}.${draftId}`
  const base = `/studio/${projectId}/subtitle-repairs`
  const running = job?.status === 'queued' || job?.status === 'running'
  const persist = (value: RepairJob) => {
    try { localStorage.setItem(key, JSON.stringify({ job_id: value.job_id, signature: signature.current })) } catch { /* An open task can still finish. */ }
  }
  const forget = () => { try { localStorage.removeItem(key) } catch { /* Optional recovery record. */ } }
  const receive = (value: RepairJob) => {
    setJob(value)
    if (value.status === 'completed') {
      const original = repairCues(latest.current, value.start_ms, value.end_ms)
      const draft = repairCandidates(latest.current, value)
      setCandidates(draft); setSelected(draft.map(cue => cue.id)); setAllowManual(false)
      setMode(original.some(cue => cue.assignment_reason === 'manual' || cue.start_ms < value.start_ms || cue.end_ms > value.end_ms) ? 'append' : 'replace')
    }
  }
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null')
      if (saved && /^[a-f0-9]{32}$/.test(saved.job_id) && typeof saved.signature === 'string' && saved.signature.length < 1000000) {
        signature.current = saved.signature
        void api.get<unknown, RepairJob>(`${base}/${saved.job_id}`, { signal: controller.signal, timeout: 15000 }).then(value => {
          if (!controller.signal.aborted) { receive(value); setNotice(t('已恢复上次局部识别任务，请核对后应用。')) }
        }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)) })
      }
    } catch { forget() }
    return () => { ++epoch.current; controller.abort(); request.current?.abort() }
  }, [key, base])
  useEffect(() => {
    if (!running || !job) return
    let active = true, timer: number | undefined, failures = 0
    const controller = new AbortController(), generation = epoch.current
    const poll = async () => {
      try {
        const value = await api.get<unknown, RepairJob>(`${base}/${job.job_id}`, { signal: controller.signal, timeout: 15000 })
        if (!active || generation !== epoch.current) return
        failures = 0; setError(''); receive(value)
        if (!['queued', 'running'].includes(value.status)) return
      } catch (e) {
        if (!active || generation !== epoch.current) return
        setError(errorText(e)); if (++failures >= 3) return
      }
      timer = window.setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [base, job?.job_id, running, retry])
  const start = async (operation: 'transcribe' | 'align' = 'transcribe') => {
    const selection = range || (operation === 'align' && activeCue ? { start: Math.max(scene.start, activeCue.start_ms / 1000 - 1), end: Math.min(scene.end, activeCue.end_ms / 1000 + 1) } : null)
    if (!selection || lock.current || disabled) return
    const start = Math.round(selection.start * 1000), end = Math.round(selection.end * 1000)
    if (selection.start < scene.start || selection.end > scene.end || end - start < 100 || end - start > (operation === 'align' ? 30000 : 60000)) { setError(t(operation === 'align' ? '自动对齐请圈选当前镜头内最多 30 秒音频。' : '请在当前镜头圈选 0.1 至 60 秒的音频。')); return }
    const alignment = operation === 'align' ? (range ? repairCues(latest.current, start, end) : activeCue ? [activeCue] : []) : []
    if (operation === 'align' && (!alignment.length || alignment.some(cue => cue.start_ms < start || cue.end_ms > end))) { setError(t('请完整圈选需要对齐的字幕，或清除选区后对齐当前句。')); return }
    lock.current = true; setBusy(true); setError(''); setNotice(''); setCandidates([])
    const generation = ++epoch.current, controller = new AbortController(); request.current?.abort(); request.current = controller
    signature.current = repairSignature(latest.current, start, end)
    try {
      const wave = await api.get<unknown, { source_version: string }>(`/studio/${projectId}/subtitle-waveform`, { params: { start: selection.start, end: selection.end, points: 64 }, signal: controller.signal, timeout: 15000 })
      const identity = crypto.randomUUID().replace(/-/g, '')
      try { localStorage.setItem(key, JSON.stringify({ job_id: identity, signature: signature.current })) } catch { /* Preserve in memory if storage is unavailable. */ }
      const value = await api.post<unknown, RepairJob>(base, { request_id: identity, start: selection.start, end: selection.end, backend: operation === 'align' ? 'whisper' : backend, prompt, source_version: wave.source_version,
        ...(operation === 'align' ? {operation, alignment_cues: alignment} : {}) }, { signal: controller.signal, timeout: 15000 })
      if (generation === epoch.current && !controller.signal.aborted) { persist(value); receive(value) }
    } catch (e) { if (generation === epoch.current && !controller.signal.aborted) setError(errorText(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  const cancel = async () => {
    if (!job || lock.current) return
    lock.current = true; setBusy(true); ++epoch.current
    try { const value = await api.post<unknown, RepairJob>(`${base}/${job.job_id}/cancel`, undefined, { timeout: 15000 }); receive(value); forget() }
    catch (e) { setError(errorText(e)); setRetry(value => value + 1) }
    finally { lock.current = false; setBusy(false) }
  }
  const apply = async () => {
    if (!job || disabled || lock.current) return
    lock.current = true; setBusy(true); setError('')
    const generation = epoch.current
    try {
      const verified = await api.get<unknown, RepairJob>(`${base}/${job.job_id}`, { timeout: 15000 })
      if (generation !== epoch.current || blocked.current) return
      const result = applyRepair(latest.current, verified, signature.current, candidates.filter(cue => selected.includes(cue.id)), mode, allowManual)
      if (!result) { setError(t('选区内容已修改或替换条件不满足，请检查候选或重新识别。')); return }
      onApply(result); setJob(null); setCandidates([]); forget(); setNotice(t('已应用到当前字幕草稿，可撤销；保存草稿后生效。'))
    } catch (e) { setError(errorText(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  const originals = job ? repairCues(document, job.start_ms, job.end_ms) : []
  const manual = originals.some(cue => cue.assignment_reason === 'manual')
  const boundary = !!job && originals.some(cue => cue.start_ms < job.start_ms || cue.end_ms > job.end_ms)
  const stale = !!job && repairSignature(document, job.start_ms, job.end_ms) !== signature.current
  const change = (id: string, patch: Partial<SpeakerCue>) => setCandidates(values => values.map(cue => cue.id === id ? { ...cue, ...patch } : cue))
  return <section className="subtitle-repair" aria-label={t('选区重新识别')} aria-busy={busy || running}>
    <header><div><strong>{t('选区重新识别')}</strong><p>{range ? `${clockTime(range.start)} → ${clockTime(range.end)}` : t('在波形空白处拖选有问题的几秒音频。')}</p></div>
      <Btn size="sm" disabled={disabled || !range || busy || running} loading={busy} onClick={() => void start()}>{t('重新识别选区')}</Btn></header>
    <small>{t('只使用本地模型；先核对候选，再应用到当前草稿。')}</small>
    <div className="studio-actions"><Btn size="sm" disabled={disabled || busy || running || (!range && !activeCue)} onClick={() => void start('align')}>{t(range ? '按校正文字对齐选区' : '按校正文字对齐当前句')}</Btn><small>{t('使用已准备的 Whisper，只建议起止时间，保留你的台词。')}</small></div>
    {notice && <p role="status">{notice}</p>}{(error || job?.error) && <p role="alert" className="speaker-error">{error || t(job?.error || '')}</p>}
    {running && <div className="studio-actions"><span role="status">{t(job.stage === 'extracting' ? '正在提取选区音频…' : job.stage === 'aligning' ? '正在按校正文字对齐…' : job.stage === 'recognizing' ? '正在识别选区…' : '等待局部识别…')}</span><Btn size="sm" disabled={busy} onClick={() => void cancel()}>{t('取消本次识别')}</Btn>{error && <Btn size="sm" onClick={() => setRetry(value => value + 1)}>{t('继续查询进度')}</Btn>}</div>}
    {job?.status === 'completed' && <div className="subtitle-repair-review"><header><strong>{t(job.operation === 'align' ? '核对时间对齐候选' : '核对识别候选')} · {clockTime(job.start_ms / 1000)} → {clockTime(job.end_ms / 1000)}</strong>{onAudition && <Btn size="sm" onClick={() => onAudition(job.start_ms / 1000, job.end_ms / 1000)}>{t('试听选区')}</Btn>}</header>
      <details><summary>{t('选区内原字幕')} · {originals.length}</summary>{originals.map(cue => <p key={cue.id}>{clockTime(cue.start_ms / 1000)} · {cue.text} {cue.assignment_reason === 'manual' && <b>{t('已手工校对')}</b>}</p>)}</details>
      {!candidates.length && <p>{t('本次没有识别到有效字幕，可缩短选区重试或手动补句。')}</p>}
      <fieldset disabled={busy || disabled} className="subtitle-repair-candidates">{candidates.map((cue, index) => <div key={cue.id}><label><input type="checkbox" aria-label={`${t('选用候选')} ${index + 1}`} checked={selected.includes(cue.id)} onChange={event => setSelected(event.target.checked ? [...selected, cue.id] : selected.filter(id => id !== cue.id))}/>{t('候选字幕')} {index + 1}</label><textarea className="ac-input" aria-label={`${t('候选字幕正文')} ${index + 1}`} value={cue.text} readOnly={job.operation === 'align'} maxLength={2000} rows={2} onChange={event => change(cue.id, { text: event.target.value })}/>
        <div><label>{t('原片起点')}<input className="ac-input" type="number" step="0.1" value={cue.start_ms / 1000} onChange={event => change(cue.id, { start_ms: Math.round(event.target.valueAsNumber * 1000) })}/></label><label>{t('原片终点')}<input className="ac-input" type="number" step="0.1" value={cue.end_ms / 1000} onChange={event => change(cue.id, { end_ms: Math.round(event.target.valueAsNumber * 1000) })}/></label><label>{t('说话人')}<select className="ac-input" disabled={job.operation === 'align'} value={cue.speaker_id || ''} onChange={event => change(cue.id, { speaker_id: event.target.value || null })}><option value="">{t('待确认人物')}</option>{document.speakers.map(person => <option key={person.speaker_id} value={person.speaker_id}>{person.display_name || person.speaker_id}</option>)}</select></label><label>{t('字幕行')}<select className="ac-input" disabled={job.operation === 'align'} value={cue.layer} onChange={event => change(cue.id, { layer: Number(event.target.value) })}><option value="0">{t('第一行')}</option><option value="1">{t('第二行')}</option></select></label></div>
      </div>)}</fieldset>
      <div hidden={job.operation === 'align'} className="subtitle-repair-modes"><label><input type="radio" checked={mode === 'append'} disabled={busy} onChange={() => setMode('append')}/>{t('仅补充字幕，保留原句')}</label><label><input type="radio" checked={mode === 'replace'} disabled={busy || boundary} onChange={() => setMode('replace')}/>{t('替换选区内字幕')}</label>{mode === 'replace' && manual && <label><input type="checkbox" checked={allowManual} onChange={event => setAllowManual(event.target.checked)}/>{t('允许替换选区内已手工校对的字幕')}</label>}</div>
      {boundary && <p>{t('有字幕跨过选区边界，请调整选区后替换；也可以仅补充字幕。')}</p>}{job.operation !== 'align' && mode === 'append' && originals.length > 0 && <p>{t('原字幕会保留；重叠发言可选择另一人物和第二行，避免重复。')}</p>}{stale && <p role="alert">{t('识别期间选区字幕已修改，请重新识别以保留最新校对。')}</p>}
      <div className="studio-actions"><Btn size="sm" variant="cta" disabled={busy || disabled || stale || !selected.length || (job.operation !== 'align' && mode === 'replace' && (boundary || (manual && !allowManual)))} onClick={() => void apply()}>{t('应用选中候选')}</Btn><Btn size="sm" disabled={busy} onClick={() => { setJob(null); setCandidates([]); forget() }}>{t('放弃本次候选')}</Btn></div>
    </div>}
  </section>
}
