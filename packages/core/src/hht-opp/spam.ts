import type { HhtOppQuality } from './types.js'

export interface SpamInput {
  title: string | null
  text: string
  avgExternalLinks: number | null
  uniqueExternalDomains: number | null
  organicTraffic: number | null
  authorityScore: number | null
  hasAuthor: boolean
  paidLinkLanguageCount: number
}

export interface SpamVerdict {
  quality: HhtOppQuality
  reasons: string[]
  penalty: number
}

const LINK_FARM = [
  /buy (?:cheap )?(?:dofollow )?seo links?/i,
  /guest post for sale/i,
  /permanent dofollow/i,
  /pbn\b/i,
]

const THIN_COMMERCIAL = [
  /best (?:casino|crypto|cbd|loan|insurance) /i,
  /make money (?:online|fast)/i,
]

export function classifySpam(input: SpamInput): SpamVerdict {
  const blob = `${input.title ?? ''}\n${input.text}`
  const reasons: string[] = []

  for (const pattern of LINK_FARM) {
    if (pattern.test(blob)) reasons.push(`Link-sale language: “${blob.match(pattern)?.[0]}”`)
  }
  if (input.paidLinkLanguageCount >= 6) reasons.push('Paid-link language appears across many crawled pages.')
  if ((input.avgExternalLinks ?? 0) >= 22) reasons.push(`Avg. external links/article is ${input.avgExternalLinks}.`)
  if ((input.uniqueExternalDomains ?? 0) >= 40) reasons.push('Sampled pages link out to a very large set of domains.')
  if (!input.hasAuthor) reasons.push('No visible author or editor byline in sampled pages.')
  if (input.organicTraffic === 0 && (input.authorityScore ?? 0) >= 40) {
    reasons.push('Claimed authority is high while measured organic traffic is zero.')
  }
  if (THIN_COMMERCIAL.filter((p) => p.test(blob)).length >= 2) {
    reasons.push('Titles target unrelated commercial keywords.')
  }

  if (reasons.some((r) => /link-sale|pbn/i.test(r)) || input.paidLinkLanguageCount >= 8) {
    return { quality: 'POSSIBLE_LINK_FARM', reasons, penalty: 0.35 }
  }
  if (reasons.length >= 2) return { quality: 'LOW_QUALITY', reasons, penalty: 0.55 }
  return { quality: 'OK', reasons, penalty: 1 }
}
