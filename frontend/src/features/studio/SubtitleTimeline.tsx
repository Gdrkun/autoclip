import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { SpeakerCue, SpeakerDocument } from './types'
import { clockTime } from './subtitleTimelineEditing'
import './subtitle-timeline.css'

type Range = { start: number; end: number }
type Waveform = { start_ms: number; end_ms: number; peaks: number[]; source_version: string }
type Drag = { id?: string; part: string; origin: number; start: number; end: number; currentStart: number; currentEnd: number }
export default function SubtitleTimeline({ projectId, document, scene, time, selectedId, onSelect, onSeek, onCommit, onRange,
  onPause, disabled = false }: {
  projectId: string; document: SpeakerDocument; scene: Range; time: number; selectedId?: string
  onSelect: (cue: SpeakerCue) => void; onSeek: (seconds: number) => void; onPause?: () => void
  onCommit: (id: string, start: number, end: number) => void; onRange: (range: Range | null) => void; disabled?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(500)
  const [span, setSpan] = useState(30)
  const [origin, setOrigin] = useState(scene.start)
  const [sourceTimes, setSourceTimes] = useState(false)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [selection, setSelection] = useState<Range | null>(null)
  const [preview, setPreview] = useState<Drag | null>(null)
  const drag = useRef<Drag | null>(null)
  const [snap, setSnap] = useState(true)
  const viewLength = Math.min(span, scene.end - scene.start)
  const start = Math.max(scene.start, Math.min(origin, scene.end - viewLength)), end = start + viewLength
  const left = width < 420 ? 64 : 82, right = width - 10, plot = Math.max(80, right - left)
  const x = (at: number) => left + (at - start) / viewLength * plot
  const fmt = (at: number) => clockTime(sourceTimes ? at : at - scene.start)
  const shown = useMemo(() => document.subtitles.filter(cue => cue.start_ms < end * 1000 && cue.end_ms > start * 1000),
    [document.subtitles, start, end])
  const lanes = useMemo(() => {
    const rows = document.speakers.map((speaker, index) => ({ id: speaker.speaker_id as string | null,
      label: speaker.display_name && speaker.display_name !== speaker.speaker_id ? speaker.display_name : t('人物 {{number}}', { number: index + 1 }), color: speaker.color }))
    if (!rows.length || shown.some(cue => cue.speaker_id === null)) rows.push({ id: null, label: t('未知'), color: '#858585' })
    return rows
  }, [document.speakers, shown])
  const height = 112 + lanes.length * 48
  useEffect(() => {
    const measure = () => setWidth(Math.max(260, box.current?.clientWidth || 500))
    measure()
    const observer = new ResizeObserver(measure)
    if (box.current) observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setOrigin(scene.start); setSelection(null); onRange(null); drag.current = null; setPreview(null)
  }, [scene.start, scene.end])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setWave(null)
    void api.get<unknown, Waveform>(`/studio/${projectId}/subtitle-waveform`, {
      params: { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, points: 800 }, signal: controller.signal,
    }).then(value => { if (!controller.signal.aborted) setWave(value) })
      .catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId, start, end, retry])
  const waveform = useMemo(() => {
    if (!wave?.peaks.length) return ''
    const amplitude = Math.max(.03, ...wave.peaks)
    return wave.peaks.map((peak, index) => {
      const position = left + index / Math.max(1, wave.peaks.length - 1) * plot
      const size = Math.max(.6, peak / amplitude * 18)
      return `M${position.toFixed(1)},${(50 - size).toFixed(1)}V${(50 + size).toFixed(1)}`
    }).join(' ')
  }, [wave, left, plot])
  const point = (clientX: number) => {
    const bounds = svg.current!.getBoundingClientRect()
    return Math.max(scene.start, Math.min(scene.end, start + ((clientX - bounds.left) / bounds.width * width - left) / plot * viewLength))
  }
  const snapTime = (at: number, cueId?: string) => {
    let result = Math.round(at * 1000) / 1000
    if (snap) {
      const candidates = [time, scene.start, scene.end, ...shown.filter(cue => cue.id !== cueId).flatMap(cue => [cue.start_ms / 1000, cue.end_ms / 1000])]
      const nearest = candidates.reduce((best, value) => Math.abs(value - at) < Math.abs(best - at) ? value : best, candidates[0])
      if (Math.abs(nearest - at) <= Math.min(.12, viewLength / plot * 6)) result = nearest
    }
    return Math.round(result * 1000) / 1000
  }
  const finish = (cancelled = false) => {
    const active = drag.current
    drag.current = null; setPreview(null)
    if (!active || cancelled) return
    if (active.id) {
      if (active.currentStart !== active.start || active.currentEnd !== active.end) onCommit(active.id, active.currentStart, active.currentEnd)
    } else if (active.currentEnd - active.currentStart >= .1) {
      const range = { start: active.currentStart, end: active.currentEnd }; setSelection(range); onRange(range)
    } else { setSelection(null); onRange(null); onSeek(active.origin) }
  }
  const ticks = width < 420 ? 3 : 5
  return <section className="subtitle-timeline" aria-label={t('音频波形与字幕时间轴')}>
    <header className="subtitle-timeline-heading"><strong>{t('音频波形与字幕时间轴')}</strong>
      <span className="subtitle-timeline-readout">{fmt(time)}</span></header>
    <div className="subtitle-timeline-toolbar">
      <Btn size="sm" aria-label={t('前一段时间轴')} disabled={start <= scene.start} onClick={() => setOrigin(start - viewLength * .8)}>‹</Btn>
      <label>{t('显示范围')}<select className="ac-input" aria-label={t('时间轴显示范围')} value={span} onChange={event => {
        setSpan(Number(event.target.value)); setOrigin(Math.max(scene.start, time - Number(event.target.value) / 2))
      }}>{[10, 30, 60, 120].map(seconds => <option key={seconds} value={seconds}>{t('{{seconds}} 秒', { seconds })}</option>)}</select></label>
      <Btn size="sm" aria-label={t('后一段时间轴')} disabled={end >= scene.end - .001} onClick={() => setOrigin(start + viewLength * .8)}>›</Btn>
      <Btn size="sm" onClick={() => setOrigin(time - viewLength / 2)}>{t('跟随播放头')}</Btn>
      <label className="speaker-check"><input type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)}/>{t('吸附边界')}</label>
      <Btn variant="text" size="sm" onClick={() => setSourceTimes(!sourceTimes)}>{t(sourceTimes ? '原片时间' : '当前镜头时间')}</Btn>
    </div>
    <div ref={box} className="subtitle-timeline-plot">
      <svg ref={svg} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={t('拖动字幕块移动，拖两端调整时间；拖选波形可补句。')}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return
          const target = event.target as SVGElement, group = target.closest('[data-cue-id]') as SVGElement | null
          const cue = group ? document.subtitles.find(row => row.id === group.dataset.cueId) : null
          if (cue) {
            onSelect(cue)
            if (cue.start_ms < scene.start * 1000 || cue.end_ms > scene.end * 1000) return
          }
          onPause?.()
          const at = point(event.clientX)
          drag.current = cue ? { id: cue.id, part: target.dataset.part || 'move', origin: at,
            start: cue.start_ms / 1000, end: cue.end_ms / 1000, currentStart: cue.start_ms / 1000, currentEnd: cue.end_ms / 1000 }
            : { part: 'selection', origin: at, start: at, end: at, currentStart: at, currentEnd: at }
          event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault()
        }} onPointerMove={event => {
          const value = drag.current
          if (!value) return
          const at = point(event.clientX), delta = at - value.origin
          if (!value.id) { value.currentStart = Math.min(value.origin, at); value.currentEnd = Math.max(value.origin, at) }
          else if (value.part === 'start') value.currentStart = Math.max(scene.start, Math.min(value.end - .1, snapTime(value.start + delta, value.id)))
          else if (value.part === 'end') value.currentEnd = Math.min(scene.end, Math.max(value.start + .1, snapTime(value.end + delta, value.id)))
          else {
            const duration = value.end - value.start
            value.currentStart = Math.max(scene.start, Math.min(scene.end - duration, snapTime(value.start + delta, value.id)))
            value.currentEnd = value.currentStart + duration
          }
          setPreview({ ...value })
        }} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => { if (drag.current) finish(true) }}>
        <title>{t('音频波形与字幕时间轴')}</title>
        <defs><clipPath id={`subtitle-plot-${projectId}`}><rect x={left} y={22} width={plot} height={height - 22}/></clipPath></defs>
        {Array.from({ length: ticks }, (_, index) => {
          const at = start + viewLength * index / (ticks - 1)
          return <g key={index}><line x1={x(at)} x2={x(at)} y1={24} y2={height - 8} stroke="var(--ac-line)"/>
            <text x={x(at)} y={15} textAnchor={index === 0 ? 'start' : index === ticks - 1 ? 'end' : 'middle'}>{fmt(at)}</text></g>
        })}
        <text x={3} y={54}>{t('波形')}</text>
        <path d={waveform} fill="none" stroke="var(--ac-accent)" strokeWidth={1}/>
        <g clipPath={`url(#subtitle-plot-${projectId})`}>
          {(preview?.part === 'selection' ? preview : selection) && (() => {
            const a = preview?.part === 'selection' ? preview.currentStart : selection!.start
            const b = preview?.part === 'selection' ? preview.currentEnd : selection!.end
            return <rect x={x(a)} y={26} width={Math.max(1, x(b) - x(a))} height={height - 34} fill="var(--ac-accent)" opacity={.1} pointerEvents="none"/>
          })()}
          {lanes.map((lane, laneIndex) => <g key={lane.id || 'unknown'}>
            <rect x={left} y={80 + laneIndex * 48} width={plot} height={36} rx={5} fill="var(--ac-bg)"/>
            {shown.filter(cue => cue.speaker_id === lane.id).map(cue => {
              const value = preview?.id === cue.id ? preview : null
              const a = value?.currentStart ?? cue.start_ms / 1000, b = value?.currentEnd ?? cue.end_ms / 1000
              const active = selectedId === cue.id, y = 80 + laneIndex * 48
              return <g key={cue.id} data-cue-id={cue.id}>
                <rect data-part="move" className="subtitle-timeline-cue" x={x(a)} y={y} width={Math.max(2, x(b) - x(a))} height={36}
                  rx={5} fill={lane.color} fillOpacity={active ? .42 : .2} stroke={active ? 'var(--ac-accent)' : 'none'} strokeWidth={1.5}/>
                {x(b) - x(a) > 42 && <text x={(Math.max(left, x(a)) + Math.min(right, x(b))) / 2} y={y + 23} textAnchor="middle" pointerEvents="none">{cue.text.slice(0, Math.max(1, Math.floor((x(b) - x(a)) / 13) - 1))}</text>}
                {active && <><rect data-part="start" className="subtitle-timeline-edge" x={x(a) - 6} y={y - 3} width={16} height={42} fill="transparent"/>
                  <rect data-part="end" className="subtitle-timeline-edge" x={x(b) - 10} y={y - 3} width={16} height={42} fill="transparent"/>
                  <line x1={x(a) + 3} x2={x(a) + 3} y1={y + 9} y2={y + 27} stroke="var(--ac-ink)" pointerEvents="none"/>
                  <line x1={x(b) - 3} x2={x(b) - 3} y1={y + 9} y2={y + 27} stroke="var(--ac-ink)" pointerEvents="none"/></>}
              </g>
            })}
          </g>)}
          {time >= start && time <= end && <line x1={x(time)} x2={x(time)} y1={24} y2={height - 8} stroke="var(--ac-ink)" strokeWidth={1.5} pointerEvents="none"/>}
        </g>
        {lanes.map((lane, index) => <text key={lane.id || 'unknown'} x={3} y={103 + index * 48}>{lane.label.slice(0, width < 420 ? 4 : 6)}</text>)}
      </svg>
      {loading && <div className="subtitle-wave-status" role="status">{t('正在加载当前区间波形…')}</div>}
    </div>
    {error && <div className="subtitle-wave-error" role="status">{t('波形暂不可用，仍可校对字幕和调整时间。')} <Btn size="sm" variant="text" onClick={() => setRetry(retry + 1)}>{t('重试')}</Btn></div>}
    <p className="subtitle-timeline-help">{t('拖动字幕块移动，拖两端调整时间；拖选波形可补句。')}</p>
    {(preview || selection) && <div className="subtitle-timeline-selection" role="status">{t('选区')} · {fmt(preview?.currentStart ?? selection!.start)} — {fmt(preview?.currentEnd ?? selection!.end)}
      <Btn size="sm" variant="text" onClick={() => { setSelection(null); onRange(null) }}>{t('清除选区')}</Btn></div>}
  </section>
}
