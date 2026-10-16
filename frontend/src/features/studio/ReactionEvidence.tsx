import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import api from '../../services/api'
import { Btn, fmtDuration } from '../../ui'
import { errorText } from './api'
import { evidenceFrameIndices, visibleReactions, type ReactionReport } from './reactionEvidenceLogic'
import type { Scene } from './types'
import './visual-reactions.css'

export default function ReactionEvidence({projectId,scenes,onSeek}:{projectId:string;scenes:Scene[];onSeek:(seconds:number,index:number)=>void}) {
  const [report,setReport]=useState<ReactionReport|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState('')
  useEffect(()=>{let active=true;setReport(null);setError('')
    void api.get<unknown,ReactionReport>(`/studio/${projectId}/visual-reactions`).then(value=>{if(active)setReport(value)}).catch(()=>undefined)
    return ()=>{active=false}
  },[projectId])
  if(!report||report.status==='disabled')return null
  const events=visibleReactions(report.events,scenes)
  const toggle=async(id:string,ignored:boolean)=>{setBusy(id);setError('');try {
    setReport(await api.patch<unknown,ReactionReport>(`/studio/${projectId}/visual-reactions/${id}`,{run_id:report.run_id,ignored}))
  }catch(e){setError(errorText(e))}finally{setBusy('')}}
  return <details className="studio-details reaction-evidence"><summary>{t('画面反应与选片依据')} · {events.length}</summary>
    <p>{t('以下为候选画面的观察依据，需结合原片核对；提供依据不代表 AI 一定采用。')}</p>
    <p className="studio-muted">{t('已复核 {{done}} 个区间，预算 {{budget}} 个',{done:report.completed_windows,budget:report.request_budget})}</p>
    {report.error&&<p role="status">{t(report.error)}</p>}
    {!events.length&&<p>{t('当前切片范围内没有可展示的画面证据。')}</p>}
    {events.map(event=><article key={event.id} className={`reaction-event${event.ignored?' reaction-event--ignored':''}`}>
      <header><strong>{event.label}</strong><span className="ac-mono">{fmtDuration(event.start)}–{fmtDuration(event.end)}</span></header>
      <div className="reaction-frames">{evidenceFrameIndices(event,report).map(index=><img key={index} loading="lazy"
        src={`${api.defaults.baseURL}/studio/${projectId}/visual-reactions/frames/${report.run_id}/${event.window_id}/${index}`}
        alt={t('原片画面 {{time}}',{time:fmtDuration(report.windows.find(window=>window.id===event.window_id)!.times[index])})}/>)}</div>
      <p>{event.evidence}</p>{event.uncertainty&&<p className="studio-muted">{t('观察限制')}：{event.uncertainty}</p>}
      <div className="studio-actions"><Btn size="sm" onClick={()=>{
        const index=scenes.findIndex(scene=>event.start<scene.end&&event.end>scene.start)
        if(index>=0)onSeek(Math.max(event.start,scenes[index].start),index)
      }}>{t('查看原片')}</Btn><Btn size="sm" variant="text" disabled={!!busy} onClick={()=>void toggle(event.id,!event.ignored)}>{t(event.ignored?'恢复这条依据':'忽略这条依据')}</Btn></div>
    </article>)}
    <p className="studio-muted">{t('忽略仅影响此项目后续重新选片，不修改已生成的切片，也不代表训练模型。')}</p>
    {error&&<p role="alert" className="studio-error">{t(error)}</p>}
  </details>
}
