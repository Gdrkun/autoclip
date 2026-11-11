import type { Scene } from './types'
export function candidatePosition(scenes: Scene[], offset: number) {
  let remaining = Math.max(0, Number.isFinite(offset) ? offset : 0)
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index], length = scene.end - scene.start
    if (remaining < length || index === scenes.length - 1) return { index, time: scene.start + Math.min(remaining, length) }
    remaining -= length
  }
  return null
}
