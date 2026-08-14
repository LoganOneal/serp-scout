import 'server-only'
import { PRICE, costMicros, type Micros } from '@rnr/core'
import type { DataForSeoClient } from '../providers/dataforseo/client.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
import { fetchBulkBacklinks } from '../providers/dataforseo/backlinks.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'

/**
 * The optional, PAID checks that separate an asset from a liability.
 *
 * ==================== WHY THESE ARE NOT ON BY DEFAULT ====================
 * Discovery and triage are free -- DNS, HTTP, RDAP and Wayback cost nothing --
 * which is why the seed can be widened without limit. These two are the
 * opposite: they are billed per domain, so they are a per-run decision the
 * operator makes with the price in front of them.
 *
 * Measured by balance delta, not a rate card:
 *   bulk backlinks (spam + rank + refdomains)  $0.024/request + $0.000036/row
 *   Labs ranked_keywords                       $0.012 PER DOMAIN
 *
 * Neither is optional because it is unimportant. 6 of the top 10 candidates in
 * a real market carried spam scores of 37-49, and the #3 candidate ranked for
 * exactly zero keywords -- facts invisible to age and archive depth, which is
 * everything the free stages can measure.
 * ========================================================================
 */

/**
 * Was a bare literal here. Registered in `endpoints.ts` since the affiliate
 * work, for the reason TRAP 2 exists: a path nobody diffs is a path that can
 * quietly become `"Invalid Path."` inside an HTTP 200, which reads exactly like
 * "this domain ranks for nothing" — the answer this gate is looking for.
 */
const RANKED_KEYWORDS_ENDPOINT = ENDPOINTS.LABS_RANKED_KEYWORDS

export interface QualityGateOptions {
  /** Bulk backlinks: spam score, domain rank, referring domains. One request per 1000. */
  checkSpam?: boolean
  /** Labs ranked_keywords. Billed per domain, so it is capped. */
  checkRankings?: boolean
  /** Max domains to buy a rankings check for, best-first. */
  maxRankingLookups?: number
  /** US national by default; rankings are geo-scoped. */
  locationCode?: number
}

export interface QualityRow {
  domain: string
  spamScore: number | null
  domainRank: number | null
  referringDomains: number | null
  referringSubnets: number | null
  /** Keywords this domain still ranks for. Null = not checked. */
  rankedKeywords: number | null
  /** Why a field is null, so "not checked" never reads as "clean". */
  note: string
}

export interface QualityGateResult {
  rows: QualityRow[]
  costMicros: Micros
  spamRequests: number
  rankingLookups: number
}

/** Keywords a domain still ranks for. One billable request. */
export async function fetchRankedKeywordCount(
  client: DataForSeoClient,
  target: string,
  locationCode = 2840,
): Promise<{ count: number; costMicros: Micros }> {
  const body = await client.post<Array<{ total_count?: number }>>(RANKED_KEYWORDS_ENDPOINT, [
    { target, location_code: locationCode, language_code: 'en', limit: 1 },
  ])
  return {
    count: body?.[0]?.total_count ?? 0,
    /**
     * Request fee PLUS the one row this asks for.
     *
     * Measured 2026-08-13: the endpoint bills $0.012 + $0.00012/row, so the flat
     * `PRICE.labsRankedKeywords` that used to be returned here under-ledgered
     * every call by exactly one row's worth. Tiny at `limit: 1` — and the reason
     * the constant was wrong for a year, because the only caller never asked for
     * more. `costMicros` applies both terms.
     */
    costMicros: costMicros('labsRankedKeywords', 1),
  }
}

/**
 * Run whichever gates the operator enabled.
 *
 * Every candidate gets a row, including ones that were not checked, each
 * carrying the reason. A null spam score on an unchecked domain and a genuine
 * zero are different facts and must not render the same.
 */
