export interface BlockLists {
  jobs: string[]
  salesRepair: string[]
  parts: string[]
  brands: string[]
  adult: string[]
  outsideGeo: string[]
}

export const DEFAULT_BLOCK_LISTS: BlockLists = {
  jobs: ['jobs', 'hiring', 'salary', 'career'],
  salesRepair: ['for sale', 'repair', 'installation', 'installers', 'buy hot tub'],
  parts: ['parts', 'filter cartridge', 'replacement cover'],
  brands: ['hot spring spas', 'jacuzzi brand'],
  adult: ['xxx', 'porn', 'escort'],
  outsideGeo: ['uk', 'london', 'toronto', 'sydney'],
}

export type GateDecision = 'accept' | 'reject' | 'llm'

export function lexicalRejectReason(keyword: string, lists: BlockLists): string | null {
  const text = keyword.toLowerCase()
  const groups: Array<[string, string[]]> = [
    ['jobs', lists.jobs],
    ['sales_repair', lists.salesRepair],
    ['parts', lists.parts],
    ['brand', lists.brands],
    ['adult', lists.adult],
    ['outside_geo', lists.outsideGeo],
  ]
  for (const [reason, terms] of groups) {
    if (terms.some((term) => term && text.includes(term.toLowerCase()))) return reason
  }
  return null
}

/** Feature-hash embedding. Stable, local, and comparable with cosine similarity. */
export function hashEmbedding(text: string, dimensions = 256): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1)
  for (const token of tokens) {
    const hash = fnv(token)
    const index = hash % dimensions
    vector[index] = (vector[index] ?? 0) + (hash % 2 === 0 ? 1 : -1)
  }
  return vector
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

export function maxSimilarity(keyword: string, references: string[]): number {
  const vector = hashEmbedding(keyword)
  let best = 0
  for (const reference of references) {
    best = Math.max(best, cosine(vector, hashEmbedding(reference)))
  }
  return best
}

export function relevanceGate(input: {
  keyword: string
  lists: BlockLists
  references: string[]
  volumeHigh: number | null
  enforceMinVolume: boolean
  low: number
  high: number
}): { decision: GateDecision; reason: string; similarity: number } {
  const blocked = lexicalRejectReason(input.keyword, input.lists)
  if (blocked) return { decision: 'reject', reason: blocked, similarity: 0 }
  if (input.enforceMinVolume && (input.volumeHigh ?? 0) <= 0) {
    return { decision: 'reject', reason: 'zero_volume', similarity: 0 }
  }
  const similarity = maxSimilarity(input.keyword, input.references)
  if (similarity >= input.high) return { decision: 'accept', reason: 'embedding', similarity }
  if (similarity < input.low) return { decision: 'reject', reason: 'embedding', similarity }
  return { decision: 'llm', reason: 'borderline', similarity }
}

function fnv(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
