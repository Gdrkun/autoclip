import { t } from '../../i18n'
import { selectionPreferencePresets, toggleSelectionPreference } from './selectionPreferencePresets'
import CharacterBackground from './CharacterBackground'
import './selection-preferences.css'

export default function SelectionPreferences({ value, backgroundQuery = '', onBackgroundChange, onChange, disabled }: {
  backgroundQuery?: string; onBackgroundChange?: (value: string) => void
  value: string; onChange: (value: string) => void; disabled: boolean
}) {
  return <section className="studio-selection-preferences" aria-label={t('选片偏好')}>
    <div className="studio-selection-head"><label htmlFor="studio-selection-instruction">{t('你想优先看什么？')}</label><span>{t('选填')}</span></div>
    <p>{t('要求会用于 AI 选段和评分；可以组合，也可以直接写。')}</p>
    <div className="studio-selection-presets">
      {selectionPreferencePresets.map(preset => {
        const instruction = t(preset.instruction)
        return <button type="button" key={preset.label} disabled={disabled} aria-pressed={value.split('\n').includes(instruction)}
          onClick={() => onChange(toggleSelectionPreference(value, instruction))}>{t(preset.label)}</button>
      })}
    </div>
    <textarea id="studio-selection-instruction" aria-label={t('制作要求')} rows={3} maxLength={1000} disabled={disabled}
      placeholder={t('例如：优先唱歌、搞笑互动和玩梗，少选日常闲聊；保留铺垫和完整笑点。')}
      value={value} onChange={event => onChange(event.target.value)}/>
    {onBackgroundChange && <CharacterBackground query={backgroundQuery} onChange={onBackgroundChange} disabled={disabled}/>}
    <div className="studio-selection-note"><span>{t('只按素材中的真实内容选择；字幕未体现的歌声或画面梗可能无法判断。')}</span><span>{value.length}/1000</span></div>
  </section>
}
