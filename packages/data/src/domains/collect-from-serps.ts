import 'server-only'
import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { discoverySerpMetrics } from '../schema.js'
import type { CollectedBusiness } from './collect-businesses.js'

/**
 * Domains the market sweep already bought and stored.
 *
 * ==================== THE CHEAPEST SOURCE THERE IS ====================
 * Every sweep cell purchases an organic SERP and, when enabled, a map pack --
 * and `discovery_serp_metrics` keeps the domains it saw. The domain search was
 * ignoring all of it and re-enumerating from a fresh Maps call.
 *
 * Measured when this was written: 516 distinct domains stored, 509 of which had
 * never been triaged, against 254 the domain search had found on its own. The
 * two populations barely overlap, and triage is free, so this roughly triples
 * coverage for nothing.
 *
 * Organic domains matter most: a domain in `top_organic_domains` is RANKING
 * RIGHT NOW. One that ranks and is abandoned is the best thing this tool can
 * find, because it has already demonstrated the only thing we care about.
 * =====================================================================
 */

export interface SerpSourcedDomain extends CollectedBusiness {
  /** `organic` and/or `map_pack`. */
  sources: string[]
  /** Best (lowest) organic rank_absolute seen. Null when only in a map pack. */
  serpRank: number | null
  /** A query that surfaced it, for audit. */
  seenKeyword: string | null
}

interface OrganicEntry {
  domain?: string | null
  rankAbsolute?: number | null
}

/**
 * Harvest stored domains for one market, optionally narrowed to one niche.
 *
 * Scoped by `locationCode` rather than `researchGeoId` because the same market
 * can be represented by more than one geo row, and a domain seen in that market
 * is worth triaging regardless of which row recorded it.
 */
export async function collectFromStoredSerps(
  db: Database,
  args: { locationCode: number; nicheId?: number | null; keyword?: string | null },
): Promise<SerpSourcedDomain[]> {
  const rows = await db
    .select({
      keyword: discoverySerpMetrics.keyword,
      topOrganicDomains: discoverySerpMetrics.topOrganicDomains,
      mapsDomains: discoverySerpMetrics.mapsDomains,
    })
    .from(discoverySerpMetrics)
    .where(
      and(
        eq(discoverySerpMetrics.locationCode, args.locationCode),
        args.nicheId == null ? undefined : eq(discoverySerpMetrics.nicheId, args.nicheId),
        or(
          isNotNull(discoverySerpMetrics.topOrganicDomains),
          isNotNull(discoverySerpMetrics.mapsDomains),
        ),
      ),
    )
    .limit(5_000)

  /** Merge by domain, keeping the BEST rank and every source that saw it. */
  const merged = new Map<string, SerpSourcedDomain>()

  const add = (
    rawDomain: string | null | undefined,
    source: string,
    rank: number | null,
    keyword: string | null,
  ): void => {
    const domain = (rawDomain ?? '').trim().toLowerCase()
    if (!domain) return

    const existing = merged.get(domain)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      if (rank != null && (existing.serpRank == null || rank < existing.serpRank)) {
        existing.serpRank = rank
        existing.seenKeyword = keyword
      }
      return
    }

    merged.set(domain, {
      // The sweep stores a domain, not a business record. Name it after the
      // domain rather than inventing one -- a fabricated business name would
      // be indistinguishable from a real listing downstream.
      name: domain,
      website: `https://${domain}`,
      sources: [source],
      serpRank: rank,
      seenKeyword: keyword,
      placeId: null,
      cid: null,
      address: null,
      phone: null,
      category: null,
      rating: null,
      reviewCount: null,
      isClaimed: null,
      latitude: null,
      longitude: null,
    })
  }

  for (const row of rows) {
    for (const entry of (row.topOrganicDomains ?? []) as OrganicEntry[]) {
      add(entry?.domain, 'organic', entry?.rankAbsolute ?? null, row.keyword)
    }
    for (const d of row.mapsDomains ?? []) {
      add(d, 'map_pack', null, row.keyword)
    }
  }

  // Best-ranking first: the lookup cap on any paid stage should spend there.
  return [...merged.values()].sort(
    (a, b) => (a.serpRank ?? 999) - (b.serpRank ?? 999) || a.name.localeCompare(b.name),
  )
}
