export const selectionPreferencePresets = [
  { label: '唱歌', instruction: '优先保留唱歌片段，保留完整乐句与必要的互动。' },
  { label: '搞笑', instruction: '优先保留搞笑互动，保留铺垫、包袱和对方反应。' },
  { label: '网络流行梗', instruction: '优先保留网络流行梗，保留理解梗所需的上下文。' },
  { label: '迷因', instruction: '优先保留迷因和玩梗片段，不编造梗的出处或含义。' },
]

export function toggleSelectionPreference(value: string, instruction: string): string {
  const lines = value.split('\n')
  if (lines.includes(instruction)) return lines.filter(line => line !== instruction).join('\n').trim()
  const next = [value.trim(), instruction].filter(Boolean).join('\n')
  return next.length <= 1000 ? next : value
}
