import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { fmtDuration } from '../../ui'
import type { Workspace } from './types'
import { utcMillis } from '../../analytics/workflow'

export default function TaskProgress({ workspace }: { workspace: Workspace }) {
  const generation = workspace.generation
  const active = ['screening','production','rendering'].includes(generation?.status || '') || workspace.analysis?.status === 'running' || workspace.jobs.some(job => ['queued','running'].includes(job.status))
    || workspace.output_variants?.some(item => ['preparing','queued','running'].includes(item.status))
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  if (!generation && !active) return null
  const start = utcMillis(generation?.created_at)
  const variants = workspace.output_variants || []
  const submitted = variants.filter(item=>item.status!=='on_demand')
  const completed = submitted.filter(item => item.status === 'completed').length
  const stages = ['分析与选段', '候选确认', '片段精修', '渲染与交付']
  const stage = generation?.status === 'awaiting_selection' ? 1 : variants.some(item => item.status === 'preparing') ? 2
    : workspace.jobs.some(job => ['queued','running'].includes(job.status)) || generation?.status === 'rendering' ? 3
      : generation?.status === 'production' ? 2 : generation?.status === 'completed' || generation?.status === 'partial' ? 3 : 0
  return <section className="studio-task-progress" aria-label={t('制作进度')}>
    <ol>{stages.map((label,index) => <li key={label} aria-current={index === stage ? 'step' : undefined}>{index + 1}. {t(label)}</li>)}</ol>
    <p role="status">{t(generation?.status === 'awaiting_selection' ? '请确认候选后再生成，当前不会自动渲染。'
      : active ? '任务在后台继续，可离开本页处理其他项目。' : generation?.status === 'failed' ? '制作未完成，可修正问题后重试。' : '查看已完成的结果，备选片段可按需生成。')}</p>
    <div className="studio-muted">{active && start !== undefined && start <= now && t('本次制作已用 {{duration}}', { duration: fmtDuration((now - start) / 1000) })}
      {submitted.length > 0 && ` · ${t('已完成 {{done}} / {{total}} 个版本', { done: completed, total: submitted.length })}`}</div>
  </section>
}
