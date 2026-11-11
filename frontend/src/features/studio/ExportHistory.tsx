import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getLocale } from '../../i18n'
import StudioDownloadLink from './StudioDownloadLink'
import BatchExportDownload from './BatchExportDownload'
import { Link } from 'react-router-dom'
import { Draft, RenderJob } from './types'
import { Dialog, ProgressLine } from '../../ui'
export default function ExportHistory({ projectId, jobs, drafts=[], open, onClose }: { projectId:string;jobs:RenderJob[];drafts?:Draft[];open:boolean;onClose:()=>void }) {
  const { t } = useTranslation()
  const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[selected,setSelected]=useState<string[]>([])
  const shown=jobs.filter(job=>(!filter||job.draft_id===filter)&&job.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0))
  const groups=[...new Set(shown.map(job=>job.draft_id))]
  return <Dialog open={open} onClose={onClose} title={t('导出记录')} description={t('保留每次导出的成片与草稿版本。')}>
    <div className="studio-actions studio-history-filters"><input className="ac-input" type="search" aria-label={t('搜索导出标题')} placeholder={t('搜索导出标题')} value={query} onChange={event=>setQuery(event.target.value)}/><select className="ac-input" aria-label={t('筛选草稿')} value={filter} onChange={event=>{setFilter(event.target.value);setSelected([])}}><option value="">{t('全部草稿')}</option>{[...new Set(jobs.map(job=>job.draft_id))].map(id=><option key={id} value={id}>{drafts.find(draft=>draft.id===id)?.title || jobs.find(job=>job.draft_id===id)?.title}</option>)}</select></div>
    <BatchExportDownload projectId={projectId} jobs={shown} selected={selected} onSelect={setSelected}/>
    {!jobs.length&&<p className="studio-muted">{t('还没有导出记录，选一条成片即可导出。')}</p>}
    {jobs.length>0&&!shown.length&&<p className="studio-muted">{t('没有匹配的导出记录。')}</p>}
    {groups.map(id=><section className="studio-history-group" key={id}><h4>{drafts.find(draft=>draft.id===id)?.title || shown.find(job=>job.draft_id===id)?.title}</h4>{shown.filter(job=>job.draft_id===id).map(job=>{
      const current=drafts.find(draft=>draft.id===id)
      return <div key={job.job_id} className="studio-history-row"><b>{job.title}</b><span className="studio-muted">V{job.revision} · {new Date(job.created_at).toLocaleString(getLocale())}{current&&` · ${t(current.revision===job.revision?'与当前草稿版本一致':'旧版成片，未包含最新草稿修改')}`}</span>
        {job.status==='completed'?<><label className="speaker-check"><input type="checkbox" checked={selected.includes(job.job_id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,job.job_id]:ids.filter(id=>id!==job.job_id))}/>{t('选择下载此成片')}</label><StudioDownloadLink className="ac-btn" projectId={projectId} jobId={job.job_id}/><Link className="studio-link" to={`/project/${projectId}/publish/studio-${job.job_id}`}>{t('发布这版成片')}</Link>{job.result?.warnings?.map(w=><p className="studio-muted" key={w}>{t(w)}</p>)}</>:job.status==='failed'?<p className="studio-error">{t(job.error||'')}</p>:<><ProgressLine percent={job.percent}/><span className="studio-muted">{t(job.status==='queued'?'排队中':'正在渲染')} · {job.percent}%</span></>}
      </div>
    })}</section>)}
  </Dialog>
}
