import { useState } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { SpeakerDocument } from './types'
import './creator-library.css'

export type Correction = {id:string;before:string;after:string;selected:boolean}
export function applyCorrections(document:SpeakerDocument, suggestions:Correction[]):SpeakerDocument {
  const byId=new Map(suggestions.filter(item=>item.selected).map(item=>[item.id,item]))
  return {...document,subtitles:document.subtitles.map(cue=>{
    const correction=byId.get(cue.id)
    return correction&&cue.text===correction.before?{...cue,text:correction.after}:cue
  })}
}
export default function CorrectionSuggestions({projectId,document,onChange}:{projectId:string;document:SpeakerDocument;onChange:(value:SpeakerDocument)=>void}) {
  const [items,setItems]=useState<Correction[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const scan=async()=>{setBusy(true);setMessage('');try{
    const result=await api.post<unknown,{suggestions:{index:number;before:string;after:string}[]}>(`/studio/${projectId}/vocabulary-suggestions`,{texts:document.subtitles.map(cue=>cue.text)})
    setItems(result.suggestions.map(item=>({...item,id:document.subtitles[item.index].id,selected:true})))
    if(!result.suggestions.length)setMessage(t('没有发现词库中的易错写法。'))
  }catch(e){setMessage(errorText(e))}finally{setBusy(false)}}
  const apply=()=>{const next=applyCorrections(document,items);onChange(next);setItems([]);setMessage(t('已应用到当前草稿，请保存字幕。'))}
  return <details className="creator-corrections"><summary>{t('词库纠错')}</summary><p>{t('仅检查本地词库，不改时间和说话人；勾选确认后再应用。')}</p>
    <Btn size="sm" loading={busy} disabled={busy} onClick={()=>void scan()}>{t('检查易错词')}</Btn>
    {items.map((item,index)=><label className="creator-correction" key={item.id}><input type="checkbox" checked={item.selected} onChange={event=>setItems(items.map((value,i)=>i===index?{...value,selected:event.target.checked}:value))}/><span><del>{item.before}</del><ins>{item.after}</ins></span></label>)}
    {!!items.length&&<Btn size="sm" onClick={apply}>{t('应用选中的纠错')}</Btn>}{message&&<p role="status">{t(message)}</p>}
  </details>
}
