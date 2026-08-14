import {
  classifyDomain,
  dedupeDomains,
  scoreDomain,
  type Classification,
  type DomainStatus,
  type Score,
} from '@rnr/core'
import { dnsTriage, type DnsTriageResult } from './dns-triage.js'
import { httpTriage, type HttpTriageResult } from './http-triage.js'
import { fetchRdapRecord, RDAP_RECORD_THROTTLE_MS, type RdapRecordResult } from './rdap-record.js'
import { fetchWaybackHistory, type WaybackHistory } from './wayback.js'

/**
 * Stages 2-5 for one locality's worth of businesses.
 *
 * ======================= WHY THE ORDER IS THE DESIGN =======================
 * Each stage is more expensive than the one before it, and each one can end the
 * enquiry. DNS is free and instant; HTTP is free but slow; RDAP is free but
 * rate-limited enough to need throttling; Majestic costs money per lookup.
 *
 * Running them in cost order is not a micro-optimisation — on a typical local
 * market most listings resolve to a LIVE business, and LIVE stops at stage 3c.
 * That is the difference between paying for backlink data on 12 domains and
 * paying for it on 200.
 * ==========================================================================
 */

export interface BusinessInput {
  name: string
  website: string | null
  /** Best organic position seen for this domain, when it came from SERP data. */
  serpRank?: number | null
}

export interface DomainCandidate {
  domain: string
  /**
   * Widened from `{name, website}` so the Google Business Profile fields
   * survive to persistence. They were being collected and dropped -- see the
   * comment on DomainOwner in @rnr/core normalize.ts.
   */
  businesses: Array<{
    name: string
    website: string | null
    placeId?: string | null
    cid?: string | null
    isClaimed?: boolean | null
    rating?: number | null
    reviewCount?: number | null
  }>
  businessCount: number
  dns: DnsTriageResult | null
  http: HttpTriageResult | null
  rdap: RdapRecordResult | null
  wayback: WaybackHistory | null
  majestic: MajesticMetrics | null
  classification: Classification
  score: Score
}

/** Stage 5a shape. Supplied by a caller that has a Majestic subscription. */
export interface MajesticMetrics {
  trustFlow: number | null
  citationFlow: number | null
  referringDomains: number | null
  referringSubnets: number | null
  topics: Array<{ name: string; percent: number }>
}

export interface EnrichPipelineOptions {
  /** Skip live-site detection and check every domain. Slower, rarely wanted. */
  includeLive?: boolean
  /** Max domains triaged at once. DNS/HTTP are IO-bound; RDAP is throttled anyway. */
  concurrency?: number
  /** Stage 5a, only called for non-LIVE domains. Omit when unconfigured. */
  fetchMajestic?: (domain: string) => Promise<MajesticMetrics | null>
  /** Stage 3e, only called when RDAP was inconclusive. Omit when unconfigured. */
  checkRegistrarAvailability?: (domain: string) => Promise<boolean | null>
  /** Niche terms used to judge Topical Trust Flow relevance. */
  nicheTerms?: string[]
  /** Progress callback, so a long run can report to a job row. */
  onProgress?: (done: number, total: number) => void
  now?: Date
}

export interface EnrichPipelineResult {
  candidates: DomainCandidate[]
  stats: {
    businesses: number
    uniqueDomains: number
    skippedPlatform: number
    skippedNoDomain: number
    byStatus: Record<DomainStatus, number>
    /** Domains that reached the paid stage — the number that maps to spend. */
    majesticLookups: number
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * How well a domain's Topical Trust Flow lines up with the niche.
 *
 * Majestic returns categories like "Business/Construction and Maintenance", so
 * a token overlap against the niche terms is the honest amount of precision
 * available here. Returns null rather than 0 when there is nothing to compare,
 * so the score can mark it missing instead of penalising the domain.
 */
export function topicalRelevance(
  topics: Array<{ name: string; percent: number }>,
  nicheTerms: string[],
): number | null {
  if (topics.length === 0 || nicheTerms.length === 0) return null
  const terms = nicheTerms
    .flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/))
    .filter((t) => t.length > 3)
  if (terms.length === 0) return null

  let matched = 0
  for (const topic of topics) {
    const name = topic.name.toLowerCase()
    if (terms.some((t) => name.includes(t))) matched += topic.percent
  }
  return matched
}

