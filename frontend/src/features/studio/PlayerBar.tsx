import { t } from '../../i18n'
import { fmtDuration } from '../../ui'

const Icon = ({ d }: { d: string }) => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={d} fill="currentColor" /></svg>
const PLAY = 'M4 2.5v11l9-5.5z'
const PAUSE = 'M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z'
const SOUND = 'M2 6h3l4-3.5v11L5 10H2zM11 5.2a3.6 3.6 0 0 1 0 5.6v-1.4a2.2 2.2 0 0 0 0-2.8z'
const MUTED = 'M2 6h3l4-3.5v11L5 10H2zM10.6 6.1l1 1 1.4-1.4 1 1L12.6 8l1.4 1.4-1 1-1.4-1.4-1.4 1.4-1-1L10.6 8 9.2 6.6l1-1z'

/**
 * Transport for the editor preview, scoped to what the clip actually uses: the scrubber runs from
 * 0 to the scene length (not the whole source), so the timeline is the clip's timeline.
 */
export default function PlayerBar({ offset, length, playing, muted, onToggle, onSeek, onMute, rate=1, onRate }: {
  /** Seconds into the scene (already clamped by the caller). */
  offset: number
  length: number
  playing: boolean
  muted: boolean
  onToggle: () => void
  onSeek: (offset: number) => void
  onMute: () => void
  rate?:number
  onRate?:(rate:number)=>void
}) {
  const jump=(seconds:number)=>onSeek(Math.max(0,Math.min(length,offset+seconds)))
  return <div className="studio-player-controls"><div className="studio-player-bar" role="group" aria-label={t("播放控制")} tabIndex={0} onKeyDown={event=>{
    if((event.target as HTMLElement).closest('input,select,textarea')||event.ctrlKey||event.metaKey||event.altKey)return
    if((event.target as HTMLElement).tagName==='BUTTON'&&event.key===' ')return
    if([' ','k','j','l','ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();event.stopPropagation()
      if(event.key===' '||event.key==='k')onToggle();else jump(event.key==='j'||event.key==='ArrowLeft'?-2:2)
    }
  }}>
    <button type="button" className="studio-player-btn" aria-label={playing ? t("暂停") : t("播放")} onClick={onToggle}><Icon d={playing ? PAUSE : PLAY} /></button>
    <span className="ac-mono studio-player-time">{fmtDuration(offset)} / {fmtDuration(length)}</span>
    <input type="range" aria-label={t("成片进度")} min={0} max={Math.max(length, .1)} step={.05} value={Math.min(offset, length)} onChange={e => onSeek(Number(e.target.value))} />
    <button type="button" className="studio-player-btn" aria-label={muted ? t("取消静音") : t("静音")} aria-pressed={muted} onClick={onMute}><Icon d={muted ? MUTED : SOUND} /></button>
  </div>{onRate&&<div className="studio-player-extras"><button className="studio-player-jump" type="button" onClick={()=>jump(-2)}>{t('后退 2 秒')}</button><button className="studio-player-jump" type="button" onClick={()=>jump(2)}>{t('前进 2 秒')}</button><label>{t('播放速度')}<select aria-label={t('播放速度')} value={rate} onChange={event=>onRate(Number(event.target.value))}>{[.5,.75,1,1.25,1.5,2].map(value=><option key={value} value={value}>{value}×</option>)}</select></label></div>}</div>
}
