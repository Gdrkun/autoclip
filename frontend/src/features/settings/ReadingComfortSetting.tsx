import { useState } from 'react'
import { t } from '../../i18n'
import { Row, Segmented } from '../../ui'
import { readDisplayDensity, applyDisplayDensity, type DisplayDensity } from './displayDensity'
export default function ReadingComfortSetting() {
  const [density, setDensity] = useState(readDisplayDensity)
  return <Row label={t('显示密度')} hint={t('舒适模式放大常用按钮与校对文字；紧凑模式显示更多内容。')}>
    <Segmented ariaLabel={t('显示密度')} value={density} onChange={(value: DisplayDensity) => { setDensity(value); applyDisplayDensity(value) }}
      options={[{value:'comfortable', label:t('舒适')},{value:'compact',label:t('紧凑')}]}/>
  </Row>
}