export async function runQualityGates(
  domains: string[],
  opts: QualityGateOptions = {},
): Promise<QualityGateResult> {
  const targets = [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(Boolean)
  if (targets.length === 0 || (!opts.checkSpam && !opts.checkRankings)) {
    return { rows: [], costMicros: 0n, spamRequests: 0, rankingLookups: 0 }
  }

  const client = createDfsClientFromEnv()
  if (!client) throw new Error('DataForSEO credentials are not configured.')

  let costMicros: Micros = 0n
  let spamRequests = 0
  const byDomain = new Map<string, QualityRow>()
  for (const d of targets) {
    byDomain.set(d, {
      domain: d,
      spamScore: null,
      domainRank: null,
      referringDomains: null,
      referringSubnets: null,
      rankedKeywords: null,
      note: 'Not checked',
    })
  }

  // ---- Gate 1: bulk backlinks (spam, rank, referring domains) ----
  if (opts.checkSpam) {
    const bulk = await fetchBulkBacklinks(client, targets)
    const billedRows = bulk.billedRows.ranks + bulk.billedRows.refdomains + bulk.billedRows.spam
    spamRequests = bulk.requestCount
    costMicros +=
      PRICE.backlinksBulkRequest * BigInt(bulk.requestCount) +
      PRICE.backlinksBulkRow * BigInt(billedRows)

    for (const d of targets) {
      const a = bulk.authorities.get(d)
      const row = byDomain.get(d)!
      row.spamScore = a?.spamScore ?? null
      row.domainRank = a?.rank ?? null
      row.referringDomains = a?.referringDomains ?? null
      row.referringSubnets = a?.referringMainDomains ?? null
      row.note = a
        ? `spam ${a.spamScore ?? '—'} · rank ${a.rank ?? '—'}`
        : 'No backlink data — the index has nothing for this domain'
    }
  }

  // ---- Gate 2: ranked keywords, capped because it bills per domain ----
  let rankingLookups = 0
  if (opts.checkRankings) {
    const cap = opts.maxRankingLookups ?? 15
    /**
     * Spend the cap on the domains most likely to be worth it. When the spam
     * gate ran, that means the cleanest strong profiles first; otherwise the
     * caller's order is already best-first.
     */
    const ordered = opts.checkSpam
      ? [...targets].sort((a, b) => {
          const ra = byDomain.get(a)!
          const rb = byDomain.get(b)!
          return (rb.domainRank ?? -1) - (ra.domainRank ?? -1)
        })
      : targets

    for (const d of ordered.slice(0, cap)) {
      try {
        const { count, costMicros: cost } = await fetchRankedKeywordCount(
          client,
          d,
          opts.locationCode ?? 2840,
        )
        rankingLookups += 1
        costMicros += cost
        const row = byDomain.get(d)!
        row.rankedKeywords = count
        row.note =
          count === 0
            ? `${row.note} · ranks for nothing`
            : `${row.note} · ranks for ${count} keyword(s)`
      } catch (err) {
        const row = byDomain.get(d)!
        // A failed lookup is not a zero.
        row.note = `${row.note} · rankings lookup failed: ${(err as Error).message.slice(0, 60)}`
      }
    }
  }

  return { rows: [...byDomain.values()], costMicros, spamRequests, rankingLookups }
}

/**
 * Estimated cost of a gate configuration, for showing the operator BEFORE they
 * commit. Deliberately an over-estimate on the bulk rows rather than under.
 */
export function estimateQualityGateCost(args: {
  domainCount: number
  checkSpam: boolean
  checkRankings: boolean
  maxRankingLookups: number
}): Micros {
  let total = 0n
  if (args.checkSpam && args.domainCount > 0) {
    const requests = BigInt(Math.ceil(args.domainCount / 1000))
    // Three endpoints are merged per target, so rows bill roughly 3x.
    total +=
      PRICE.backlinksBulkRequest * requests +
      PRICE.backlinksBulkRow * BigInt(args.domainCount * 3)
  }
  if (args.checkRankings) {
    total +=
      PRICE.labsRankedKeywords *
      BigInt(Math.min(args.domainCount, Math.max(0, args.maxRankingLookups)))
  }
  return total
}
