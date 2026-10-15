import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { Btn, Dialog } from '../../ui'
import api from '../../services/api'
import { errorText } from './api'
import type { BackgroundReport, BackgroundReference } from './CharacterBackground'
import './creator-library.css'

export type CharacterProfile = {id:string; name:string; aliases:string[]; background:string; memes:string; sources:BackgroundReference[]}
export type VocabularyTerm = {correct:string; variants:string[]; scope:string}
export type LibraryFeedback = {id:string; query:string; direction:'more'|'less'; category:string; title:string; note:string}
export type Library = {schema_version:1; revision:number; profiles:CharacterProfile[]; terms:VocabularyTerm[]; feedback:LibraryFeedback[]}
const empty:Library = {schema_version:1,revision:0,profiles:[],terms:[],feedback:[]}
const split = (value:string) => value.split(/[、,，;；\n]+/).map(item=>item.trim()).filter(Boolean)
export const feedbackLabels:Record<string,string> = {singing:'唱歌',humor:'搞笑',interaction:'人物互动',meme:'玩梗',other:'其他'}

function DelimitedInput({value,onChange}:{value:string[];onChange:(value:string[])=>void}) {
  const [text,setText]=useState(value.join('、'))
  useEffect(()=>setText(value.join('、')),[value])
  return <input className="ac-input" maxLength={1800} value={text} onChange={event=>setText(event.target.value)} onBlur={()=>onChange(split(text))}/>
}

