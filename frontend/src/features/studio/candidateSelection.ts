const key = (projectId: string) => `autoclip.candidateSelection.${projectId}`
export function readCandidateSelection(projectId: string): string[] {
  try {
    const ids: unknown = JSON.parse(sessionStorage.getItem(key(projectId)) || '[]')
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))] : []
  } catch { return [] }
}
export function writeCandidateSelection(projectId: string, ids: string[]) {
  try {
    if (ids.length) sessionStorage.setItem(key(projectId), JSON.stringify(ids))
    else sessionStorage.removeItem(key(projectId))
  } catch { /* Selection within the current page still works without storage. */ }
}
export function rememberCandidateScroll(projectId: string, position: number) {
  try { sessionStorage.setItem(`${key(projectId)}.scroll`, String(Math.max(0, position))) } catch { /* Optional view state. */ }
}
export function takeCandidateScroll(projectId: string): number | null {
  try {
    const stored = sessionStorage.getItem(`${key(projectId)}.scroll`)
    sessionStorage.removeItem(`${key(projectId)}.scroll`)
    const value = Number(stored)
    return stored !== null && Number.isFinite(value) && value >= 0 ? value : null
  } catch { return null }
}
