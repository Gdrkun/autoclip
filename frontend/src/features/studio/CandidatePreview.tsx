import { useRef, useState } from 'react'
import { t } from '../../i18n'
import { studioApi } from './api'
import PlayerBar from './PlayerBar'
import { candidatePosition } from './candidatePlayback'
import type { Scene } from './types'

export default function CandidatePreview({ projectId, scenes }: { projectId: string; scenes: Scene[] }) {
  const video = useRef<HTMLVideoElement>(null)
  const segment = useRef(0)
  const [offset, setOffset] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState(false)
  const length = scenes.reduce((sum, scene) => sum + scene.end - scene.start, 0)
  const seek = (value: number) => {
    const position = candidatePosition(scenes, value)
    if (!video.current || !position) return
    segment.current = position.index
    video.current.currentTime = position.time
    setOffset(Math.max(0, Math.min(value, length)))
  }
  const toggle = () => {
    const player = video.current
    if (!player) return
    if (!player.paused) { player.pause(); return }
    if (offset >= length) seek(0)
    void player.play().catch(() => setPlaying(false))
  }
  return <div className="studio-candidate-preview">
    <video ref={video} controls={false} playsInline preload="metadata" muted={muted} src={studioApi.source(projectId)}
      aria-label={t('原片候选预览')} onClick={toggle} onError={() => setError(true)} onLoadedMetadata={() => seek(0)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => {
        const player = video.current, scene = scenes[segment.current]
        if (!player || !scene) return
        if (player.currentTime >= scene.end) {
          if (segment.current + 1 < scenes.length) { segment.current += 1; player.currentTime = scenes[segment.current].start }
          else { player.pause(); if (Math.abs(player.currentTime - scene.end) > .01) player.currentTime = scene.end; setOffset(length); return }
        }
        if (player.currentTime < scenes[segment.current].start) player.currentTime = scenes[segment.current].start
        setOffset(scenes.slice(0, segment.current).reduce((sum, item) => sum + item.end - item.start, 0) + player.currentTime - scenes[segment.current].start)
      }} />
    {error ? <p className="studio-error" role="alert">{t('原片暂时无法播放，可进入编辑器生成兼容预览。')}</p> : <PlayerBar offset={offset} length={length} playing={playing} muted={muted} onToggle={toggle} onSeek={seek} onMute={() => setMuted(value => !value)}/>}
    <p className="studio-muted">{t('原片片段预览，字幕与包装以生成结果为准。')}</p>
  </div>
}
