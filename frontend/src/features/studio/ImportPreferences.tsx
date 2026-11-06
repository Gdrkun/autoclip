import { useTranslation } from 'react-i18next'
import { Select } from 'antd'
import { t } from '../../i18n'
import { Row } from '../../ui'
import { ImportOptions, goalLabels, languages } from './types'

/** Optional production preferences as setting rows; every field defaults to "let AI match". */
export default function ImportPreferences({value, onChange, hideGoal=false}: {value: ImportOptions; onChange: (value: ImportOptions) => void; hideGoal?:boolean}) {
  useTranslation()
  const patch = (changes: Partial<ImportOptions>) => onChange({...value, ...changes})
  return <div className="ac-rows studio-preferences">
    {!hideGoal&&<Row label={t("制作方式")}>
      <Select aria-label={t("制作方式")} size="small" style={{width:180}} value={value.goal} options={Object.entries(goalLabels).map(([key,label])=>({value:key,label:t(label)}))} onChange={goal=>patch({goal:goal as ImportOptions['goal']})} />
    </Row>}
    <Row label={t('处理方式')} hint={t('快速预选先看候选，只对选中的片段精修；没有字幕时仍需基础转写。')}>
      <Select aria-label={t('处理方式')} size="small" style={{width:210}} value={value.quick_preview ? 'preview' : 'automatic'}
        options={[{value:'automatic',label:t('自动制作成片')},{value:'preview',label:t('快速预选，选中再精修')}]}
        onChange={mode=>patch({quick_preview:mode==='preview'})}/>
    </Row>
    <Row label={t('优先生成数量')} hint={t(value.quick_preview ? '快速预选不会自动渲染，确认候选后生成所选内容。' : '每个平台先生成少量成片，其余候选按需生成。')}>
      <Select aria-label={t('优先生成数量')} size="small" style={{width:180}} value={value.auto_render_limit || 3} options={[1,3,10].map(count => ({value:count,label:t('每个平台 {{count}} 条',{count})}))} onChange={auto_render_limit=>patch({auto_render_limit:auto_render_limit as 1|3|10})}/>
    </Row>
    <Row label={t("文字语言")}>
      <Select aria-label={t("文字语言")} size="small" style={{width:180}} value={value.language} options={languages.map(l=>({value:l.value,label:l.value==='source'?t("沿用素材语言（推荐）"):l.label}))} onChange={language=>patch({language:language as ImportOptions['language']})} />
    </Row>
    <Row label={t("每条期望时长")} hint={value.goal==='content'?t("内容切片按完整语义选段，具体起止可在编辑器调整。"):undefined}>
      <Select aria-label={t("每条期望时长")} size="small" style={{width:180}} value={value.duration ?? ''} options={[{value:'',label:t("AI 根据内容匹配")},...[15,30,60,90,120].map(n=>({value:n,label:t('约 {{seconds}} 秒', { seconds: n })}))]} onChange={duration=>patch({duration:duration===''?null:Number(duration)})} />
    </Row>
    <Row label={t("画幅")}>
      <Select aria-label={t("画幅")} size="small" style={{width:180}} value={value.aspect ?? ''} options={[{value:'',label:t("AI 根据内容匹配")},{value:'original',label:t("保持原画幅")},{value:'portrait',label:t("9:16 竖屏")},{value:'landscape',label:t("16:9 横屏")}]} onChange={aspect=>patch({aspect:(aspect || null) as ImportOptions['aspect']})} />
    </Row>
  </div>
}
