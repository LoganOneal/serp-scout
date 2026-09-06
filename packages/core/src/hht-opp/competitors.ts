import { HHT_SITE_DOMAIN } from './types.js'
import { excludeDiscoveryDomain } from './discovery.js'
import { registrableDomain } from '../domains/normalize.js'

/** Editable defaults. Romantic / in-room hot-tub hotel directories, not OTAs. */
export const DEFAULT_HHT_OPP_COMPETITORS = [
  'tubhotels.com',
  'jacuzzisuites.com',
  'romantichotels.com',
] as const

export interface ReferringDomainHit {
  domain: string
  authorityScore: number | null
  backlinks: number | null
}

export interface CompetitorOverlap {
  domain: string
  competitorCount: number
  competitors: string[]
  alreadyLinksToHht: boolean
}

export function normalizeCompetitorList(raw: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const domain = registrableDomain(value)?.domain
    if (!domain || domain === HHT_SITE_DOMAIN || seen.has(domain)) continue
    if (excludeDiscoveryDomain(domain).excluded) continue
    seen.add(domain)
    out.push(domain)
  }
  return out
}

/**
 * Referring domains that link to at least `minOverlap` competitors and not HHT.
 * Prioritize competitor_link_count >= 2.
 */
export function intersectReferringDomains(
  byCompetitor: Record<string, ReferringDomainHit[]>,
  hhtReferring: Iterable<string>,
  minOverlap = 2,
): CompetitorOverlap[] {
  const hht = new Set([...hhtReferring].map((value) => value.toLowerCase()))
  const seen = new Map<string, Set<string>>()
  for (const [competitor, hits] of Object.entries(byCompetitor)) {
    const root = registrableDomain(competitor)?.domain ?? competitor.toLowerCase()
    for (const hit of hits) {
      const domain = registrableDomain(hit.domain)?.domain
      if (!domain || domain === HHT_SITE_DOMAIN || domain === root) continue
      if (excludeDiscoveryDomain(domain).excluded) continue
      const list = seen.get(domain) ?? new Set<string>()
      list.add(root)
      seen.set(domain, list)
    }
  }

  return [...seen.entries()]
    .map(([domain, competitors]) => ({
      domain,
      competitorCount: competitors.size,
      competitors: [...competitors].sort(),
      alreadyLinksToHht: hht.has(domain),
    }))
    .filter((row) => row.competitorCount >= minOverlap && !row.alreadyLinksToHht)
    .sort((a, b) => b.competitorCount - a.competitorCount || a.domain.localeCompare(b.domain))
}

export function classifyCompetitorLinkReason(text: string): {
  opportunityHint: 'existing_article' | 'resource_page' | 'directory_listing' | 'editorial_guest' | 'sponsored_content' | 'data_pr' | 'other'
  why: string
} {
  const blob = text.toLowerCase()
  if (/write for us|guest contribut|submit (?:an? )?(?:article|story)/i.test(blob)) {
    return { opportunityHint: 'editorial_guest', why: 'Competitor was cited from a publication that also invites contributors.' }
  }
  if (/sponsored|advertorial|branded content/i.test(blob)) {
    return { opportunityHint: 'sponsored_content', why: 'The linking page uses paid-placement language.' }
  }
  if (/directory|submit your (?:listing|website)|add your (?:hotel|business)/i.test(blob)) {
    return { opportunityHint: 'directory_listing', why: 'The linker looks like a directory or listing page.' }
  }
  if (/resources?|useful (?:links|websites)|recommended (?:tools|sites)/i.test(blob)) {
    return { opportunityHint: 'resource_page', why: 'The linker is a curated resource list.' }
  }
  if (/study|original research|according to (?:data|research)/i.test(blob)) {
    return { opportunityHint: 'data_pr', why: 'The linker cites research or data.' }
  }
  if (/best (?:romantic )?hotels|jacuzzi|hot tub|honeymoon/i.test(blob)) {
    return { opportunityHint: 'existing_article', why: 'The linker is a hotel listicle or amenity roundup.' }
  }
  return { opportunityHint: 'other', why: 'Domain links to multiple competitors; acquisition method needs a crawl.' }
}
