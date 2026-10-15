import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { Btn } from '../../ui'
import api from '../../services/api'
import './character-background.css'
import CreatorLibrary from './CreatorLibrary'

export interface BackgroundReference { subject: string; title: string; url: string; excerpt: string; kind: 'profile' | 'article' | 'search_excerpt' }
export interface BackgroundReport {
  schema_version: 1; query: string; status: 'completed' | 'partial' | 'unavailable' | 'disabled'
  sources: BackgroundReference[]; retrieved_at: string; cached: boolean; stale: boolean; missing_subjects: string[]
}

export function BackgroundResearchSummary({ report }: { report?: BackgroundReport }) {
  if (!report || report.status === 'disabled') return null
  return <details className="studio-background-result" open={!report.sources.length}>
    <summary>{report.sources.length ? t('已找到 {{count}} 条角色参考资料', { count: report.sources.length }) : t('暂未找到可靠的角色资料')}{report.cached && <span>{t('已缓存')}</span>}</summary>
    {report.sources.length ? <p>{t('资料供选片理解人物和梗，请核对是否为同一角色。')}</p> : <p>{t('本次将按制作要求和视频内容选片，不会假装已查询背景。')}</p>}
    {report.status === 'partial' && <p>{t('部分背景或身份尚未核实，选片时会保留不确定性。')}</p>}
    {report.stale && <p>{t('更新暂时失败，使用上次保存的资料。')}</p>}
    {report.missing_subjects.length > 0 && <p>{t('未找到：')} {report.missing_subjects.join('、')}</p>}
    <ul>{report.sources.map(source => <li key={source.url}>
      <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<span aria-hidden="true"> ↗</span></a>
      <small>{source.subject} · {t(source.kind === 'article' ? '百科正文' : source.kind === 'profile' ? '账号简介' : '搜索摘要')}</small>
      <p>{source.excerpt}</p>
    </li>)}</ul>
  </details>
}

export default function CharacterBackground({ query, onChange, disabled }: {
  query: string; onChange: (value: string) => void; disabled: boolean
}) {
  const [report, setReport] = useState<BackgroundReport>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const currentQuery = useRef(query)
  currentQuery.current = query
  useEffect(() => {
    setReport(undefined); setError(''); setBusy(false)
    controller.current?.abort()
    return () => controller.current?.abort()
  }, [query])
  const lookup = async (force_refresh = false) => {
    const requested = query.trim()
    if (!requested) return
    const request = new AbortController()
    controller.current?.abort(); controller.current = request
    setBusy(true); setError('')
    try {
      const result = await api.post<unknown, BackgroundReport>('/studio/background-research', { query: requested, force_refresh }, { signal: request.signal })
      if (!request.signal.aborted && currentQuery.current.trim() === requested) setReport(result)
    } catch {
      if (!request.signal.aborted) setError(t('背景查询失败，可以重试；不影响按视频内容选片。'))
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  return <div className="studio-character-background">
    <label htmlFor="studio-background-query">{t('角色或组合名（选填）')}</label>
    <p>{t('填写准确名称，生成前会自动查询公开背景和梗；只发送名称，不发送视频或字幕。')}</p>
    <div className="studio-background-query">
      <input id="studio-background-query" className="ac-input" aria-label={t('角色或组合名')} maxLength={200} disabled={disabled}
        placeholder={t('例如：思诺snow、心宜不是心仪（B站/枝江娱乐）')} value={query} onChange={event => onChange(event.target.value)}/>
      <Btn size="sm" disabled={disabled || !query.trim() || busy} loading={busy} onClick={() => void lookup()}>{busy ? t('正在查询背景…') : t('先查背景')}</Btn>
    </div>
    <span className="studio-background-cache-note">{t('公开资料保留来源，缓存 7 天；可添加平台或组合名减少重名。')}</span>
    {error && <p className="studio-error" role="alert">{error}</p>}
    <BackgroundResearchSummary report={report}/>
    {report?.sources.length ? <CreatorLibrary query={query} report={report}/> : null}
    {report && <button className="studio-link studio-background-refresh" disabled={disabled || busy} onClick={() => void lookup(true)}>{t('重新查询背景')}</button>}
  </div>
}
