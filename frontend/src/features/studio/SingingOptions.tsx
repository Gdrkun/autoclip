import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { Btn, fmtDuration } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { ImportPlan } from './types'
import './creator-library.css'

type Status={status:string;runtime_ready:boolean;error?:string}
export function SingingSummary({report}:{report?:ImportPlan['singing_analysis']}) {
  if(!report||report.status==='disabled')return null
  return <details className="creator-singing-summary"><summary>{t('歌声检测')} · {report.status==='completed'?t('找到 {{count}} 个候选区间',{count:report.segments.length}):t('本次歌声检测未完成')}</summary>
    <p>{t('音频分类结果仅为候选，可能包含伴奏或哼唱；请试听确认，边界可能需要调整。')}</p>
    {report.error&&<p>{t(report.error)}</p>}{report.segments.map((item,index)=><p key={index}>{fmtDuration(item.start)} – {fmtDuration(item.end)}</p>)}
  </details>
}
export default function SingingOptions({enabled,onChange,disabled}:{enabled:boolean;onChange:(value:boolean)=>void;disabled:boolean}) {
  const [status,setStatus]=useState<Status>(),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{let active=true;const refresh=()=>api.get<unknown,Status>('/studio/singing/status').then(value=>{if(active)setStatus(value)}).catch(()=>undefined);void refresh();const timer=window.setInterval(()=>{void refresh()},5000);return()=>{active=false;window.clearInterval(timer)}},[])
  const prepare=async()=>{setBusy(true);setError('');try{setStatus(await api.post<unknown,Status>('/studio/singing/prepare'))}catch(e){setError(errorText(e))}finally{setBusy(false)}}
  const preparing=status?.status==='preparing'
  return <div className="creator-singing-options"><label><input type="checkbox" checked={enabled} disabled={disabled||(!enabled&&status?.status!=='ready')} onChange={event=>onChange(event.target.checked)}/>{t('检测歌声，辅助完整保留演唱片段')}</label>
    <small>{t('本地 CPU 音频模型；只识别候选区间，不生成歌词。开启后会增加处理时间。')}</small>
    {status?.status!=='ready'&&<Btn size="sm" disabled={disabled||busy||preparing||!status?.runtime_ready} loading={busy||preparing} onClick={()=>void prepare()}>{t(preparing?'正在准备歌声模型…':'下载歌声模型（约 330 MB，免费）')}</Btn>}
    {status&&!status.runtime_ready&&<small>{t('请先准备本地说话人运行时，再下载歌声模型')}</small>}
    {(error||status?.error)&&<p className="studio-error" role="alert">{t(error||status?.error||'')}</p>}
  </div>
}
