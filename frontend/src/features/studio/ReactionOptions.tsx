import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import api from '../../services/api'
import type { ImportOptions } from './types'
import './visual-reactions.css'

export default function ReactionOptions({value,onChange,disabled=false}:{value:ImportOptions;onChange:(value:ImportOptions)=>void;disabled?:boolean}) {
  const [allowed,setAllowed]=useState<boolean|null>(null)
  useEffect(()=>{let active=true;void api.get<unknown,{allowed:boolean}>('/studio/visual-reactions/status')
    .then(result=>{if(active)setAllowed(result.allowed)}).catch(()=>{if(active)setAllowed(false)})
    return ()=>{active=false}
  },[])
  return <div className="reaction-options">
    <label><input type="checkbox" checked={!!value.visual_reactions} disabled={disabled||allowed!==true}
      onChange={event=>onChange({...value,visual_reactions:event.target.checked})}/><span>{t('画面反应辅助选片')}</span></label>
    <p>{t('结合全景连续帧、场景变化、音量线索和字幕寻找互动看点，无需框选人物。')}</p>
    {allowed===false&&<p>{t('请先在 AI 设置中准备视觉模型并允许画面分析。')}</p>}
    {value.visual_reactions&&<>
      <label>{t('画面复核预算')}<select className="ac-input" value={value.reaction_budget||8} disabled={disabled}
        onChange={event=>onChange({...value,reaction_budget:Number(event.target.value)})}>
        {[4,8,12].map(count=><option key={count} value={count}>{t('最多 {{count}} 个区间',{count})}</option>)}
      </select></label>
      <p>{t('会向已配置的视觉模型发送候选全景画面、附近字幕和制作要求，可能产生用量；缓存命中时复用。')}</p>
      <p>{t('长视频按预算抽查候选，可能漏掉未覆盖的反应；音量变化不等于笑声。')}</p>
    </>}
  </div>
}
