/**
 * Turn stored SERP rows into one lead per registrable domain for the
 * guest-post-pitches skill. SERP rows carry only url, domain and position,
 * so the junk filter here is URL/domain based. It is a cheap pre-filter,
 * not a judgment: the skill makes the real call.
 */

import { excludeDiscoveryDomain } from './discovery.js'
import { registrableDomain } from '../domains/normalize.js'
import type { LeadRow, LeadType } from './lead-csv.js'

export interface SerpHit {
  url: string
  domain: string
  position: number
  keywordId: number
  keyword: string
  bucket: string | null
  leadType: LeadType
}

const FOOTPRINT_PATH =
  /\/(?:[^/]*-)?(?:write-for-(?:us|me)|guest-?(?:post|blog|author|contributor)s?(?:-guidelines)?|contribut(?:e|or|ors|ing)(?:-guidelines)?|submissions?|submit(?:-[a-z-]+)?|pitch(?:-us)?|become-a-(?:contributor|writer)|writers?-wanted|work-with-us)(?:[/.?#-]|$)/i

/** Pages that list other sites' write-for-us pages. Useless as a lead. */
const LISTICLE_PATH =
  /(?:guest-?post(?:ing)?-sites|guest-blogging-sites|sites-(?:that-)?accept|blogs?-(?:that-)?accept|accepting-guest-posts|write-for-us-(?:sites|blogs|list)|list-of-[a-z-]*(?:blogs|sites)|\d+-[a-z-]*(?:blogs|sites)-[a-z-]*(?:guest|write|accept))/i

const SELLER_PATH =
  /(?:buy-guest-posts?|guest-post(?:ing)?-(?:services?|packages?|pricing|outreach)|sponsored-post-(?:packages?|pricing)|link-building|backlink-(?:services?|packages?)|seo-services?|niche-edits?)/i

const SELLER_DOMAIN = /(?:seo|backlink|linkbuild|guestpost|guest-post|outreach|rankwise|linkpitch)/i

const NON_ENGLISH_TLD = new Set([
  'de', 'fr', 'es', 'it', 'nl', 'pt', 'br', 'ru', 'pl', 'se', 'no', 'dk', 'fi', 'cz', 'sk', 'hu', 'ro',
  'gr', 'tr', 'jp', 'cn', 'kr', 'tw', 'vn', 'th', 'id', 'mx', 'ar', 'cl', 'co', 'pe', 'ua', 'il', 'at', 'ch', 'be',
])

const OFFSHORE_SEO_TLD = new Set(['in', 'pk', 'bd', 'ng', 'ph', 'lk', 'np', 'ke'])

const NON_US_ENGLISH_TLD = new Set(['uk', 'ca', 'au', 'nz', 'ie', 'za', 'sg'])

function tld(root: string): string {
  return root.split('.').pop()?.toLowerCase() ?? ''
}

function path(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export function isFootprintUrl(url: string): boolean {
  return FOOTPRINT_PATH.test(path(url))
}

/** Why a single SERP hit is junk, or null. */
export function serpHitJunkReason(url: string, root: string): string | null {
  const excluded = excludeDiscoveryDomain(root)
  if (excluded.excluded) return excluded.reason ?? 'excluded domain'
  const p = path(url)
  if (SELLER_PATH.test(p)) return 'sells guest posts or SEO links'
  if (SELLER_DOMAIN.test(root.split('.')[0] ?? '')) return 'SEO or link-selling domain'
  if (LISTICLE_PATH.test(p)) return 'write-for-us listicle'
  const t = tld(root)
  if (NON_ENGLISH_TLD.has(t)) return `non-English ccTLD .${t}`
  if (OFFSHORE_SEO_TLD.has(t)) return `non-US audience .${t}`
  return null
}

export interface DomainLead extends LeadRow {
  keywordId: number | null
}

export interface BuildSerpLeadsResult {
  leads: DomainLead[]
  junk: Array<{ domain: string; reason: string }>
}

/**
 * Group hits by (lead type, registrable domain), drop junk, and score.
 * Score: rank (100 - best position), +40 when a footprint URL (write-for-us,
 * contribute…) ranked, +10 per extra query that surfaced the domain (max +30),
 * -15 for non-US English ccTLDs.
 */
export function buildSerpLeads(hits: readonly SerpHit[]): BuildSerpLeadsResult {
  const groups = new Map<string, { root: string; leadType: LeadType; hits: SerpHit[] }>()
  const junkByKey = new Map<string, string>()
  for (const hit of hits) {
    const root = registrableDomain(hit.domain || hit.url)?.domain
    if (!root) continue
    const key = `${hit.leadType}|${root}`
    const reason = serpHitJunkReason(hit.url, root)
    if (reason) {
      if (!junkByKey.has(key)) junkByKey.set(key, reason)
      continue
    }
    const group = groups.get(key) ?? { root, leadType: hit.leadType, hits: [] }
    group.hits.push(hit)
    groups.set(key, group)
  }

  const leads: DomainLead[] = []
  for (const [key, group] of groups) {
    junkByKey.delete(key)
    const ranked = [...group.hits].sort((a, b) => {
      const fa = isFootprintUrl(a.url) ? 0 : 1
      const fb = isFootprintUrl(b.url) ? 0 : 1
      return fa - fb || a.position - b.position
    })
    const best = ranked[0]
    if (!best) continue
    const bestPosition = Math.min(...group.hits.map((h) => h.position))
    const queryHits = new Set(group.hits.map((h) => h.keywordId)).size
    const footprint = group.hits.some((h) => isFootprintUrl(h.url))
    let score = 100 - Math.min(bestPosition, 100)
    if (footprint && group.leadType === 'guest_post') score += 40
    score += Math.min(30, 10 * (queryHits - 1))
    if (NON_US_ENGLISH_TLD.has(tld(group.root))) score -= 15
    leads.push({
      domain: group.root,
      opportunityUrl: best.url,
      allUrls: ranked.map((h) => h.url).slice(0, 6),
      sourceQuery: best.keyword,
      bucket: best.bucket,
      leadType: group.leadType,
      score,
      bestPosition,
      queryHits,
      batchId: '',
      keywordId: best.keywordId,
    })
  }
  const junk = [...junkByKey.entries()].map(([key, reason]) => ({ domain: key.split('|')[1] ?? key, reason }))
  return { leads, junk }
}
