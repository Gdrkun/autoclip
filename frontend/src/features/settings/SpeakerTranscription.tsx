import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { Row } from '../../ui'
import api from '../../services/api'

type LocalModelStatus = { ready: boolean; sensevoice: boolean; whisper: boolean }

export default function SpeakerTranscription({ provider, enabled, prompt, onChange }: {
  provider: 'whisper_local' | 'sensevoice_local'
  enabled: boolean; prompt: string; onChange: (update: { speaker_diarization?: boolean; initial_prompt?: string }) => void
}) {
  const [modelStatus, setModelStatus] = useState<LocalModelStatus | null>(null)
  useEffect(() => {
    let active = true
    api.get<unknown, LocalModelStatus>('/studio/speaker-subtitles/status').then(value => {
      if (active) setModelStatus(value)
    }).catch(() => { if (active) setModelStatus({ ready: false, sensevoice: false, whisper: false }) })
    return () => { active = false }
  }, [])
  const ready = modelStatus === null ? null : !!(modelStatus.ready && modelStatus[provider === 'sensevoice_local' ? 'sensevoice' : 'whisper'])
  return <>
    <Row label={t('说话人字幕')} hint={t('本地识别说话人，在编辑器中校对字幕并绑定颜色。')}>
      <input type="checkbox" aria-label={t('说话人字幕')} checked={enabled} onChange={event => onChange({ speaker_diarization: event.target.checked })}/>
    </Row>
    {enabled && <>
      <p className="ac-note" role="status">{ready ? t('本地模型已就绪') : ready === false ? t('本地说话人模型未就绪') : t('加载中…')}</p>
      <Row label={t('转写提示词')} hint={t('填写人名和固定用语，帮助 Whisper 识别专名。')}>
        <input className="ac-input" aria-label={t('转写提示词')} maxLength={500} value={prompt} onChange={event => onChange({ initial_prompt: event.target.value })}/>
      </Row>
      <p className="ac-note">{t('当前支持十分钟以内的视频，不上传音频。')}</p>
    </>}
  </>
}