export default function CreatorLibrary({query='',report}:{query?:string; report?:BackgroundReport}) {
  const [open,setOpen]=useState(false), [library,setLibrary]=useState<Library>(empty)
  const [selected,setSelected]=useState(''), [tab,setTab]=useState('profiles')
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [message,setMessage]=useState('')
  const profile=library.profiles.find(item=>item.id===selected)
  const show=async()=>{setOpen(true);setBusy(true);setError('');setMessage('');try {
    const value=await api.get<unknown,Library>('/studio/creator-library');setLibrary(value);setSelected(value.profiles[0]?.id||'')
  }catch(e){setError(errorText(e))}finally{setBusy(false)}}
  const patch=(update:Partial<CharacterProfile>)=>setLibrary({...library,profiles:library.profiles.map(item=>item.id===selected?{...item,...update}:item)})
  const add=(name='')=>{const item:CharacterProfile={id:crypto.randomUUID(),name,aliases:[],background:'',memes:'',sources:[]};setLibrary({...library,profiles:[...library.profiles,item]});setSelected(item.id);setTab('profiles')}
  const importProfile=(name:string)=>{
    const existing=library.profiles.find(item=>item.name===name||item.aliases.includes(name))
    if(existing){setSelected(existing.id);setTab('profiles');setMessage(t('已有同名档案，保留你的修订。'));return}
    const sources=report?.sources.filter(source=>source.subject===name)||[]
    const item:CharacterProfile={id:crypto.randomUUID(),name,aliases:[],background:sources.map(source=>source.excerpt).join('\n\n').slice(0,6000),memes:'',sources}
    setLibrary({...library,profiles:[...library.profiles,item]});setSelected(item.id);setTab('profiles')
  }
  const save=async()=>{setBusy(true);setError('');setMessage('');try {
    const result=await api.put<unknown,Library>('/studio/creator-library',library);setLibrary(result);setMessage(t('已保存，下次转写和选片时使用。'))
  }catch(e){setError(errorText(e))}finally{setBusy(false)}}
  return <><Btn size="sm" onClick={()=>void show()}>{t(report?'保存到角色档案':'角色档案与词库')}</Btn>
    <Dialog open={open} onClose={()=>!busy&&setOpen(false)} title={t('角色档案与词库')} description={t('保存在本机；填写角色名后匹配档案。当前制作要求优先于历史偏好。')}
      footer={<div className="studio-actions"><Btn disabled={busy} onClick={()=>setOpen(false)}>{t('关闭')}</Btn><Btn variant="cta" disabled={busy} loading={busy} onClick={()=>void save()}>{t('保存知识库')}</Btn></div>}>
      <div className="creator-library">
        <div className="creator-tabs" role="group" aria-label={t('知识库分类')}>{[['profiles','角色与梗'],['terms','字幕词库'],['feedback','选片记忆']].map(([key,label])=><button key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{t(label)}</button>)}</div>
        {error&&<p className="studio-error" role="alert">{t(error)}</p>}{message&&<p role="status">{message}</p>}
        {tab==='profiles'&&<>
          <div className="studio-actions"><select className="ac-input" aria-label={t('选择角色档案')} value={selected} disabled={busy} onChange={event=>setSelected(event.target.value)}><option value="">{t('选择角色档案')}</option>{library.profiles.map(item=><option key={item.id} value={item.id}>{item.name||t('新角色')}</option>)}</select><Btn size="sm" disabled={busy||library.profiles.length>=100} onClick={()=>add(query.replace(/[（(].*?[）)]/g,'').split(/[、,，]/)[0].trim())}>{t('新建角色')}</Btn></div>
          {!!report?.sources.length&&<div className="creator-import-sources"><span>{t('从本次检索新建：')}</span>{[...new Set(report.sources.map(source=>source.subject))].map(name=><Btn key={name} size="sm" disabled={busy||library.profiles.length>=100} onClick={()=>importProfile(name)}>{name}</Btn>)}</div>}
          {profile?<fieldset disabled={busy} className="creator-fields">
            <label>{t('角色名称')}<input className="ac-input" maxLength={100} value={profile.name} onChange={event=>patch({name:event.target.value})}/></label>
            <label>{t('别名（用顿号分隔）')}<DelimitedInput value={profile.aliases} onChange={aliases=>patch({aliases})}/></label>
            <label>{t('人物背景与关系')}<textarea className="ac-input" rows={5} maxLength={6000} value={profile.background} onChange={event=>patch({background:event.target.value})}/></label>
            <label>{t('梗词典与适用语境')}<textarea className="ac-input" rows={5} maxLength={6000} placeholder={t('写清梗的含义、触发语境和容易误解的地方。')} value={profile.memes} onChange={event=>patch({memes:event.target.value})}/></label>
            {profile.sources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}
            <Btn variant="danger" size="sm" onClick={()=>{setLibrary({...library,profiles:library.profiles.filter(item=>item.id!==selected)});setSelected('')}}>{t('删除此档案')}</Btn>
          </fieldset>:<p>{t('新建角色，或从检索结果导入后修订。')}</p>}
        </>}
        {tab==='terms'&&<>
          <p>{t('正确写法用于 Whisper 热词；易错写法只生成纠错建议，确认后才改字幕。')}</p>
          <p>{t('适用角色留空表示通用，多个角色用顿号分隔。SenseVoice 使用识别后纠错。')}</p>
          {library.terms.map((term,index)=><fieldset key={index} disabled={busy} className="creator-term">
            <label>{t('正确写法')}<input className="ac-input" maxLength={80} value={term.correct} onChange={event=>setLibrary({...library,terms:library.terms.map((item,i)=>i===index?{...item,correct:event.target.value}:item)})}/></label>
            <label>{t('易错写法')}<DelimitedInput value={term.variants} onChange={variants=>setLibrary({...library,terms:library.terms.map((item,i)=>i===index?{...item,variants}:item)})}/></label>
            <label>{t('适用角色')}<input className="ac-input" maxLength={200} value={term.scope} onChange={event=>setLibrary({...library,terms:library.terms.map((item,i)=>i===index?{...item,scope:event.target.value}:item)})}/></label>
            <Btn variant="danger" size="sm" aria-label={`${t('删除词条')} ${index+1}`} onClick={()=>setLibrary({...library,terms:library.terms.filter((_,i)=>i!==index)})}>{t('删除词条')}</Btn>
          </fieldset>)}
          <Btn size="sm" disabled={busy||library.terms.length>=200} onClick={()=>setLibrary({...library,terms:[...library.terms,{correct:'',variants:[],scope:''}]})}>{t('添加词条')}</Btn>
        </>}
        {tab==='feedback'&&<><p>{t('成片上的“多选这种 / 少选这种”会保存在这里，按角色用于以后选片。')}</p>
          {!library.feedback.length&&<p>{t('还没有选片记忆。')}</p>}
          {[...library.feedback].reverse().map(item=><div className="creator-memory" key={item.id}><b>{t(item.direction==='more'?'多选这种':'少选这种')} · {t(feedbackLabels[item.category])}</b><p>{item.title}</p><p>{item.note}</p><small>{item.query||t('通用偏好')}</small><Btn size="sm" variant="text" disabled={busy} onClick={()=>setLibrary({...library,feedback:library.feedback.filter(value=>value.id!==item.id)})}>{t('忘记这条')}</Btn></div>)}
        </>}
      </div>
    </Dialog></>
}
