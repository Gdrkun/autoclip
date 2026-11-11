import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import { observeStudioDownload, studioDownloadRequested } from '../../analytics/studio'
import { studioApi } from './api'
import { isDesktopDownload, saveStudioExport } from './nativeDownload'
import { runDownloadBatch } from './batchDownloads'
import type { RenderJob } from './types'

export default function BatchExportDownload({ projectId, jobs, selected, onSelect }: {projectId:string;jobs:RenderJob[];selected:string[];onSelect:(ids:string[])=>void}) {
  const [busy,setBusy]=useState(false)
  const [count,setCount]=useState(0)
  const [total,setTotal]=useState(0)
  const [result,setResult]=useState<{saved:string[];failed:string[];remaining:string[]}|null>(null)
  const [native,setNative]=useState(false)
  const pending=useRef(false),stop=useRef(false),alive=useRef(true)
  useEffect(()=>{alive.current=true;setNative(isDesktopDownload());return()=>{alive.current=false;stop.current=true}},[])
  const available=jobs.filter(job=>job.status==='completed'), ids=selected.filter(id=>available.some(job=>job.job_id===id))
  const download=async(retry?:string[])=>{
    if(pending.current)return
    const chosen=retry||ids;if(!chosen.length)return
    pending.current=true;stop.current=false;setBusy(true);setCount(0);setTotal(new Set(chosen).size);setResult(null)
    const snapshot=await runDownloadBatch(chosen,async id=>{
      if(isDesktopDownload())await observeStudioDownload(()=>saveStudioExport(projectId,id),projectId,id)
      else {
        const anchor=document.createElement('a');anchor.href=studioApi.video(projectId,id,true);anchor.download=''
        document.body.appendChild(anchor);anchor.click();anchor.remove();studioDownloadRequested(projectId,id)
      }
    },{stop:()=>stop.current,progress:done=>{if(alive.current)setCount(done)}})
    pending.current=false
    if(alive.current){setBusy(false);setResult(snapshot)}
  }
  if(!available.length)return null
  return <div className="studio-batch-download" aria-label={t('批量下载')}>
    <div className="studio-actions"><Btn size="sm" disabled={busy} onClick={()=>onSelect(available.map(job=>job.job_id))}>{t('选择全部已完成')}</Btn><Btn size="sm" disabled={busy||!ids.length} onClick={()=>onSelect([])}>{t('清除下载选择')}</Btn><Btn size="sm" disabled={busy||!ids.length} onClick={()=>void download()}>{t('下载选中 {{count}} 条',{count:ids.length})}</Btn>{busy&&<Btn size="sm" onClick={()=>{stop.current=true}}>{t('停止后续下载')}</Btn>}</div>
    {busy&&<p role="status">{t('正在处理下载 {{done}} / {{total}}',{done:count,total})}</p>}
    {!native&&<p className="studio-muted">{t('浏览器会逐条发起下载；若被拦截，可使用下方链接单独下载。')}</p>}
    {result&&<div role="status"><p>{t(native?'已保存 {{count}} 个文件到下载文件夹。':'已发起 {{count}} 个下载请求，请检查浏览器下载列表。',{count:result.saved.length})}{result.remaining.length>0&&` ${t('还有 {{count}} 条未开始下载。',{count:result.remaining.length})}`}</p>{result.failed.length>0&&<Btn size="sm" onClick={()=>void download(result.failed)}>{t('重试失败 {{count}} 条',{count:result.failed.length})}</Btn>}</div>}
    {!native&&ids.length>0&&<div className="studio-actions">{available.filter(job=>ids.includes(job.job_id)).map(job=><a key={job.job_id} className="studio-link" href={studioApi.video(projectId,job.job_id,true)} download onClick={()=>studioDownloadRequested(projectId,job.job_id)}>{job.title} · V{job.revision}</a>)}</div>}
  </div>
}
