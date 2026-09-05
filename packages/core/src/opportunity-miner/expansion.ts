import { extractConcepts, isProductShaped } from './concepts.js'
import { clamp, parseTrendSeries, scale01 } from './normalize.js'
import type { KeywordIntent } from './types.js'

export interface ExpansionSignals {
  keyword: string
  volume: number | null
  cpc: number | null
  intent: KeywordIntent
  hasAdvertisers: boolean
  growing: boolean | null
  semanticallyNovel: boolean
  depth: number
}

/**
 * Best-first priority. Higher = expand sooner.
 *
 * Not a business score. A discovery-queue score: "is this node likely to
 * reveal a monetizable adjacent market?"
 */
export function expansionPriorityScore(s: ExpansionSignals): number {
  if (shouldDeprioritize(s.keyword, s.intent)) return 0

  const volume = scale01(s.volume, 50, 20_000)
  const cpc = scale01(s.cpc, 0.4, 12)
  const product = isProductShaped(s.keyword) ? 1 : 0
  const ads = s.hasAdvertisers ? 1 : 0
  const commercial = s.intent === 'commercial' || s.intent === 'transactional' ? 1 : 0.4
  const novel = s.semanticallyNovel ? 1 : 0.2
  const growth = s.growing === true ? 1 : s.growing === false ? 0.3 : 0.5
  const depthPenalty = clamp(1 - s.depth * 0.18, 0.25, 1)

  const raw =
    0.22 * volume +
    0.18 * cpc +
    0.16 * product +
    0.14 * ads +
    0.12 * commercial +
    0.1 * novel +
    0.08 * growth

  return Math.round(raw * depthPenalty * 1000) / 10
}

export function shouldDeprioritize(keyword: string, intent: KeywordIntent): boolean {
  const n = keyword.toLowerCase()
  if (intent === 'navigational') return true
  if (GARBAGE_PATTERNS.some((re) => re.test(n))) return true
  const tokens = n.split(/\s+/).filter(Boolean)
  if (tokens.length <= 1 && !isProductShaped(n)) return true
  return false
}

const GARBAGE_PATTERNS = [
  /\b(celebrit|oscar|grammy|nfl|nba|mlb|election|trump|biden|taylor swift)\b/,
  /\b(crack|nulled|warez|torrent|pirat|serial key)\b/,
  /\b(porn|xxx|onlyfans)\b/,
  /\b(what is|meaning of|wikipedia|definition)\b/,
  /\b(lyrics|chord|netflix|hulu|spotify playlist)\b/,
]

export function trendIsGrowing(trend: string | null): boolean | null {
  const series = parseTrendSeries(trend)
  if (series.length < 4) return null
  const recent = series.slice(-3)
  const prior = series.slice(-6, -3)
  if (prior.length === 0) return null
  const r = recent.reduce((a, b) => a + b, 0) / recent.length
  const p = prior.reduce((a, b) => a + b, 0) / prior.length
  if (p <= 0) return r > 0
  return r / p - 1 >= 0.08
}

export function seedExpansionsFromConcept(concept: ReturnType<typeof extractConcepts>): string[] {
  const out = new Set<string>()
  const nouns = [concept.industry, concept.persona, concept.object, concept.workflow].filter(
    (x): x is string => Boolean(x),
  )
  for (const x of nouns) {
    out.add(`${x} software`)
    out.add(`${x} app`)
    out.add(`AI for ${x}`)
    out.add(`${x} AI`)
    out.add(`${x} automation`)
    out.add(`automate ${x}`)
    out.add(`${x} tracker`)
    out.add(`${x} planner`)
    out.add(`${x} calculator`)
  }
  if (concept.persona) {
    out.add(`software for ${concept.persona}`)
    out.add(`app for ${concept.persona}`)
    out.add(`tools for ${concept.persona}`)
  }
  if (concept.industry && concept.workflow) {
    out.add(`${concept.industry} ${concept.workflow} software`)
    out.add(`${concept.industry} ${concept.workflow} app`)
  }
  if (concept.industry && concept.object) {
    out.add(`${concept.industry} ${concept.object} software`)
  }
  return [...out]
}
