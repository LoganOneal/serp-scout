/**
 * Phase 2 discovery helpers. Pure: no network, no spend.
 *
 * Live search is attached in @rnr/data. This file decides which queries fire,
 * which SERP hits are worth a crawl, and how to collapse near-duplicate
 * opportunities on the same domain.
 */

import { looksLikeOpportunityPath } from './classify.js'
import {
  expandQueryTemplates,
  HHT_OPP_DISCOVERY_STRATEGY_ORDER,
  HHT_OPP_TOPICS,
  type HhtOppSearchStrategy,
  type QueryTemplate,
} from './queries.js'
import type { SearchHit, SearchProvider } from './search.js'
import { HHT_OPP_TYPES, HHT_SITE_DOMAIN, type HhtOppType } from './types.js'
import { registrableDomain } from '../domains/normalize.js'
import { isExcludedProspect } from '../links/exclusions.js'

export const HHT_OPP_DISCOVERY_DEFAULTS = {
  queryLimit: 4,
  domainLimit: 6,
  hitsPerQuery: 10,
  maxQueryLimit: 12,
  maxDomainLimit: 12,
} as const

/**
 * One row per type is enough for contribution / advertising pages. Article-level
 * types keep distinct URLs because each page is a different placement.
 */
export const HHT_OPP_SINGLETON_TYPES: ReadonlySet<HhtOppType> = new Set([
  'editorial_guest',
  'paid_guest_post',
  'paid_link_insertion',
  'sponsored_content',
  'hotel_tourism_partnership',
  'data_pr',
  'expert_source',
  'other',
])

/** Travel SERP leftovers that are not guest-post or partnership targets. */
const EXTRA_DISCOVERY_EXCLUSIONS: ReadonlySet<string> = new Set([
  'google.com',
  'apple.com',
  'yelp.com',
  'angi.com',
  'thumbtack.com',
  'bbb.org',
  'yellowpages.com',
  'homeadvisor.com',
  'nextdoor.com',
  'mapquest.com',
  'kayak.com',
  'trivago.com',
  'priceline.com',
  'orbitz.com',
  'hotwire.com',
  'travelocity.com',
  'hopper.com',
  'hotels.com',
])

