import { useState } from 'react'
import { t } from '../../i18n'
import { Btn, Dialog } from '../../ui'
import type { ImportOptions } from './types'
import { readProductionPresets, storeProductionPreset, removeProductionPreset } from './productionPresetStorage'

export default function ProductionPresets({ options, platforms, disabled, onApply }: {
  options: ImportOptions; platforms:string[]; disabled:boolean; onApply:(options:ImportOptions, platforms:string[])=>void
}) {
  const [items,setItems]=useState(readProductionPresets)
  const [selected,setSelected]=useState('')
  const [name,setName]=useState('')
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  const [deleting,setDeleting]=useState(false)
  const chosen=items.find(item=>item.id===selected)
  return <details className="studio-preset-tools"><summary>{t('制作预设')}</summary>
    <p className="studio-muted">{t('只保存平台与制作偏好，应用预设后可继续调整，不会自动开始制作。')}</p>
    <div className="studio-actions"><select className="ac-input" aria-label={t('已保存的制作预设')} value={selected} disabled={disabled} onChange={event=>{setSelected(event.target.value);setName(items.find(item=>item.id===event.target.value)?.name || '')}}>
      <option value="">{t('选择制作预设')}</option>{items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <Btn size="sm" disabled={disabled || !chosen} onClick={()=>{if(chosen){onApply({...chosen.options},[...chosen.platforms]);setNotice(t('已应用预设，请核对后再生成。'));setError('')}}}>{t('应用预设')}</Btn>
      <Btn size="sm" disabled={disabled || !chosen} onClick={()=>setDeleting(true)}>{t('删除预设')}</Btn></div>
    <div className="studio-actions"><input className="ac-input" aria-label={t('预设名称')} placeholder={t('例如：人物搞笑切片')} maxLength={40} value={name} disabled={disabled} onChange={event=>setName(event.target.value)}/>
      <Btn size="sm" disabled={disabled || !name.trim()} onClick={()=>{try{const preset={id:items.find(item=>item.name===name.trim())?.id || crypto.randomUUID(),name:name.trim(),options,platforms};setItems(storeProductionPreset(items,preset));setSelected(preset.id);setNotice(t('制作预设已保存到本机。'));setError('')}catch{setError(t('预设保存失败，请检查本机存储或删除不再使用的预设。'))}}}>{t(items.some(item=>item.name===name.trim())?'更新同名预设':'保存当前偏好')}</Btn></div>
    {notice&&<p className="studio-muted" role="status">{notice}</p>}{error&&<p className="studio-error" role="alert">{error}</p>}
    <Dialog open={deleting} title={t('删除这个制作预设？')} description={chosen?.name} onClose={()=>setDeleting(false)} footer={<div className="studio-actions"><Btn onClick={()=>setDeleting(false)}>{t('取消')}</Btn><Btn variant="danger" onClick={()=>{try{setItems(removeProductionPreset(items,selected));setSelected('');setName('');setNotice('');setError('');setDeleting(false)}catch{setError(t('预设保存失败，请检查本机存储或删除不再使用的预设。'));setDeleting(false)}}}>{t('删除')}</Btn></div>}/>
  </details>
}
