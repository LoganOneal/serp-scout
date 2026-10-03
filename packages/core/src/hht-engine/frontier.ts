import { normalizeFrontierKeyword } from './keywords.js'
import { lexicalRejectReason, type BlockLists } from './relevance.js'
import { geographicKeywords } from './render.js'

/** Share of SERP URLs in common above which a neighborhood is treated as used up. */
export const SERP_OVERLAP_SATURATED = 0.5

const LODGING =
  /\b(hotel|hotels|inn|inns|resort|resorts|suite|suites|getaway|getaways|romantic|romance|couples|couple|honeymoon|weekend|lodging|stay|stays|bnb|bed and breakfast)\b/i
const PRODUCT =
  /\b(for sale|repair|repairs|installation|installers?|parts|chemicals?|covers?|pumps?|heaters?|price|prices|cost|buy|filter cartridge|replacement)\b/i

export type FrontierSource = 'geo_template' | 'serp_title' | 'related_term'
export type Neighborhood = 'saturated' | 'productive' | 'neutral'

export interface FrontierCandidate {
  keyword: string
  sourceType: FrontierSource
  city: string | null
  state: string | null
}

export function keywordOnTopic(keyword: string, lists: BlockLists): { ok: boolean; reason: string } {
  const blocked = lexicalRejectReason(keyword, lists)
  if (blocked) return { ok: false, reason: blocked }
  if (PRODUCT.test(keyword)) return { ok: false, reason: 'product_drift' }
  if (!LODGING.test(keyword)) return { ok: false, reason: 'off_topic' }
  return { ok: true, reason: 'on_topic' }
}

/** |A ∩ B| / |A ∪ B|. Empty sets do not count as a match. */
export function serpJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const left = new Set(a)
  const right = new Set(b)
  let hits = 0
  for (const item of left) if (right.has(item)) hits += 1
  const union = new Set([...left, ...right]).size
  return union === 0 ? 0 : hits / union
}

export function neighborhoodLabel(
  overlap: number,
  pitchableDomains: number,
  overlapThreshold = SERP_OVERLAP_SATURATED,
): Neighborhood {
  if (overlap >= overlapThreshold) return 'saturated'
  if (pitchableDomains >= 1) return 'productive'
  return 'neutral'
}

export function frontierCandidates(input: {
  keyword: string
  templates: string[]
  cities: Array<{ city: string; state: string | null }>
  titles: string[]
  urls: string[]
  lists: BlockLists
  limit?: number
}): FrontierCandidate[] {
  const limit = input.limit ?? 16
  const seen = new Set<string>([normalizeFrontierKeyword(input.keyword)].filter(Boolean))
  const out: FrontierCandidate[] = []
  const push = (candidate: FrontierCandidate) => {
    if (out.length >= limit) return
    const keyword = candidate.keyword.replace(/\s+/g, ' ').trim()
    const normalized = normalizeFrontierKeyword(keyword)
    if (!normalized || seen.has(normalized)) return
    if (!keywordOnTopic(keyword, input.lists).ok) return
    seen.add(normalized)
    out.push({ ...candidate, keyword })
  }

  const blob = [
    input.keyword,
    ...input.titles,
    ...input.urls.map((url) => phraseFromUrl(url) ?? ''),
  ].join('\n')
  for (const city of citiesMentioned(blob, input.cities)) {
    for (const phrase of geographicKeywords(city.city, city.state ?? '', input.templates)) {
      push({ keyword: phrase, sourceType: 'geo_template', city: city.city, state: city.state })
    }
  }
  for (const title of input.titles) {
    const cleaned = cleanTitle(title)
    if (cleaned) push({ keyword: cleaned, sourceType: 'serp_title', city: null, state: null })
  }
  for (const url of input.urls) {
    const phrase = phraseFromUrl(url)
    if (phrase) push({ keyword: phrase, sourceType: 'serp_title', city: null, state: null })
  }
  for (const phrase of relatedTerms(input.keyword)) {
    push({ keyword: phrase, sourceType: 'related_term', city: null, state: null })
  }
  return out.slice(0, limit)
}

function citiesMentioned(
  text: string,
  cities: Array<{ city: string; state: string | null }>,
): Array<{ city: string; state: string | null }> {
  const found: Array<{ city: string; state: string | null }> = []
  const seen = new Set<string>()
  const ordered = [...cities].sort((a, b) => b.city.length - a.city.length)
  let remaining = text
  for (const city of ordered) {
    const name = city.city.trim()
    if (name.length < 3) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    const pattern = new RegExp(`(^|[^a-z])${escapeRegExp(key)}([^a-z]|$)`, 'i')
    if (!pattern.test(remaining)) continue
    seen.add(key)
    remaining = remaining.replace(new RegExp(escapeRegExp(key), 'ig'), ' ')
    found.push(city)
  }
  return found
}

function cleanTitle(title: string): string | null {
  const head = title.split(/[|–—-]/)[0]?.replace(/^\d+\s+/, '').replace(/\s+/g, ' ').trim() ?? ''
  const words = head.split(' ').filter(Boolean)
  if (words.length < 3 || words.length > 14) return null
  return head
}

function phraseFromUrl(url: string): string | null {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1)?.replace(/\.html?$/, '') ?? ''
    const words = slug.split('-').filter((word) => word.length > 1 && !/^\d+$/.test(word))
    if (words.length < 3) return null
    return words.join(' ')
  } catch {
    return null
  }
}

function relatedTerms(keyword: string): string[] {
  const lower = keyword.toLowerCase().replace(/\s+/g, ' ').trim()
  const out: string[] = []
  if (/\bhotels?\b/.test(lower) && !lower.includes('romantic')) out.push(`romantic ${lower}`)
  if (/\bhotels?\b/.test(lower) && !/\bcouples?\b/.test(lower)) {
    out.push(lower.replace(/\bhotels\b/, 'couples hotels').replace(/\bhotel\b/, 'couples hotel'))
  }
  if (/\bhot tubs?\b/.test(lower) && !lower.includes('jacuzzi')) {
    out.push(lower.replace(/\bhot tubs\b/, 'jacuzzi').replace(/\bhot tub\b/, 'jacuzzi'))
  }
  if (/\bjacuzzi\b/.test(lower) && !/\bhot tub/.test(lower)) out.push(lower.replace(/\bjacuzzi\b/, 'hot tub'))
  if (/\b(hotel|inn|getaway|resort)\b/.test(lower) && !lower.includes('weekend')) out.push(`weekend ${lower}`)
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
