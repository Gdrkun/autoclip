import { normalizeImportOptions } from './importDraft'
import type { ImportOptions } from './types'
export interface ProductionPreset { id: string; name: string; options: ImportOptions; platforms: string[] }
const key = 'autoclip.productionPresets.v1'
export function readProductionPresets(): ProductionPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.slice(0,20).filter(item => typeof item?.id === 'string' && typeof item?.name === 'string' && item.options && Array.isArray(item.platforms))
      .map(item => ({ id:item.id.slice(0,100), name:item.name.slice(0,40), options:normalizeImportOptions(item.options), platforms:item.platforms.filter((id: unknown) => typeof id === 'string' && /^[a-z_]{1,40}$/.test(id)) }))
      .filter(item => item.name.trim() && item.platforms.length)
  } catch { return [] }
}
export function storeProductionPreset(items: ProductionPreset[], preset: ProductionPreset): ProductionPreset[] {
  const next = items.filter(item => item.id !== preset.id && item.name !== preset.name)
  if (next.length >= 20) throw new Error('最多保存 20 个制作预设，请先删除不再使用的预设。')
  next.push({ id:preset.id, name:preset.name, options:normalizeImportOptions(preset.options), platforms:[...preset.platforms] })
  localStorage.setItem(key, JSON.stringify(next))
  return next
}
export function removeProductionPreset(items: ProductionPreset[], id: string): ProductionPreset[] {
  const next=items.filter(item=>item.id!==id)
  localStorage.setItem(key,JSON.stringify(next)); return next
}
