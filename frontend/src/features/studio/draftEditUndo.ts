import type { Draft, Scene } from './types'
type Copy = Pick<Draft, 'title' | 'hook'>
export type DraftEditUndo = { kind: 'copy'; before: Copy; after: Copy } | { kind: 'scenes'; before: Scene[]; after: Scene[] }
export function copyFields(draft: Copy): Copy { return { title: draft.title, hook: draft.hook } }

/** Only undo fields still equal to this operation's result; later manual work wins. */
export function undoDraftEdit(draft: Draft, undo: DraftEditUndo): Draft {
  if (undo.kind === 'scenes') {
    return JSON.stringify(draft.scenes) === JSON.stringify(undo.after) ? { ...draft, scenes: undo.before } : draft
  }
  const patch: Partial<Copy> = {}
  for (const key of ['title', 'hook'] as const) {
    if (draft[key] === undo.after[key] && undo.before[key] !== undo.after[key]) patch[key] = undo.before[key]
  }
  return Object.keys(patch).length ? { ...draft, ...patch } : draft
}
