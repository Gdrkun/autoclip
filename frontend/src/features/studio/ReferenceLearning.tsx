import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { Btn, fmtDuration } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import { evidenceLink, referenceUrls, reviewPayload, type CharacterKnowledge, type KnowledgeDashboard, type ReferenceJob } from './referenceKnowledge'

const kinds = {meme:'人物梗',selection:'选片经验',relationship:'人物互动',vocabulary:'专有名词'}
const states = {pending:'待确认',confirmed:'已启用',disabled:'已停用'}
const phases:Record<string,string> = {queued:'排队中',fetching:'读取参考切片',downloading:'下载参考素材',
  transcribing:'本地转写中',analyzing:'提炼人物知识',completed:'学习完成',cancelled:'已停止'}

export function KnowledgeCard({item,onSaved}:{item:CharacterKnowledge;onSaved:(item:CharacterKnowledge)=>void}) {
  const [value,setValue]=useState(item),[triggerText,setTriggerText]=useState(item.triggers.join('、'))
  const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{if(!editing){setValue(item);setTriggerText(item.triggers.join('、'))}},[item.id,item.revision,editing])
  const save=async(status:CharacterKnowledge['status'])=>{
    setBusy(true);setError('')
    try {
      const next=await api.patch<unknown,CharacterKnowledge>(`/studio/creator-knowledge/items/${item.id}`,reviewPayload({...value,triggers:triggerText.split(/[、,，]/).map(term=>term.trim()).filter(Boolean)},status))
      onSaved(next);setEditing(false)
    } catch(e){setError(errorText(e))}finally{setBusy(false)}
  }
  return <article className={`creator-knowledge-card creator-knowledge-card--${item.status}`}>
    <header><span>{t(kinds[item.kind])}</span><span>{t(states[item.status])}</span><small>{item.subjects}</small></header>
    {editing?<fieldset disabled={busy} className="creator-fields">
      <label>{t('知识标题')}<input className="ac-input" maxLength={100} value={value.title} onChange={e=>setValue({...value,title:e.target.value})}/></label>
      <label>{t('知识说明')}<textarea className="ac-input" rows={3} maxLength={1500} value={value.explanation} onChange={e=>setValue({...value,explanation:e.target.value})}/></label>
      <label>{t('触发词（用顿号分隔）')}<input className="ac-input" maxLength={1000} value={triggerText} onChange={e=>setTriggerText(e.target.value)}/></label>
      <label>{t('适用语境')}<textarea className="ac-input" rows={2} maxLength={1000} value={value.context} onChange={e=>setValue({...value,context:e.target.value})}/></label>
      <label>{t('不确定性与误读提醒')}<textarea className="ac-input" rows={2} maxLength={800} value={value.caution} onChange={e=>setValue({...value,caution:e.target.value})}/></label>
    </fieldset>:<><h4>{item.title}</h4><p>{item.explanation}</p>
      {!!item.triggers.length&&<div className="creator-knowledge-tags">{item.triggers.map(term=><span key={term}>{term}</span>)}</div>}
      {item.context&&<p><b>{t('适用语境')}：</b>{item.context}</p>}
      {item.caution&&<p className="creator-knowledge-caution"><b>{t('不确定性与误读提醒')}：</b>{item.caution}</p>}
    </>}
    <blockquote>{item.evidence.quote}<footer>
      {item.source_url?<a href={evidenceLink(item)} target="_blank" rel="noopener noreferrer">{item.source_title} ↗</a>:<span>{item.source_title}</span>}
      <span>{fmtDuration(item.evidence.start_ms/1000)}–{fmtDuration(item.evidence.end_ms/1000)}</span>
    </footer></blockquote>
    <div className="studio-actions">
      <Btn size="sm" disabled={busy} onClick={()=>void save('confirmed')}>{editing?t('保存并启用'):item.status==='confirmed'?t('保持启用'):t('确认并启用')}</Btn>
      <Btn size="sm" variant="text" disabled={busy} onClick={()=>{setValue(item);setTriggerText(item.triggers.join('、'));setEditing(!editing);setError('')}}>{editing?t('取消'):t('编辑')}</Btn>
      {item.status!=='disabled'&&<Btn size="sm" variant="text" disabled={busy} onClick={()=>void save('disabled')}>{t('停用')}</Btn>}
    </div>{error&&<p role="alert" className="studio-error">{t(error)}</p>}
  </article>
}

