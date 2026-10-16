export interface ReactionEvent {
  id:string; kind:string; label:string; start:number; end:number; observed_at:number[]
  evidence:string; uncertainty:string; window_id:number; ignored:boolean
}
export interface ReactionReport {
  status:string; run_id:string; error:string; completed_windows:number; failed_windows:number
  request_budget:number; events:ReactionEvent[]; windows:{id:number;times:number[]}[]
}
export function visibleReactions(events:ReactionEvent[],scenes:{start:number;end:number}[]) {
  return events.filter(event=>scenes.some(scene=>event.start<scene.end&&event.end>scene.start))
}
export function evidenceFrameIndices(event:ReactionEvent,report:ReactionReport) {
  const times=report.windows.find(window=>window.id===event.window_id)?.times||[]
  return event.observed_at.slice(0,3).map(at=>times.findIndex(time=>Math.abs(time-at)<.015)).filter(index=>index>=0)
}
