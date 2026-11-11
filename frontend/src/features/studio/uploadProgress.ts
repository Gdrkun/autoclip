export function uploadProgress(loaded: number, total?: number) {
  const bytes = Math.max(0, Number.isFinite(loaded) ? loaded : 0)
  const known = typeof total === 'number' && Number.isFinite(total) && total > 0
  return { bytes, percent: known ? Math.min(100, Math.floor(bytes / total * 100)) : null, transferred: known && bytes >= total }
}