export default function ReferenceLearning({query=''}:{query?:string}) {
  const [subjects,setSubjects]=useState(query),[urls,setUrls]=useState(''),[title,setTitle]=useState(''),[srt,setSrt]=useState('')
  const [note,setNote]=useState(''),[local,setLocal]=useState(true),[backend,setBackend]=useState('whisper')
  const [data,setData]=useState<KnowledgeDashboard>({items:[],jobs:[]}),[filter,setFilter]=useState('pending')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[refresh,setRefresh]=useState(0)
  useEffect(()=>{
    let active=true
    const fetch=()=>void api.get<unknown,KnowledgeDashboard>('/studio/creator-knowledge',{params:{query:subjects.trim()}})
      .then(value=>{if(active){setData(value);setLoadError('')}}).catch(e=>{if(active)setLoadError(errorText(e))})
    const start=window.setTimeout(fetch,250)
    const timer=window.setInterval(fetch,3500)
    return ()=>{active=false;window.clearTimeout(start);window.clearInterval(timer)}
  },[subjects,refresh])
  const add=async()=>{
    setBusy(true);setError('')
    try {
      const links=referenceUrls(urls)
      if(srt.trim()&&links.length>1) throw new Error('附带 SRT 时请一次添加一个参考切片')
      if(!links.length&&!srt.trim()) throw new Error('请提供参考切片链接或 SRT 字幕')
      for(const url of links.length?links:['']) {
        await api.post('/studio/creator-knowledge/references',{query:subjects.trim(),url,title,srt,note,local_asr:local,local_backend:backend})
      }
      setUrls('');setSrt('');setTitle('');setNote('');setRefresh(value=>value+1)
    } catch(e){setError(errorText(e));setRefresh(value=>value+1)}finally{setBusy(false)}
  }
  const action=async(job:ReferenceJob,method:'retry'|'cancel')=>{
    try{await api.post(`/studio/creator-knowledge/references/${job.id}/${method}`);setRefresh(value=>value+1)}
    catch(e){setError(errorText(e))}
  }
  const items=data.items.filter(item=>filter==='all'||item.status===filter)
  return <section className="creator-reference-learning" aria-label={t('参考切片学习')}>
    <p>{t('把认可的切片整理成人物知识；确认后的条目用于以后自动选片。')}</p>
    <fieldset disabled={busy} className="creator-fields creator-reference-form">
      <label>{t('所属人物（用顿号分隔）')}<input className="ac-input" maxLength={200} value={subjects} onChange={e=>setSubjects(e.target.value)} placeholder={t('例如：思诺snow、心宜不是心仪')}/></label>
      <label>{t('参考切片链接（每行一条）')}<textarea className="ac-input" rows={3} maxLength={20000} value={urls} onChange={e=>setUrls(e.target.value)} placeholder="https://www.bilibili.com/video/BV…"/></label>
      <details><summary>{t('提供字幕或补充说明')}</summary><div className="creator-fields">
        <label>{t('参考标题（选填）')}<input className="ac-input" maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label>
        <label>{t('SRT 字幕（选填）')}<input type="file" accept=".srt" onChange={e=>{
          const file=e.target.files?.[0];if(!file)return
          if(file.size>1500000){setError(t('参考字幕文件过大'));return}
          void file.text().then(text=>{if(text.length>500000)throw new Error('参考字幕文件过大');setSrt(text)}).catch(err=>setError(errorText(err)))
        }}/><textarea className="ac-input" aria-label={t('SRT 字幕（选填）')} rows={3} maxLength={500000} value={srt} onChange={e=>setSrt(e.target.value)}/></label>
        <label>{t('你认可它的原因（选填）')}<textarea className="ac-input" rows={2} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label>
      </div></details>
      <label className="creator-asr-option"><input type="checkbox" checked={local} onChange={e=>setLocal(e.target.checked)}/><span>{t('无平台字幕时使用本地 CPU 转写')}</span></label>
      {local&&<label>{t('转写模型')}<select className="ac-input" value={backend} onChange={e=>setBackend(e.target.value)}><option value="whisper">Whisper medium · CPU</option><option value="sensevoice">SenseVoiceSmall · CPU</option></select></label>}
      <p className="creator-learning-disclosure">{t('分析会把参考字幕和备注发送给已配置的文字模型，可能产生用量。来源时间属于参考切片。')}</p>
      <Btn size="sm" variant="cta" disabled={!subjects.trim()||busy} loading={busy} onClick={()=>void add()}>{t('分析并生成待确认条目')}</Btn>
    </fieldset>
    {(error||loadError)&&<p role="alert" className="studio-error">{t(error||loadError)}</p>}
    {!!data.jobs.length&&<details className="creator-reference-jobs"><summary>{t('参考学习任务')} · {data.jobs.length}</summary>
      {data.jobs.map(job=><div className="creator-reference-job" key={job.id}>
        <strong>{job.title||job.url||t('参考切片')}</strong><small>{t(job.status==='failed'?'学习失败':phases[job.phase]||'排队中')} · {job.percent}%</small>
        {!!job.total_chunks&&<small>{t('分段进度 {{done}} / {{total}}',{done:job.completed_chunks||0,total:job.total_chunks})}</small>}
        {job.status==='completed'&&<small>{t('待确认条目')}：{job.proposal_count||0}</small>}
        {job.error&&<p role="alert">{t(job.error)}</p>}
        {['failed','cancelled'].includes(job.status)&&<Btn size="sm" onClick={()=>void action(job,'retry')}>{t('重试')}</Btn>}
        {['queued','running'].includes(job.status)&&<Btn size="sm" variant="text" onClick={()=>void action(job,'cancel')}>{t('停止后续分析')}</Btn>}
      </div>)}
      <small>{t('停止后，正在进行的下载或转写可能仍需结束；完成的转写会保留。')}</small>
    </details>}
    <div className="creator-knowledge-toolbar"><label>{t('知识状态')}<select className="ac-input" value={filter} onChange={e=>setFilter(e.target.value)}>
      <option value="pending">{t('待确认')}</option><option value="confirmed">{t('已启用')}</option><option value="disabled">{t('已停用')}</option><option value="all">{t('全部')}</option>
    </select></label><span>{items.length} / {data.items.length}</span></div>
    <p className="studio-muted">{t('只将已确认且与当前人物、素材相关的知识提供给选片 AI；你的制作要求优先。')}</p>
    <p className="studio-muted">{t('当前根据字幕和备注学习，纯画面梗需要补充说明。')}</p>
    {!items.length&&<p className="creator-knowledge-empty">{t('暂无此类人物知识。')}</p>}
    {items.map(item=><KnowledgeCard key={item.id} item={item} onSaved={next=>setData(current=>({...current,items:current.items.map(old=>old.id===next.id?next:old)}))}/>)}
  </section>
}
