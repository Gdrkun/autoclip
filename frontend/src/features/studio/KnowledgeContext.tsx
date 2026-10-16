import { useEffect, useState } from 'react'
import api from '../../services/api'
import { t } from '../../i18n'
import { evidenceLink, type CharacterKnowledge } from './referenceKnowledge'

export default function KnowledgeContext({projectId}:{projectId:string}) {
  const [items,setItems]=useState<CharacterKnowledge[]>([])
  useEffect(()=>{
    let active=true
    void api.get<unknown,{items:CharacterKnowledge[]}>(`/studio/${projectId}/creator-knowledge-context`)
      .then(value=>{if(active)setItems(value.items)}).catch(()=>{if(active)setItems([])})
    return ()=>{active=false}
  },[projectId])
  if(!items.length)return null
  return <details className="creator-corrections"><summary>{t('本次选片参考的人物知识')} · {items.length}</summary>
    <p>{t('以下条目已提供给选片 AI，不代表每条都命中；是否成立以当前素材为准。')}</p>
    {items.map(item=><article key={item.id}><strong>{item.title}</strong><p>{item.explanation}</p>
      {item.context&&<p>{item.context}</p>}
      {item.source_url&&<a href={evidenceLink(item)} target="_blank" rel="noopener noreferrer">{item.source_title} ↗</a>}
    </article>)}
  </details>
}
