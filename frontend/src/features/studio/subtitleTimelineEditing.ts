import type { SpeakerCue, SpeakerDocument } from './types'

export const MIN_CUE_MS = 100
type Window = { start: number; end: number }
export function cueInsideWindow(cue: SpeakerCue, window: Window) {
  return cue.start_ms >= Math.round(window.start * 1000) && cue.end_ms <= Math.round(window.end * 1000)
}
export function splitSubtitle(cues: SpeakerCue[], id: string, caret: number, atMs: number, newId: string, speakerId?: string | null): SpeakerCue[] | null {
  const index = cues.findIndex(cue => cue.id === id), cue = cues[index]
  if (!cue || !Number.isInteger(caret) || caret <= 0 || caret >= cue.text.length ||
    !Number.isSafeInteger(atMs) || atMs - cue.start_ms < MIN_CUE_MS || cue.end_ms - atMs < MIN_CUE_MS ||
    !newId || cues.some(row => row.id === newId)) return null
  const before = cue.text.slice(0, caret).trim(), after = cue.text.slice(caret).trim()
  if (!before || !after) return null
  const output = [...cues]
  output.splice(index, 1, { ...cue, text: before, end_ms: atMs, assignment_reason: 'manual' },
    { ...cue, id: newId, text: after, start_ms: atMs, speaker_id: speakerId === undefined ? cue.speaker_id : speakerId, assignment_reason: 'manual' })
  return output
}
export function mergeSubtitles(cues: SpeakerCue[], id: string, followingId: string): SpeakerCue[] | null {
  const first = cues.find(cue => cue.id === id), next = cues.find(cue => cue.id === followingId)
  if (!first || !next || first === next || first.speaker_id !== next.speaker_id || first.layer !== next.layer || next.start_ms < first.start_ms) return null
  const text = `${first.text.trim()} ${next.text.trim()}`
  if (text.length > 2000) return null
  return cues.filter(cue => cue.id !== followingId).map(cue => cue.id === id
    ? { ...cue, text, start_ms: Math.min(first.start_ms, next.start_ms), end_ms: Math.max(first.end_ms, next.end_ms), assignment_reason: 'manual' } : cue)
}
export function addSubtitleRange(document: SpeakerDocument, window: Window, left: number, right: number, id: string,
  text: string, speakerId: string | null, layer = 0): SpeakerCue[] | null {
  if (document.subtitles.length >= 10000 || document.subtitles.some(cue => cue.id === id) || !text.trim() || text.length > 2000 ||
    !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right - left < MIN_CUE_MS ||
    left < Math.round(window.start * 1000) || right > Math.min(document.duration_ms, Math.round(window.end * 1000)) ||
    ![0, 1].includes(layer) || (speakerId !== null && !document.speakers.some(speaker => speaker.speaker_id === speakerId))) return null
  return [...document.subtitles, { id, start_ms: left, end_ms: right, text: text.trim(), speaker_id: speakerId, layer, assignment_reason: 'manual' }]
    .sort((a, b) => a.start_ms - b.start_ms || a.layer - b.layer)
}
export function retimeSubtitle(cues: SpeakerCue[], id: string, left: number, right: number, window: Window): SpeakerCue[] | null {
  const cue = cues.find(row => row.id === id)
  if (!cue || !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right - left < MIN_CUE_MS ||
    left < Math.round(window.start * 1000) || right > Math.round(window.end * 1000)) return null
  return cues.map(row => row.id === id ? { ...row, start_ms: left, end_ms: right, assignment_reason: 'manual' } : row)
}
export function clockTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`
}
export function adjacentSubtitle(cues: SpeakerCue[], id: string, window: Window) {
  const sorted = cues.filter(cue => cueInsideWindow(cue, window)).sort((a, b) => a.start_ms - b.start_ms || a.layer - b.layer)
  const index = sorted.findIndex(cue => cue.id === id)
  return index < 0 ? undefined : sorted[index + 1]
}
