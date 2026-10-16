import { useEffect, useState, type RefObject } from 'react'
import { captionMaskRect } from './captionMaskGeometry'

/** Blur the source pixels before the separate speaker-caption overlay is painted. */
export default function CaptionMaskPreview({ video, band, sourceSize, fit, position }: {
  video: RefObject<HTMLVideoElement>; band: [number, number]; sourceSize: { width: number; height: number }
  fit: 'contain' | 'cover'; position: number
}) {
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const parent = video.current?.parentElement
    if (!parent) return
    const update = () => setFrame({ width: parent.clientWidth, height: parent.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [video])
  const rect = captionMaskRect(band, sourceSize, frame, fit, position)
  if (!rect) return null
  return <div aria-hidden="true" data-caption-mask style={{ position: 'absolute', pointerEvents: 'none',
    left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    backdropFilter: `blur(${rect.blur}px)`, WebkitBackdropFilter: `blur(${rect.blur}px)` }} />
}
