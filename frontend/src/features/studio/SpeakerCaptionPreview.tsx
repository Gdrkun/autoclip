import type { SpeakerCaptionLayout, SpeakerDocument } from './types'
import { activeSpeakerRows, speakerCaptionGeometry, speakerCaptionOutline } from './speakerSubtitleEditing'

export default function SpeakerCaptionPreview({ document, layout, colors, style, width, height, time, sceneStart, sceneEnd }: {
  document: SpeakerDocument; layout?: SpeakerCaptionLayout | null; colors: boolean; style: string
  width: number; height: number; time: number; sceneStart: number; sceneEnd: number
}) {
  const geometry = speakerCaptionGeometry(width, height, style, layout)
  const outline = speakerCaptionOutline(layout)
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {activeSpeakerRows(document, time, sceneStart, sceneEnd).map(({ cue, slot }) => <div key={cue.id} style={{
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
