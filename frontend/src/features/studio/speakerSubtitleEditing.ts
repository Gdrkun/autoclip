import type { Scene, SpeakerCaptionLayout, SpeakerCue, SpeakerDocument } from './types'

type ScopeScene = Pick<Scene, 'start' | 'end'>
export function speakerCuesForScenes(cues: SpeakerCue[], scenes?: ScopeScene[]) {
  return scenes ? cues.filter(cue => scenes.some(scene => cue.start_ms < scene.end * 1000 && cue.end_ms > scene.start * 1000)) : cues
}

function replaceScopedOrder(cues: SpeakerCue[], scoped: SpeakerCue[], ordered: SpeakerCue[]) {
  const ids = new Set(scoped.map(cue => cue.id))
  let index = 0
  return cues.map(cue => ids.has(cue.id) ? ordered[index++] : cue)
}

export function sortSpeakerCuesInScenes(cues: SpeakerCue[], scenes?: ScopeScene[]) {
  const scoped = speakerCuesForScenes(cues, scenes)
  return replaceScopedOrder(cues, scoped, sortSpeakerCues(scoped))
}

export function moveSpeakerCueInScenes(cues: SpeakerCue[], scenes: ScopeScene[] | undefined, id: string, delta: number) {
  const scoped = speakerCuesForScenes(cues, scenes)
  const index = scoped.findIndex(cue => cue.id === id)
  return replaceScopedOrder(cues, scoped, moveSpeakerCue(scoped, index, delta))
}

export function speakerCueSeek(cue: SpeakerCue, scenes: ScopeScene[], preferred = 0) {
  const matches = (scene: ScopeScene) => cue.start_ms < scene.end * 1000 && cue.end_ms > scene.start * 1000
  const sceneIndex = scenes[preferred] && matches(scenes[preferred]) ? preferred : scenes.findIndex(matches)
  return sceneIndex < 0 ? null : { seconds: Math.max(cue.start_ms / 1000, scenes[sceneIndex].start), sceneIndex }
}

export function insertSpeakerCueInScenes(document: SpeakerDocument, scenes: ScopeScene[] | undefined,
  seconds: number, id: string, text: string, afterId?: string): SpeakerCue[] {
  if (!scenes) return insertSpeakerCue(document, seconds, id, text, afterId)
  const after = document.subtitles.find(cue => cue.id === afterId)
  const scene = after ? scenes.find(scene => after.start_ms < scene.end * 1000 && after.end_ms > scene.start * 1000)
    : scenes.find(scene => scene.start <= seconds && seconds < scene.end) || scenes[0]
  if (!scene) return document.subtitles
  const left = Math.round(scene.start * 1000), right = Math.min(document.duration_ms, Math.round(scene.end * 1000))
  if (right - left < 100) return document.subtitles
  const start = Math.max(left, Math.min(after ? after.end_ms : Math.round(seconds * 1000), right - 100))
  const scoped = speakerCuesForScenes(document.subtitles, [scene])
  const next = sortSpeakerCues(scoped).find(cue => cue.start_ms > start)
  const cue: SpeakerCue = { id, text, start_ms: start, end_ms: Math.min(right, start + 2000, next?.start_ms ?? right),
    speaker_id: null, layer: 0, assignment_reason: 'manual' }
  const afterIndex = document.subtitles.findIndex(cue => cue.id === afterId)
  const followingIndex = next ? document.subtitles.findIndex(cue => cue.id === next.id) : -1
  const lastIndex = scoped.length ? document.subtitles.findIndex(cue => cue.id === scoped[scoped.length - 1].id) + 1 : document.subtitles.length
  const result = [...document.subtitles]
  result.splice(afterIndex >= 0 ? afterIndex + 1 : followingIndex >= 0 ? followingIndex : lastIndex, 0, cue)
  return result
}

export function sortSpeakerCues(cues: SpeakerCue[]): SpeakerCue[] {
  return [...cues].sort((a, b) => a.start_ms - b.start_ms || a.layer - b.layer)
}

export function moveSpeakerCue(cues: SpeakerCue[], index: number, delta: number): SpeakerCue[] {
  const next = index + delta
  if (index < 0 || index >= cues.length || next < 0 || next >= cues.length) return cues
  const result = [...cues]
  ;[result[index], result[next]] = [result[next], result[index]]
  return result
}

export function insertSpeakerCue(document: SpeakerDocument, seconds: number, id: string, text: string, afterId?: string): SpeakerCue[] {
  const index = document.subtitles.findIndex(cue => cue.id === afterId)
  const following = index >= 0 ? document.subtitles[index + 1] : undefined
  const requested = index >= 0 ? document.subtitles[index].end_ms : Math.round(seconds * 1000)
  const start = Math.max(0, Math.min(requested, document.duration_ms - 100))
  let end = Math.min(document.duration_ms, start + 2000)
  if (following && following.start_ms > start) end = Math.min(end, following.start_ms)
  const cue: SpeakerCue = { id, start_ms: start, end_ms: end, text, speaker_id: null, layer: 0, assignment_reason: 'manual' }
  if (index < 0) return sortSpeakerCues([...document.subtitles, cue])
  const cues = [...document.subtitles]
  cues.splice(index + 1, 0, cue)
  return cues
}

function roundPixel(value: number) {
  const lower = Math.floor(value)
  return value - lower === .5 ? lower + lower % 2 : Math.round(value)
}

export function speakerCaptionGeometry(width: number, height: number, style: string, layout?: SpeakerCaptionLayout | null) {
  const base = Math.max(14, roundPixel(height * (style === 'bold' ? .05 : .042)))
  const fontSize = roundPixel(base * (layout?.font_scale ?? 1))
  return { fontSize, x: layout ? roundPixel(width * layout.x) : Math.floor(width / 2),
    y: layout ? roundPixel(height * layout.y) : height - Math.max(18, roundPixel(height * .09)),
    rowGap: roundPixel(fontSize * 1.6) }
}

export function speakerCaptionOutline(layout?: SpeakerCaptionLayout | null) {
  const enabled = layout?.outline_enabled !== false
  const width = layout?.outline_width == null ? 2 : layout.outline_width * (layout.font_scale ?? 1)
  return { enabled, width: enabled ? width : 0, color: layout?.outline_color || '#000000' }
}

export function activeSpeakerRows(document: SpeakerDocument, seconds: number, sceneStart: number, sceneEnd: number) {
  let active: { end: number; slot: number }[] = []
  const rows: { cue: SpeakerCue; slot: number }[] = []
  for (const cue of sortSpeakerCues(document.subtitles)) {
    const start = Math.max(sceneStart * 1000, cue.start_ms), end = Math.min(sceneEnd * 1000, cue.end_ms)
    if (end <= start) continue
    active = active.filter(row => row.end > start)
    let slot = cue.layer
    if (active.some(row => row.slot === slot)) slot = 1 - slot
    if (active.some(row => row.slot === slot)) continue
    active.push({ end, slot })
    if (start <= seconds * 1000 && seconds * 1000 < end) rows.push({ cue, slot })
  }
  return rows
}
