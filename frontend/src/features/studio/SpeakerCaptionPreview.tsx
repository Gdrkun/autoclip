import { useRef } from 'react'
import { t } from '../../i18n'
import type { SpeakerCaptionLayout, SpeakerDocument } from './types'
import { activeSpeakerRows, speakerCaptionGeometry, speakerCaptionOutline } from './speakerSubtitleEditing'

export default function SpeakerCaptionPreview({ document, layout, colors, style, width, height, time, sceneStart, sceneEnd, editing = false, onPosition }: {
  document: SpeakerDocument; layout?: SpeakerCaptionLayout | null; colors: boolean; style: string
  width: number; height: number; time: number; sceneStart: number; sceneEnd: number
  editing?: boolean; onPosition?: (value: { x: number; y: number }) => void
}) {
  const activeRows = activeSpeakerRows(document, time, sceneStart, sceneEnd)
  const sample = editing && !activeRows.length ? document.subtitles.find(cue => cue.start_ms < sceneEnd * 1000 && cue.end_ms > sceneStart * 1000) : undefined
  const rows = sample ? [{ cue: sample, slot: sample.layer }] : activeRows
  const geometry = speakerCaptionGeometry(width, height, style, layout)
  const outline = speakerCaptionOutline(layout)
  const drag = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null)
  const move = (x: number, y: number) => onPosition?.({ x: Math.max(.05, Math.min(.95, x)), y: Math.max(.15, Math.min(.95, y)) })
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {editing && <div className="speaker-position-handle" role="button" tabIndex={0} aria-label={t('拖动字幕位置')}
      style={{ left: `${(layout?.x ?? .5) * 100}%`, top: `${(layout?.y ?? .91) * 100}%`, pointerEvents: 'auto' }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { clientX: event.clientX, clientY: event.clientY, x: layout?.x ?? .5, y: layout?.y ?? .91 } }}
      onPointerMove={event => {
        if (!drag.current) return
        const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
        if (bounds.width && bounds.height) move(drag.current.x + (event.clientX - drag.current.clientX) / bounds.width, drag.current.y + (event.clientY - drag.current.clientY) / bounds.height)
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return
        event.preventDefault()
        move((layout?.x ?? .5) + (event.key === 'ArrowLeft' ? -.01 : event.key === 'ArrowRight' ? .01 : 0),
          (layout?.y ?? .91) + (event.key === 'ArrowUp' ? -.01 : event.key === 'ArrowDown' ? .01 : 0))
      }}><span className="speaker-drag-label">↔ {t('拖动字幕位置')}{sample ? ` · ${t('样式预览')}` : ''}</span></div>}
    {rows.map(({ cue, slot }) => <div key={cue.id} style={{
      position: 'absolute', left: `${geometry.x / width * 100}%`, top: `${(geometry.y - slot * geometry.rowGap) / height * 100}%`,
      transform: 'translate(-50%, -100%)', width: 'max-content', maxWidth: '88%', textAlign: 'center', whiteSpace: 'pre-wrap',
      fontFamily: 'Microsoft YaHei, sans-serif', fontSize: `${geometry.fontSize / width * 100}cqw`, fontWeight: 700,
      lineHeight: 1.1, textShadow: 'none', paintOrder: 'stroke fill',
      WebkitTextStroke: outline.width ? `${2 * outline.width / width * 100}cqw ${outline.color}` : '0 transparent',
      backgroundColor: style === 'box' ? '#000000' : undefined,
      padding: style === 'box' ? `${Math.max(2, outline.width + 2) / width * 100}cqw` : undefined,
      color: colors ? document.speakers.find(speaker => speaker.speaker_id === cue.speaker_id)?.color || '#FFFFFF' : '#FFFFFF',
    }}>{cue.text}</div>)}
  </div>
}
