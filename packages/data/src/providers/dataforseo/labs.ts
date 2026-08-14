import 'server-only'
import { PRICE, type Micros } from '@rnr/core'
import type { DataForSeoClient } from './client.js'
import { ENDPOINTS } from './endpoints.js'

/**
 * DataForSEO Labs — the only source here that can see a COMPETITOR's keywords.
 *
 * ==================== READ THIS BEFORE PREFERRING IT ====================
 * For a domain WE own, Search Console is strictly better on every axis that
 * matters: it reports every query that produced an impression (not a vendor's
 * crawl sample), the actual average position from our own traffic, plus
 * impressions, clicks and CTR that no vendor can supply — and it costs nothing.
 *
 * Labs earns its place on exactly one thing: it works on domains we do not own.
 * Where the two disagree about our own domain, Search Console is right. Do not
 * average them.
 * =====================================================================
 *
 * ⚠️ COST IS UNVERIFIED ABOVE `limit: 1`. See PRICE.labsRankedKeywords. Every
 * function here reports `rowsReturned` so a probe can divide a balance delta by
 * it, and every one takes an explicit `limit` rather than defaulting large.
 */

/** United States. Labs uses the same location codes as the SERP endpoints. */
export const LABS_LOCATION_US = 2840

/**
 * Deliberately small.
 *
 * A default that returns thousands of rows on an endpoint whose per-row billing
 * is unmeasured is how a $0.012 line item becomes something else. Callers that
 * want more must say so.
 */
export const DEFAULT_LABS_LIMIT = 100

export interface RankedKeyword {
  keyword: string
  /** Our organic position on this SERP. Null = present but unranked in organic. */
  position: number | null
  /** The page of ours that ranks. Provenance for an IMPROVE decision. */
  url: string | null
  /** Vendor's national estimate. NOT our impressions — see the banner. */
  searchVolume: number | null
  cpcMicros: bigint | null
  competition: number | null
  /** Estimated traffic value, as the vendor models it. Modelled, not measured. */
  etv: number | null
}

export interface RankedKeywordsResult {
  target: string
  keywords: RankedKeyword[]
  /** What the vendor says it holds in total, which may exceed what was returned. */
  totalCount: number | null
  /** What we actually got. The denominator for a per-row cost measurement. */
  rowsReturned: number
  costMicros: Micros
  /** True when totalCount exceeds rowsReturned — the result is a page, not the set. */
  truncated: boolean
}

function usdToMicros(n: number | null | undefined): bigint | null {
  if (n == null || !Number.isFinite(n)) return null
  return BigInt(Math.round(n * 1_000_000))
}

