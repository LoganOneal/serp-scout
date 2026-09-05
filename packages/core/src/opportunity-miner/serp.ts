import {
  AFFILIATE_HINTS,
  COMMUNITY_DOMAINS,
  MAJOR_INCUMBENTS,
  type OmDomainClass,
} from './types.js'
import { hostFromDomain } from './normalize.js'

export function classifySearchDomain(domain: string): OmDomainClass {
  const host = hostFromDomain(domain)
  if (COMMUNITY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 'community'
  if (MAJOR_INCUMBENTS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return host.includes('google') || host.includes('microsoft') || host.includes('apple')
      ? 'major_platform'
      : 'major_incumbent'
  }
  if (AFFILIATE_HINTS.some((h) => host.includes(h))) return 'affiliate_content'
  if (/(g2\.com|capterra|getapp|softwareadvice|trustpilot)/.test(host)) return 'affiliate_content'
  if (/(shopify|etsy|amazon|ebay)/.test(host)) return 'marketplace'
  return 'unknown'
}

export interface SerpWeaknessInput {
  domains: Array<{
    domain: string
    position: number | null
    authorityScore: number | null
    classification: OmDomainClass
  }>
}

/**
 * 0–5. Higher = easier for a new entrant to win organic.
 * KD is intentionally not an input.
 */
export function serpWeaknessScore(input: SerpWeaknessInput): number {
  if (input.domains.length === 0) return 0
  const page1 = input.domains.filter((d) => (d.position ?? 99) <= 10)
  const rows = page1.length > 0 ? page1 : input.domains
  let score = 2.2
  const community = rows.filter((d) => d.classification === 'community').length
  const affiliate = rows.filter((d) => d.classification === 'affiliate_content').length
  const platforms = rows.filter((d) => d.classification === 'major_platform' || d.classification === 'major_incumbent').length
  const lowAuth = rows.filter((d) => d.authorityScore != null && d.authorityScore < 25).length
  const unknownSmall = rows.filter((d) => d.classification === 'unknown' || d.classification === 'small_niche').length

  score += Math.min(1.2, community * 0.45)
  score += Math.min(0.8, affiliate * 0.25)
  score += Math.min(0.8, lowAuth * 0.2)
  score += Math.min(0.6, unknownSmall * 0.12)
  score -= Math.min(2.2, platforms * 0.7)

  const unique = new Set(rows.map((d) => hostFromDomain(d.domain))).size
  if (unique >= 8) score += 0.4
  if (unique <= 3 && platforms > 0) score -= 0.5

  return Math.round(clamp(score, 0, 5) * 10) / 10
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function isMajorPlatformOwned(domains: Array<{ domain: string; position: number | null; classification: OmDomainClass }>): boolean {
  const top = domains.filter((d) => (d.position ?? 99) <= 5)
  if (top.length === 0) return false
  const owned = top.filter((d) => d.classification === 'major_platform').length
  return owned / top.length >= 0.6
}
