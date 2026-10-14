import type { SpeakerCaptionLayout, SpeakerDocument } from './types'
import { activeSpeakerRows, speakerCaptionGeometry } from './speakerSubtitleEditing'

export default function SpeakerCaptionPreview({ document, layout, colors, style, width, height, time, sceneStart, sceneEnd }: {
  document: SpeakerDocument; layout?: SpeakerCaptionLayout | null; colors: boolean; style: string
  width: number; height: number; time: number; sceneStart: number; sceneEnd: number
}) {
  const geometry = speakerCaptionGeometry(width, height, style, layout)
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {activeSpeakerRows(document, time, sceneStart, sceneEnd).map(({ cue, slot }) => <div key={cue.id} style={{
      position: 'absolute', left: `${geometry.x / width * 100}%`, top: `${(geometry.y - slot * geometry.rowGap) / height * 100}%`,
      transform: 'translate(-50%, -100%)', width: 'max-content', maxWidth: '88%', textAlign: 'center', whiteSpace: 'pre-wrap',
      fontFamily: 'Microsoft YaHei, sans-serif', fontSize: `${geometry.fontSize / width * 100}cqw`, fontWeight: 700,
      lineHeight: 1.1, textShadow: '0 1px 3px #000',
      color: colors ? document.speakers.find(speaker => speaker.speaker_id === cue.speaker_id)?.color || '#FFFFFF' : '#FFFFFF',
    }}>{cue.text}</div>)}
  </div>
}