function num(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

interface LabsItem {
  keyword_data?: {
    keyword?: string
    keyword_info?: {
      search_volume?: number | null
      cpc?: number | null
      competition?: number | null
    }
  }
  ranked_serp_element?: {
    serp_item?: {
      rank_group?: number | null
      rank_absolute?: number | null
      url?: string | null
      etv?: number | null
    }
  }
}

/**
 * Every keyword a domain ranks for.
 *
 * `truncated` is part of the answer, not a diagnostic. A capped page of results
 * reads exactly like a complete set, and "this domain ranks for 100 keywords"
 * when it ranks for 4,000 is the kind of wrong number that gets acted on.
 */
export async function fetchRankedKeywords(
  client: DataForSeoClient,
  args: {
    target: string
    locationCode?: number
    languageCode?: string
    limit?: number
    /** Only keywords where we rank at or better than this. Cheap pre-filter. */
    maxPosition?: number
  },
): Promise<RankedKeywordsResult> {
  const limit = args.limit ?? DEFAULT_LABS_LIMIT
  const body = await client.post<
    Array<{ items?: LabsItem[]; total_count?: number; items_count?: number }>
  >(ENDPOINTS.LABS_RANKED_KEYWORDS, [
    {
      target: args.target,
      location_code: args.locationCode ?? LABS_LOCATION_US,
      language_code: args.languageCode ?? 'en',
      limit,
      order_by: ['ranked_serp_element.serp_item.rank_group,asc'],
      ...(args.maxPosition === undefined
        ? {}
        : {
            filters: [
              ['ranked_serp_element.serp_item.rank_group', '<=', args.maxPosition],
            ],
          }),
    },
  ])

  const result = body?.[0]
  const items = result?.items ?? []
  const keywords: RankedKeyword[] = []

  for (const item of items) {
    const keyword = item.keyword_data?.keyword?.trim()
    if (!keyword) continue
    const serp = item.ranked_serp_element?.serp_item
    keywords.push({
      keyword,
      position: num(serp?.rank_group),
      url: serp?.url ?? null,
      searchVolume: num(item.keyword_data?.keyword_info?.search_volume),
      cpcMicros: usdToMicros(item.keyword_data?.keyword_info?.cpc),
      competition: num(item.keyword_data?.keyword_info?.competition),
      etv: num(serp?.etv),
    })
  }

  const totalCount = num(result?.total_count)
  return {
    target: args.target,
    keywords,
    totalCount,
    rowsReturned: keywords.length,
    costMicros: PRICE.labsRankedKeywords + PRICE.labsRankedKeywordsRow * BigInt(keywords.length),
    truncated: totalCount !== null && totalCount > keywords.length,
  }
}

export interface CompetitorDomain {
  domain: string
  /** Keywords we and they both rank for. */
  intersections: number | null
  /** Their total organic keyword count, as the vendor reports it. */
  rankedKeywords: number | null
  /** Their estimated organic traffic. Modelled by the vendor. */
  etv: number | null
  avgPosition: number | null
}

export interface CompetitorsResult {
  target: string
  competitors: CompetitorDomain[]
  rowsReturned: number
  costMicros: Micros
}

/**
 * Who ranks for the same things we do.
 *
 * Returns everything the vendor says, unfiltered. Deciding which of these is a
 * PEER rather than a giant is a separate, explicit step — see
 * `classifyCompetitorPeers`. Filtering silently here would hide the finding the
 * plan pre-registered: that `hotelhottubs.com`'s competitor set may be entirely
 * unreachable, which is a result about the site, not noise to drop.
 */
export async function fetchCompetitorDomains(
  client: DataForSeoClient,
  args: { target: string; locationCode?: number; languageCode?: string; limit?: number },
): Promise<CompetitorsResult> {
  const body = await client.post<
    Array<{
      items?: Array<{
        domain?: string
        intersections?: number | null
        avg_position?: number | null
        metrics?: { organic?: { count?: number | null; etv?: number | null } }
      }>
    }>
  >(ENDPOINTS.LABS_COMPETITORS_DOMAIN, [
    {
      target: args.target,
      location_code: args.locationCode ?? LABS_LOCATION_US,
      language_code: args.languageCode ?? 'en',
      limit: args.limit ?? 20,
      order_by: ['intersections,desc'],
    },
  ])

  const items = body?.[0]?.items ?? []
  const competitors: CompetitorDomain[] = []
  for (const item of items) {
    const domain = item.domain?.trim().toLowerCase()
    if (!domain) continue
    competitors.push({
      domain,
      intersections: num(item.intersections),
      rankedKeywords: num(item.metrics?.organic?.count),
      etv: num(item.metrics?.organic?.etv),
      avgPosition: num(item.avg_position),
    })
  }

  return {
    target: args.target,
    competitors,
    rowsReturned: competitors.length,
    costMicros: PRICE.labsRankedKeywords + PRICE.labsRankedKeywordsRow * BigInt(competitors.length),
  }
}

/**
 * Is this competitor reachable, or is it Booking.com?
 *
 * ==================== THE PRE-REGISTERED FAILURE ====================
 * A keyword gap against a domain we cannot displace is a list of things we
 * cannot rank for, presented as opportunity. It is the affiliate equivalent of
 * the `kohler.com` false candidate that already cost this project one wrongly
 * top-ranked domain.
 *
 * So the size filter runs BEFORE the intersection, not after — the intersection
 * is the request that costs money.
 *
 * The ratio, not an absolute: "10x our keyword count" scales with us, where
 * "more than 50,000 keywords" would exclude every competitor of a large site and
 * none of a small one. A null on either side yields a NULL peer flag, never a
 * true one — an unmeasured competitor is not a confirmed peer.
 * ===================================================================
 */
export const PEER_MAX_SIZE_RATIO = 10

export function classifyCompetitorPeers(
  competitors: CompetitorDomain[],
  ourRankedKeywords: number | null,
): Array<CompetitorDomain & { peer: boolean | null; peerReason: string }> {
  return competitors.map((c) => {
    if (ourRankedKeywords === null || c.rankedKeywords === null) {
      return {
        ...c,
        peer: null,
        peerReason:
          'Not decidable — keyword counts unmeasured on one side. An unmeasured competitor is not a confirmed peer.',
      }
    }
    const ratio = c.rankedKeywords / Math.max(1, ourRankedKeywords)
    if (ratio > PEER_MAX_SIZE_RATIO) {
      return {
        ...c,
        peer: false,
        peerReason: `${c.rankedKeywords} keywords vs our ${ourRankedKeywords} (${ratio.toFixed(1)}x) — a gap against this is a list of things we cannot rank for`,
      }
    }
    return {
      ...c,
      peer: true,
      peerReason: `${c.rankedKeywords} keywords vs our ${ourRankedKeywords} (${ratio.toFixed(1)}x) — same weight class`,
    }
  })
}
