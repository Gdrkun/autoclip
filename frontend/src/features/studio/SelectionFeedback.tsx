import { useState } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import { feedbackLabels } from './CreatorLibrary'

export default function SelectionFeedback({projectId,draftId}:{projectId:string;draftId:string}) {
  const [direction,setDirection]=useState<'more'|'less'>(),[category,setCategory]=useState('humor')
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const save=async()=>{setBusy(true);setMessage('');try{
    await api.post(`/studio/${projectId}/drafts/${draftId}/selection-feedback`,{direction,category,note})
    setMessage(t('已记住，后续同角色选片会参考。'));setDirection(undefined)
  }catch(e){setMessage(errorText(e))}finally{setBusy(false)}}
  return <div className="creator-selection-feedback">
    <div className="studio-actions"><Btn size="sm" variant="text" disabled={busy} onClick={()=>{setDirection('more');setMessage('')}}>{t('多选这种')}</Btn><Btn size="sm" variant="text" disabled={busy} onClick={()=>{setDirection('less');setMessage('')}}>{t('少选这种')}</Btn></div>
    {direction&&<div className="creator-feedback-form"><label>{t('记住哪类内容')}<select className="ac-input" value={category} onChange={event=>setCategory(event.target.value)}>{Object.entries(feedbackLabels).map(([key,label])=><option key={key} value={key}>{t(label)}</option>)}</select></label>
      <textarea className="ac-input" maxLength={300} rows={2} aria-label={t('选片反馈备注')} placeholder={t('例如：喜欢有铺垫的人物反差，少选普通闲聊。')} value={note} onChange={event=>setNote(event.target.value)}/>
      <div className="studio-actions"><Btn size="sm" loading={busy} disabled={busy} onClick={()=>void save()}>{t('记住偏好')}</Btn><Btn size="sm" disabled={busy} onClick={()=>setDirection(undefined)}>{t('取消')}</Btn></div>
    </div>}{message&&<p role="status">{t(message)}</p>}
  </div>
}
