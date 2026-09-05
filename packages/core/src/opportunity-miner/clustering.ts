import { clusterKey, extractConcepts } from './concepts.js'
import { areSemanticDuplicates, jaccard, tokenize } from './normalize.js'

export interface ClusterableKeyword {
  id: number
  keyword: string
  volume: number | null
  domains: string[]
}

export interface KeywordCluster {
  key: string
  keywordIds: number[]
  nameHint: string
}

/**
 * Cluster keywords into markets.
 *
 * Avoids the "contractor software" mega-cluster: CRM, payroll, estimating and
 * scheduling stay separate unless they share a specific workflow token.
 *
 * Membership requires a shared cluster key (vertical + job) OR (high lexical
 * overlap AND shared product object). Shared SERP domains can join a keyword
 * to an existing cluster but cannot create a broad vertical bucket alone.
 */
export function clusterKeywords(keywords: ClusterableKeyword[]): KeywordCluster[] {
  const items = keywords.map((k) => {
    const concept = extractConcepts(k.keyword)
    return { ...k, concept, key: clusterKey(concept), tokens: tokenize(k.keyword) }
  })

  const byKey = new Map<string, typeof items>()
  const unkeyed: typeof items = []
  for (const item of items) {
    if (item.key) {
      const arr = byKey.get(item.key) ?? []
      arr.push(item)
      byKey.set(item.key, arr)
    } else {
      unkeyed.push(item)
    }
  }

  const clusters: KeywordCluster[] = []
  for (const [key, members] of byKey) {
    const groups = splitDivergentWorkflows(members)
    for (const group of groups) {
      clusters.push({
        key: groups.length === 1 ? key : `${key}::${group[0]!.concept.workflow ?? group[0]!.id}`,
        keywordIds: group.map((m) => m.id),
        nameHint: nameHint(group),
      })
    }
  }

  for (const item of unkeyed) {
    let best: { index: number; score: number } | null = null
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]!
      const sample = items.filter((m) => cluster.keywordIds.includes(m.id)).slice(0, 8)
      const lexical = average(sample.map((s) => jaccard(item.tokens, s.tokens)))
      const domainOverlap = sharedDomainRatio(item.domains, sample.flatMap((s) => s.domains))
      const sameObject =
        item.concept.object && sample.some((s) => s.concept.object === item.concept.object)
      const score = lexical + (sameObject ? 0.2 : 0) + domainOverlap * 0.25
      if (lexical >= 0.55 && (sameObject || domainOverlap >= 0.25) && score > (best?.score ?? 0)) {
        best = { index: i, score }
      }
    }
    if (best) {
      clusters[best.index]!.keywordIds.push(item.id)
    } else {
      clusters.push({
        key: `singleton:${item.id}`,
        keywordIds: [item.id],
        nameHint: nameHint([item]),
      })
    }
  }

  return mergeNearDuplicateClusters(clusters, items)
}

function splitDivergentWorkflows<T extends { concept: ReturnType<typeof extractConcepts> }>(
  members: T[],
): T[][] {
  const byWorkflow = new Map<string, T[]>()
  for (const m of members) {
    const w = m.concept.workflow ?? m.concept.object ?? 'general'
    const arr = byWorkflow.get(w) ?? []
    arr.push(m)
    byWorkflow.set(w, arr)
  }
  if (byWorkflow.size <= 1) return [members]
  const jobs = [...byWorkflow.keys()]
  const compatible = jobs.every((a) => jobs.every((b) => workflowsCompatible(a, b)))
  return compatible ? [members] : [...byWorkflow.values()]
}

/** Estimating and proposal are one product wedge; CRM and payroll are not. */
export function workflowsCompatible(a: string, b: string): boolean {
  if (a === b) return true
  const pair = [a, b].sort().join('|')
  return COMPATIBLE.has(pair)
}

const COMPATIBLE = new Set([
  'estimating|proposal generation',
  'estimating|quoting',
  'proposal generation|quoting',
  'invoicing|quoting',
  'interior design|room design',
])

function nameHint(members: Array<{ keyword: string; concept: ReturnType<typeof extractConcepts> }>): string {
  const first = members[0]?.concept
  if (!first) return members[0]?.keyword ?? 'Market'
  const vertical = title(first.industry ?? first.persona ?? '')
  const jobRaw = first.workflow ?? first.object ?? first.productArchetype ?? members[0]!.keyword
  const job = title(jobRaw)
  if (vertical && job && !job.toLowerCase().includes(vertical.toLowerCase())) {
    return `${vertical} ${job}`.replace(/\s+/g, ' ').trim()
  }
  if (vertical && first.productArchetype) return `${vertical} ${title(first.productArchetype)}`
  return title(members.sort((a, b) => (b.keyword.length - a.keyword.length))[0]!.keyword)
}

function title(s: string): string {
  return s
    .split(/[\s:_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function sharedDomainRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sb = new Set(b)
  let n = 0
  for (const d of new Set(a)) if (sb.has(d)) n += 1
  return n / Math.max(new Set(a).size, 1)
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function mergeNearDuplicateClusters(
  clusters: KeywordCluster[],
  items: Array<{ id: number; keyword: string }>,
): KeywordCluster[] {
  const byId = new Map(items.map((i) => [i.id, i.keyword]))
  const out: KeywordCluster[] = []
  for (const cluster of clusters) {
    const existing = out.find((o) => {
      const a = cluster.keywordIds.map((id) => byId.get(id) ?? '')
      const b = o.keywordIds.map((id) => byId.get(id) ?? '')
      return a.some((x) => b.some((y) => areSemanticDuplicates(x, y))) && cluster.key.split('::')[0] === o.key.split('::')[0]
    })
    if (existing) {
      existing.keywordIds.push(...cluster.keywordIds.filter((id) => !existing.keywordIds.includes(id)))
    } else {
      out.push({ ...cluster, keywordIds: [...cluster.keywordIds] })
    }
  }
  return out
}

/**
 * Adjusted cluster volume.
 *
 * Assumptions (MVP, conservative):
 * 1. Exact-normalized duplicates count once (max volume).
 * 2. Semantic near-duplicates (token-sort / Jaccard ≥ 0.85) count as one group;
 *    the group contributes the max volume, not the sum.
 * 3. Remaining groups still overlap in SERPs. Apply
 *    overlap = min(0.35, 0.06 * ln(1 + groupCount)).
 *    adjusted = sum(group maxima) * (1 - overlap).
 *
 * This will under-count more often than over-count. That is intentional.
 */
export function adjustedClusterVolume(volumes: Array<{ keyword: string; volume: number | null }>): {
  raw: number
  adjusted: number
  groupCount: number
  overlapFactor: number
} {
  const usable = volumes.filter((v): v is { keyword: string; volume: number } => v.volume != null && v.volume > 0)
  const raw = usable.reduce((a, v) => a + v.volume, 0)
  const groups: Array<{ keyword: string; volume: number }> = []
  for (const row of usable) {
    const hit = groups.find((g) => areSemanticDuplicates(g.keyword, row.keyword))
    if (hit) hit.volume = Math.max(hit.volume, row.volume)
    else groups.push({ ...row })
  }
  const grouped = groups.reduce((a, g) => a + g.volume, 0)
  const overlapFactor = Math.min(0.35, 0.06 * Math.log(1 + groups.length))
  return {
    raw,
    adjusted: Math.round(grouped * (1 - overlapFactor)),
    groupCount: groups.length,
    overlapFactor,
  }
}