export function clampDiscoveryLimit(value: number | undefined, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

export function excludeDiscoveryDomain(domainOrUrl: string): { excluded: boolean; reason: string | null } {
  const root = registrableDomain(domainOrUrl)?.domain
  if (!root) return { excluded: true, reason: 'unresolvable domain' }
  if (root === HHT_SITE_DOMAIN) return { excluded: true, reason: 'HotelHotTubs.com itself' }
  const prospect = isExcludedProspect(root, { ownDomains: [HHT_SITE_DOMAIN] })
  if (prospect.excluded) return prospect
  for (const host of EXTRA_DISCOVERY_EXCLUSIONS) {
    if (root === host || root.endsWith(`.${host}`)) {
      return { excluded: true, reason: `not an outreach target (${host})` }
    }
  }
  return { excluded: false, reason: null }
}

export function selectDiscoveryBatch(
  opts: {
    limit?: number
    strategies?: HhtOppSearchStrategy[]
    excludeQueries?: Iterable<string>
  } = {},
): QueryTemplate[] {
  const limit = clampDiscoveryLimit(
    opts.limit,
    HHT_OPP_DISCOVERY_DEFAULTS.queryLimit,
    HHT_OPP_DISCOVERY_DEFAULTS.maxQueryLimit,
  )
  const allowed = new Set(
    opts.strategies?.length ? opts.strategies : HHT_OPP_DISCOVERY_STRATEGY_ORDER,
  )
  const exclude = new Set([...(opts.excludeQueries ?? [])].map((query) => query.toLowerCase()))
  const all = expandQueryTemplates().filter(
    (row) => allowed.has(row.strategy) && !exclude.has(row.query.toLowerCase()),
  )

  const buckets = new Map<HhtOppSearchStrategy, QueryTemplate[]>()
  for (const row of all) {
    const list = buckets.get(row.strategy) ?? []
    list.push(row)
    buckets.set(row.strategy, list)
  }

  const order = HHT_OPP_DISCOVERY_STRATEGY_ORDER.filter((strategy) => buckets.has(strategy))
  const cursor = new Map<HhtOppSearchStrategy, number>()
  const picked: QueryTemplate[] = []
  const usedFamily = new Set<string>()

  while (picked.length < limit) {
    let added = false
    for (const strategy of order) {
      if (picked.length >= limit) break
      const bucket = buckets.get(strategy) ?? []
      let index = cursor.get(strategy) ?? 0
      while (index < bucket.length) {
        const candidate = bucket[index]!
        index += 1
        cursor.set(strategy, index)
        const familyKey = `${strategy}:${candidate.family}`
        if (usedFamily.has(familyKey) && bucket.some((row, i) => i >= index && !usedFamily.has(`${strategy}:${row.family}`))) {
          continue
        }
        usedFamily.add(familyKey)
        picked.push(candidate)
        added = true
        break
      }
    }
    if (!added) break
  }

  return picked
}

export function creativeQueriesFromYield(
  rows: Array<{ query: string; pass: number }>,
  limit = 2,
): QueryTemplate[] {
  const extras: QueryTemplate[] = []
  const seen = new Set<string>()
  const successful = rows.filter((row) => row.pass > 0)
  for (const row of successful) {
    if (extras.length >= limit) break
    if (!/write for us|guest post|advertise|media kit|contributor/i.test(row.query)) continue
    for (const topic of HHT_OPP_TOPICS) {
      if (extras.length >= limit) break
      if (row.query.toLowerCase().includes(topic)) continue
      const query = `"${topic}" "write for us"`
      if (seen.has(query.toLowerCase())) continue
      seen.add(query.toLowerCase())
      extras.push({
        query,
        strategy: 'creative_query',
        family: 'from_successful_phrase',
      })
    }
  }
  return extras
}

export function hitRootDomain(hit: SearchHit): string | null {
  return registrableDomain(hit.domain ?? hit.url)?.domain ?? null
}

export function preferOpportunityUrl(a: string, b: string, seedUrl?: string): string {
  const aOpp = looksLikeOpportunityPath(a)
  const bOpp = looksLikeOpportunityPath(b)
  if (aOpp !== bOpp) return aOpp ? a : b
  if (seedUrl) {
    const aSeed = a === seedUrl
    const bSeed = b === seedUrl
    if (aSeed !== bSeed) return aSeed ? a : b
  }
  return a.length <= b.length ? a : b
}

export function dedupeHitsByDomain(hits: SearchHit[]): SearchHit[] {
  const best = new Map<string, SearchHit>()
  for (const hit of hits) {
    const root = hitRootDomain(hit)
    if (!root) continue
    const prev = best.get(root)
    if (!prev) {
      best.set(root, { ...hit, domain: root })
      continue
    }
    const winnerUrl = preferOpportunityUrl(hit.url, prev.url)
    if (winnerUrl === hit.url) best.set(root, { ...hit, domain: root })
  }
  return [...best.values()]
}

export interface PlannedDiscoveryTarget {
  domain: string
  seedUrl: string
  title: string | null
  snippet: string | null
  existing: boolean
}

export function planDiscoveryTargets(
  hits: SearchHit[],
  existingDomains: Iterable<string>,
  domainLimit: number,
): {
  excluded: Array<{ url: string; domain: string | null; reason: string }>
  uniqueDomains: number
  newDomains: number
  existingDomains: number
  toResearch: PlannedDiscoveryTarget[]
  skippedExisting: PlannedDiscoveryTarget[]
  deferredNew: PlannedDiscoveryTarget[]
} {
  const existing = new Set([...existingDomains].map((value) => value.toLowerCase()))
  const excluded: Array<{ url: string; domain: string | null; reason: string }> = []
  const unique: PlannedDiscoveryTarget[] = []
  const seen = new Set<string>()

  for (const hit of dedupeHitsByDomain(hits)) {
    const verdict = excludeDiscoveryDomain(hit.domain ?? hit.url)
    const root = hitRootDomain(hit)
    if (verdict.excluded || !root) {
      excluded.push({ url: hit.url, domain: root, reason: verdict.reason ?? 'excluded' })
      continue
    }
    if (seen.has(root)) continue
    seen.add(root)
    unique.push({
      domain: root,
      seedUrl: hit.url,
      title: hit.title,
      snippet: hit.snippet,
      existing: existing.has(root),
    })
  }

  const newTargets = unique.filter((row) => !row.existing)
  const skippedExisting = unique.filter((row) => row.existing)
  return {
    excluded,
    uniqueDomains: unique.length,
    newDomains: newTargets.length,
    existingDomains: skippedExisting.length,
    toResearch: newTargets.slice(0, domainLimit),
    skippedExisting,
    deferredNew: newTargets.slice(domainLimit),
  }
}

export function collapseClassifiedOpportunities<T extends { type: HhtOppType; url: string }>(
  items: T[],
  opts: { seedUrl?: string } = {},
): T[] {
  const kept: T[] = []
  const singleton = new Map<HhtOppType, T>()
  for (const item of items) {
    if (!HHT_OPP_TYPES.includes(item.type) || !HHT_OPP_SINGLETON_TYPES.has(item.type)) {
      kept.push(item)
      continue
    }
    const prev = singleton.get(item.type)
    if (!prev) {
      singleton.set(item.type, item)
      continue
    }
    const winnerUrl = preferOpportunityUrl(item.url, prev.url, opts.seedUrl)
    if (winnerUrl === item.url) singleton.set(item.type, item)
  }
  return [...kept, ...singleton.values()]
}

/** Labeled offline catalog. Real publisher URLs, not invented SERP ranks. */
export const HHT_OPP_FIXTURE_CATALOG: Array<{ needles: string[]; hits: SearchHit[] }> = [
  {
    needles: ['write for us', 'guest post', 'contributors', 'submit article', 'pitch us', 'editorial submissions'],
    hits: [
      {
        url: 'https://expertvagabond.com/write-for-us/',
        title: 'Write For Us',
        snippet: 'Contribute a travel story.',
        domain: 'expertvagabond.com',
      },
      {
        url: 'https://www.afar.com/',
        title: 'AFAR',
        snippet: 'Travel magazine homepage.',
        domain: 'afar.com',
      },
    ],
  },
  {
    needles: ['advertise', 'sponsored', 'media kit', 'guest post price', 'branded content'],
    hits: [
      {
        url: 'https://www.afar.com/',
        title: 'AFAR',
        snippet: 'Travel magazine homepage.',
        domain: 'afar.com',
      },
    ],
  },
  {
    needles: ['hotels with jacuzzi', 'romantic hotels', 'honeymoon hotels', 'jacuzzi suites'],
    hits: [
      {
        url: 'https://www.afar.com/',
        title: 'AFAR',
        snippet: 'Travel magazine ranking page stand-in.',
        domain: 'afar.com',
      },
    ],
  },
  {
    needles: ['travel blog directories', 'luxury travel blog', 'honeymoon blogs', 'travel magazines'],
    hits: [
      {
        url: 'https://expertvagabond.com/write-for-us/',
        title: 'Expert Vagabond',
        snippet: 'Independent travel blog.',
        domain: 'expertvagabond.com',
      },
    ],
  },
  {
    needles: ['hotelhottubs', 'hotel hot tubs'],
    hits: [
      {
        url: 'https://www.afar.com/',
        title: 'AFAR',
        snippet: 'Fixture mention hit — crawl decides whether a link exists.',
        domain: 'afar.com',
      },
    ],
  },
]

export function fixtureHitsForQuery(query: string, limit = HHT_OPP_DISCOVERY_DEFAULTS.hitsPerQuery): SearchHit[] {
  const lower = query.toLowerCase()
  const matched: SearchHit[] = []
  const seen = new Set<string>()
  for (const group of HHT_OPP_FIXTURE_CATALOG) {
    if (!group.needles.some((needle) => lower.includes(needle))) continue
    for (const hit of group.hits) {
      const root = hitRootDomain(hit)
      if (!root || seen.has(root)) continue
      seen.add(root)
      matched.push(hit)
    }
  }
  return matched.slice(0, limit)
}

export class FixtureHhtOppSearchProvider implements SearchProvider {
  readonly id = 'hht-opp-fixture'
  readonly live = false

  async search(query: string, limit = HHT_OPP_DISCOVERY_DEFAULTS.hitsPerQuery): Promise<SearchHit[]> {
    return fixtureHitsForQuery(query, limit)
  }
  async searchSite(domain: string, query: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`site:${domain} ${query}`, limit)
  }
  async searchMentions(term: string, limit?: number): Promise<SearchHit[]> {
    return this.search(term, limit)
  }
  async searchRelated(): Promise<SearchHit[]> {
    return []
  }
}
