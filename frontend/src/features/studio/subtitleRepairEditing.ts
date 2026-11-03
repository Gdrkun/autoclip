import type { SpeakerCue, SpeakerDocument } from './types'

export type RepairJob = { job_id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; stage: string;
  start_ms: number; end_ms: number; source_version: string; backend: string; subtitles: SpeakerCue[]; error?: string }
export const repairCues = (document: SpeakerDocument, start: number, end: number) => document.subtitles.filter(cue => cue.start_ms < end && cue.end_ms > start)
export const repairSignature = (document: SpeakerDocument, start: number, end: number) => JSON.stringify({ duration: document.duration_ms,
  cues: repairCues(document, start, end), speakers: document.speakers.map(speaker => speaker.speaker_id) })
export function repairCandidates(document: SpeakerDocument, job: RepairJob) {
  return job.subtitles.map(cue => {
    const speakers = new Set(repairCues(document, cue.start_ms, cue.end_ms).map(original => original.speaker_id))
    return { ...cue, speaker_id: speakers.size === 1 ? [...speakers][0] : null }
  })
}
export function applyRepair(document: SpeakerDocument, job: RepairJob, signature: string, candidates: SpeakerCue[], mode: 'replace' | 'append', allowManual: boolean): SpeakerCue[] | null {
  if (job.status !== 'completed' || !candidates.length || repairSignature(document, job.start_ms, job.end_ms) !== signature) return null
  if (!candidates.every(cue => Number.isInteger(cue.start_ms) && Number.isInteger(cue.end_ms) && cue.start_ms >= job.start_ms && cue.end_ms <= job.end_ms &&
    cue.end_ms - cue.start_ms >= 100 && !!cue.text.trim() && cue.text.length <= 2000 && [0, 1].includes(cue.layer) &&
    (cue.speaker_id === null || document.speakers.some(speaker => speaker.speaker_id === cue.speaker_id)))) return null
  const originals = repairCues(document, job.start_ms, job.end_ms)
  if (mode === 'replace' && originals.some(cue => cue.start_ms < job.start_ms || cue.end_ms > job.end_ms || (!allowManual && cue.assignment_reason === 'manual'))) return null
  const remove = new Set(mode === 'replace' ? originals.map(cue => cue.id) : [])
  const result = [...document.subtitles.filter(cue => !remove.has(cue.id)), ...candidates.map(cue => ({ ...cue, assignment_reason: 'manual' }))]
    .sort((a, b) => a.start_ms - b.start_ms || a.layer - b.layer || a.end_ms - b.end_ms)
  return result.length <= 10000 && new Set(result.map(cue => cue.id)).size === result.length ? result : null
}
