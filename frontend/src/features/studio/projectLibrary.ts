import type { Project } from '../../store/useProjectStore'
export function filterProjects(projects:Project[], query:string, status:string, sort:string) {
  const needle=query.trim().toLocaleLowerCase()
  const date=(value:string)=>Date.parse(value)||0
  return projects.filter(project=>!project.settings?.import_staging && !project.processing_config?.import_staging)
    .filter(project=>(!needle||project.name.toLocaleLowerCase().includes(needle)) && (status==='all'||!status||project.status===status||(status==='error'&&project.status==='failed')))
    .sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):sort==='created'?date(b.created_at)-date(a.created_at):date(b.updated_at||b.created_at)-date(a.updated_at||a.created_at))
}