/** Run one domain through stages 3-5. Exported so a single row can be re-run. */
export async function triageDomain(
  domain: string,
  businesses: Array<{
    name: string
    website: string | null
    serpRank?: number | null
    placeId?: string | null
    cid?: string | null
    isClaimed?: boolean | null
    rating?: number | null
    reviewCount?: number | null
  }>,
  opts: EnrichPipelineOptions = {},
): Promise<DomainCandidate> {
  // Best rank any listing reported for this domain.
  const serpRank = businesses.reduce<number | null>((best, b) => {
    const r = b.serpRank
    if (r == null) return best
    return best == null || r < best ? r : best
  }, null)
  const dns = await dnsTriage(domain)

  // 3c still runs when DNS looks dead: a domain with no A record can still be
  // worth a probe, and the HTTP outcome is what separates parked from dead.
  const http = await httpTriage(domain)

  /**
   * ============ RDAP RUNS EVEN FOR APPARENTLY-LIVE SITES ============
   * This used to return here, before RDAP, whenever the page looked live --
   * which meant a domain whose seller page evaded the phrase list was dropped
   * without the registry ever being asked whether it was expired. That is a
   * FALSE NEGATIVE on precisely the domains this tool exists to find.
   *
   * RDAP is free and throttled, so the only cost of always asking is time, and
   * registry states (redemption, pendingDelete, unregistered) outrank anything
   * served over HTTP in classifyDomain.
   * ==================================================================
   */
  const rdapEarly = await fetchRdapRecord(domain)
  const looksLive = http.outcome === 'live'
  const registryDisagrees =
    rdapEarly.registered === false ||
    rdapEarly.statuses.some((x) => /redemption|pending delete/i.test(x))

  if (looksLive && !registryDisagrees && !opts.includeLive) {
    const classification = classifyDomain({
      dns,
      http,
      rdap: rdapEarly,
      serpRank,
      hasMx: dns.mxCount > 0,
      now: opts.now,
    })
    return {
      domain,
      businesses,
      businessCount: businesses.length,
      dns,
      http,
      rdap: rdapEarly,
      wayback: null,
      majestic: null,
      classification,
      score: scoreDomain({
        status: classification.status,
        ageYears: classification.ageYears,
        trustFlow: null,
        citationFlow: null,
        referringDomains: null,
        referringSubnets: null,
        topicalRelevancePct: null,
        yearsOfContent: null,
        businessCount: businesses.length,
      }),
    }
  }

  const rdap = rdapEarly

  let registrarAvailable: boolean | null = null
  if (rdap.registered === null && opts.checkRegistrarAvailability) {
    registrarAvailable = await opts.checkRegistrarAvailability(domain)
  }

  // Wayback runs BEFORE classification now: its last-content date is one of the
  // free signals that can settle an otherwise-unreadable domain.
  const [wayback, majestic] = await Promise.all([
    fetchWaybackHistory(domain),
    opts.fetchMajestic ? opts.fetchMajestic(domain) : Promise.resolve(null),
  ])

  const classification = classifyDomain({
    dns,
    http,
    rdap,
    registrarAvailable,
    serpRank,
    lastContentSnapshotAt: wayback.ok ? wayback.lastContentSnapshotAt : null,
    hasMx: dns.mxCount > 0,
    now: opts.now,
  })

  const score = scoreDomain({
    status: classification.status,
    ageYears: classification.ageYears,
    trustFlow: majestic?.trustFlow ?? null,
    citationFlow: majestic?.citationFlow ?? null,
    referringDomains: majestic?.referringDomains ?? null,
    referringSubnets: majestic?.referringSubnets ?? null,
    topicalRelevancePct: majestic
      ? topicalRelevance(majestic.topics, opts.nicheTerms ?? [])
      : null,
    yearsOfContent: wayback.ok ? wayback.yearsOfContinuousContent : null,
    businessCount: businesses.length,
    conclusiveTriage: classification.conclusive,
  })

  return {
    domain,
    businesses,
    businessCount: businesses.length,
    dns,
    http,
    rdap,
    wayback,
    majestic,
    classification,
    score,
  }
}

const EMPTY_STATUS_COUNTS = (): Record<DomainStatus, number> => ({
  AVAILABLE: 0,
  PENDING_DELETE: 0,
  REDEMPTION: 0,
  EXPIRING_SOON: 0,
  PARKED_DEAD: 0,
  ACQUIRED_301: 0,
  LIVE: 0,
  BROKEN: 0,
  UNKNOWN: 0,
})

/**
 * Stage 2 through Stage 5 for a whole market.
 *
 * Concurrency is bounded and RDAP is throttled between domains: these are free,
 * unauthenticated public services, and the cost of hammering them is a 429,
 * which correctly yields "unknown" rather than a wrong answer — so impatience
 * buys nothing and loses coverage.
 */
export async function enrichDomains(
  businesses: BusinessInput[],
  opts: EnrichPipelineOptions = {},
): Promise<EnrichPipelineResult> {
  const { domains, skippedPlatform, skippedNoDomain } = dedupeDomains(businesses)
  const concurrency = Math.max(1, opts.concurrency ?? 6)

  const candidates: DomainCandidate[] = []
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const entry = domains[index]
      if (!entry) return

      try {
        candidates.push(await triageDomain(entry.domain, entry.businesses, opts))
      } catch {
        // One unreachable domain must not abort a 200-domain market. The row is
        // dropped rather than guessed at, and the count difference is visible
        // in stats.uniqueDomains vs candidates.length.
      }
      done += 1
      opts.onProgress?.(done, domains.length)
      await sleep(RDAP_RECORD_THROTTLE_MS)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker))

  const byStatus = EMPTY_STATUS_COUNTS()
  for (const c of candidates) byStatus[c.classification.status] += 1

  candidates.sort((a, b) => b.score.total - a.score.total || a.domain.localeCompare(b.domain))

  return {
    candidates,
    stats: {
      businesses: businesses.length,
      uniqueDomains: domains.length,
      skippedPlatform,
      skippedNoDomain,
      byStatus,
      majesticLookups: candidates.filter((c) => c.majestic !== null).length,
    },
  }
}
