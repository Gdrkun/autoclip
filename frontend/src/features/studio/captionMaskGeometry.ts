/** Map a source caption band through the video's actual contain/cover rectangle. */
export function captionMaskRect(band: [number, number], source: { width: number; height: number },
  frame: { width: number; height: number }, fit: string, position = .5) {
  if (![...band, source.width, source.height, frame.width, frame.height, position].every(Number.isFinite)
    || band[0] < 0 || band[1] > 1 || band[1] <= band[0]
    || Math.min(source.width, source.height, frame.width, frame.height) <= 0) return null
  const ratios = [frame.width / source.width, frame.height / source.height]
  const scale = fit === 'cover' ? Math.max(...ratios) : Math.min(...ratios)
  const width = source.width * scale, height = source.height * scale
  const x = (frame.width - width) * Math.max(0, Math.min(1, position))
  const y = (frame.height - height) / 2
  const left = Math.max(0, x), top = Math.max(0, y + height * band[0])
  const right = Math.min(frame.width, x + width), bottom = Math.min(frame.height, y + height * band[1])
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top, blur: 40 * scale } : null
}
