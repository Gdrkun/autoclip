export interface KnowledgeEvidence { start_ms: number; end_ms: number; quote: string }
export interface CharacterKnowledge {
  id: string; revision: number; subjects: string; kind: 'meme'|'selection'|'relationship'|'vocabulary'
  title: string; explanation: string; triggers: string[]; context: string; caution: string
  status: 'pending'|'confirmed'|'disabled'; reference_id: string; source_title: string; source_url: string
  transcript_source: 'provided'|'platform'|'local'; evidence: KnowledgeEvidence
}
export interface ReferenceJob {
  id: string; query: string; url: string; title: string; status: string; phase: string; percent: number
  error?: string; proposal_count?: number; completed_chunks?: number; total_chunks?: number
}
export interface KnowledgeDashboard { items: CharacterKnowledge[]; jobs: ReferenceJob[] }

export function referenceUrls(text: string): string[] {
  const values = text.split(/[\n,，]+/).map(value=>value.trim()).filter(Boolean)
  if(values.length>10) throw new Error('每次最多添加 10 条参考链接')
  return [...new Set(values.map(value=>{
    const url = new URL(value)
    if(url.protocol!=='https:' || !['www.bilibili.com','bilibili.com'].includes(url.hostname) ||
      url.username || url.password || url.port || !/^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/.test(url.pathname)) {
      throw new Error('请使用 B站视频完整链接（https://www.bilibili.com/video/BV…）')
    }
    const page=url.searchParams.get('p')||'1'
    if(!/^\d+$/.test(page)||Number(page)<1||Number(page)>10000) throw new Error('视频分P参数无效')
    return `https://www.bilibili.com${url.pathname.replace(/\/$/,'')}/${Number(page)===1?'':`?p=${Number(page)}`}`
  }))]
}

export function evidenceLink(item: Pick<CharacterKnowledge,'source_url'|'evidence'>) {
  if(!item.source_url) return undefined
  const url=new URL(item.source_url)
  url.searchParams.set('t',String(Math.floor(item.evidence.start_ms/1000)))
  return url.toString()
}

export function reviewPayload(item: CharacterKnowledge, status: CharacterKnowledge['status']) {
  return { revision:item.revision,status,title:item.title,explanation:item.explanation,
    triggers:item.triggers,context:item.context,caution:item.caution }
}
