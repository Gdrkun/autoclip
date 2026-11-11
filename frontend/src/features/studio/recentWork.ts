const key='autoclip.recentWork.v1'
export interface RecentWork { projectId:string; draftId?:string }
export function readRecentWork():RecentWork|null {
  try { const item=JSON.parse(localStorage.getItem(key)||'null');return typeof item?.projectId==='string'?{projectId:item.projectId,draftId:typeof item.draftId==='string'?item.draftId:undefined}:null } catch{return null}
}
export function rememberRecentWork(work:RecentWork) { try{localStorage.setItem(key,JSON.stringify(work))}catch{/* Navigation still works. */} }
