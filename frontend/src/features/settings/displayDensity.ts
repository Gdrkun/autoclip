export type DisplayDensity = 'comfortable' | 'compact'
const key = 'autoclip.displayDensity'
export function readDisplayDensity(): DisplayDensity {
  try { return localStorage.getItem(key) === 'compact' ? 'compact' : 'comfortable' } catch { return 'comfortable' }
}
export function applyDisplayDensity(density: DisplayDensity) {
  document.documentElement.dataset.density = density
  try { localStorage.setItem(key, density) } catch { /* Current session remains usable. */ }
}
