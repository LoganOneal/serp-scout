import 'server-only'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  assessAcquiredDomain,
  assessEmd,
  buildMatchContext,
  classifyResult,
  scoreDifficulty,
  type ClassifiedResult,
  type DomainAuthority,
  type EmdAssessment,
  type SerpItem,
} from '@rnr/core'
import type { Database } from '../db.js'
import { discoveryJobs, discoverySerpMetrics, localities, niches } from '../schema.js'
import { normaliseOrganicResult } from '../providers/dataforseo/serp.js'
import { fetchBulkBacklinks } from '../providers/dataforseo/backlinks.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { readAuthorityCache, writeAuthorityCache } from '../cache.js'
import { checkAvailabilityBatch, emdDomain } from '../providers/rdap.js'

/**
 * Can a site we build or buy actually rank on this SERP?
 *
 * ==================== NOTHING HERE RE-BUYS A SERP ====================
 * `discovery_jobs.raw_items` holds the complete raw DataForSEO page-1 payload
 * for every completed sweep job, and no product code had ever read it back. The
 * full organic list -- position, url, title, isHomepage -- is recovered from
 * there, so this runs over all history for free. `top_organic_domains` is not
 * used: it is capped at 5 and carries only {domain, rankAbsolute}.
 *
 * The only paid step is one batched backlinks pass over the distinct defending
 * domains, which is also cached for 90 days.
 *
 * Shape follows pipeline/run-scan.ts, which is the reference implementation for
 * the extract -> BARRIER -> score sequence.
 * =====================================================================
 */

export interface WinnabilityRow {
  metricId: number
  jobId: number
  keyword: string
  localityName: string | null
  nicheEmdToken: string | null
  nicheDomainStems: string[] | null
  hasLocalPack: boolean
  /** Measured local volume, when the run bought it. Null = not fetched. */
  volume: number | null
  items: SerpItem[]
}

export interface WinnabilityResult {
  metricId: number
  difficulty: number | null
  weightCovered: number
  components: unknown
  slotsOpen: number
  platformHeldSlots: number
  medianRefDomains: number | null
  minRefDomains: number | null
  exactMatchHomepagesTop5: number
  localBusinessesTop5Dedicated: number
  linkDataMeasured: boolean
  emd: EmdAssessment | null
  acquired: EmdAssessment
  emdDomainName: string | null
  emdAvailable: boolean | null
}

/** Metric rows that still carry their raw SERP payload. */
export async function loadWinnabilityRows(
  db: Database,
  opts: { runId?: number; metricIds?: number[]; limit?: number } = {},
): Promise<{ rows: WinnabilityRow[]; skippedNoRaw: number }> {
  const where = [isNotNull(discoveryJobs.rawItems)]
  if (opts.runId !== undefined) where.push(eq(discoverySerpMetrics.runId, opts.runId))
  if (opts.metricIds?.length) where.push(inArray(discoverySerpMetrics.id, opts.metricIds))

  const raw = await db
    .select({
      metricId: discoverySerpMetrics.id,
      jobId: discoverySerpMetrics.jobId,
      keyword: discoverySerpMetrics.keyword,
      mapPresent: discoverySerpMetrics.mapPresent,
      volume: discoverySerpMetrics.avgMonthlySearches,
      rawItems: discoveryJobs.rawItems,
      localityName: localities.name,
      nicheEmdToken: niches.emdToken,
      nicheDomainStems: niches.domainStems,
    })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .leftJoin(localities, eq(localities.id, discoverySerpMetrics.localityId))
    .leftJoin(niches, eq(niches.id, discoverySerpMetrics.nicheId))
    .where(and(...where))
    .limit(opts.limit ?? 5_000)

  const rows: WinnabilityRow[] = []
  let skippedNoRaw = 0
  for (const r of raw) {
    const items = r.rawItems
      ? // raw_items IS the `items` array, which is exactly the shape
        // normaliseOrganicResult expects. Reusing it keeps this extraction
        // byte-identical to the one the scan pipeline scores from.
        normaliseOrganicResult({ items: r.rawItems })
      : []
    if (items.length === 0) {
      skippedNoRaw += 1
      continue
    }
    rows.push({
      metricId: r.metricId,
      jobId: r.jobId,
      keyword: r.keyword,
      localityName: r.localityName,
      nicheEmdToken: r.nicheEmdToken,
      nicheDomainStems: r.nicheDomainStems,
      hasLocalPack: r.mapPresent,
      volume: r.volume,
      items,
    })
  }
  return { rows, skippedNoRaw }
}

export interface AuthorityPass {
  authorities: Map<string, DomainAuthority>
  fetched: number
  cached: number
  requestCount: number
  failed: boolean
}

/**
 * One batched backlinks pass over every defender, cache-first.
 *
 * THE BARRIER. Collecting the whole domain set before buying anything is what
 * makes this cents instead of dollars -- the same reasoning as run-scan.ts:236.
 * A failure here is NOT fatal: the scorer omits unmeasured components and
 * reports reduced coverage, and must never treat a domain as having zero links.
 */
export async function fetchAuthorities(
  db: Database,
  rows: WinnabilityRow[],
): Promise<AuthorityPass> {
  const all = new Set<string>()
  for (const r of rows) for (const item of r.items) all.add(item.domain)
  const domains = [...all].filter(Boolean)
  if (domains.length === 0) {
    return { authorities: new Map(), fetched: 0, cached: 0, requestCount: 0, failed: false }
  }

  const cache = await readAuthorityCache(db, domains)
  const authorities = new Map<string, DomainAuthority>(cache.hits)
  if (cache.misses.length === 0) {
    return { authorities, fetched: 0, cached: cache.hits.size, requestCount: 0, failed: false }
  }

  const client = createDfsClientFromEnv()
  if (!client) {
    return {
      authorities,
      fetched: 0,
      cached: cache.hits.size,
      requestCount: 0,
      failed: true,
    }
  }

  try {
    const out = await fetchBulkBacklinks(client, cache.misses)
    for (const [domain, a] of out.authorities) authorities.set(domain, a)
    await writeAuthorityCache(db, {
      authorities: out.authorities,
      unresolved: out.unresolved,
    })
    return {
      authorities,
      fetched: out.authorities.size,
      cached: cache.hits.size,
      requestCount: out.requestCount,
      failed: false,
    }
  } catch {
    // Partial data is recorded as partial. The alternative -- treating every
    // unfetched defender as linkless -- would report every SERP as wide open.
    return { authorities, fetched: 0, cached: cache.hits.size, requestCount: 0, failed: true }
  }
}

/** Score one row. Pure once the authorities and EMD availability are known. */
export function scoreRow(
  row: WinnabilityRow,
  authorities: Map<string, DomainAuthority>,
  emd: { domain: string | null; available: boolean | null },
): WinnabilityResult {
  const ctx = buildMatchContext({
    localityName: row.localityName ?? '',
    nicheEmdToken: row.nicheEmdToken ?? '',
    nicheDomainStems: row.nicheDomainStems ?? [],
  })

  const classified: ClassifiedResult[] = row.items.map((item) =>
    classifyResult(item, ctx, authorities.get(item.domain) ?? null),
  )
  const difficulty = scoreDifficulty({ results: classified, hasLocalPack: row.hasLocalPack })

  /**
   * ============ WHY VOLUME HAS TO BE REAL HERE ============
   * The only consumer is the 30-day volume gate. Hardcoding 0 made that gate
   * fail on every row, which made `likely_30d` unreachable, which made the
   * availability gate irrelevant -- and so the EMD and acquired verdicts came
   * out IDENTICAL on all 40 rows of the first dry run. Two verdicts that can
   * never disagree are worse than one.
   *
   * Null still means the run did not buy volume, and 0 still fails the gate --
   * but it fails as a NAMED gate the operator can see, with "enable volume" as
   * the obvious fix, rather than silently collapsing the whole model.
   * ========================================================
   */
  const volume = row.volume ?? 0

  const emdAlreadyRanks =
    emd.domain !== null && classified.some((c) => c.item.domain === emd.domain)

  const emdAssessment =
    emd.domain === null
      ? null
      : assessEmd({
          domain: emd.domain,
          difficulty,
          volume,
          domainAvailable: emd.available,
          hasLocalPack: row.hasLocalPack,
          emdAlreadyRanks,
        })

  const acquired = assessAcquiredDomain({
    difficulty,
    volume,
    hasLocalPack: row.hasLocalPack,
  })

  return {
    metricId: row.metricId,
    difficulty: difficulty.difficulty,
    weightCovered: difficulty.weightCovered,
    components: difficulty.components,
    slotsOpen: difficulty.slotsOpen,
    platformHeldSlots: difficulty.platformHeldSlots,
    medianRefDomains: difficulty.medianNonPlatformRefDomains,
    minRefDomains: difficulty.minNonPlatformRefDomains,
    exactMatchHomepagesTop5: difficulty.exactMatchHomepagesTop5,
    localBusinessesTop5Dedicated: difficulty.localBusinessesTop5Dedicated,
    linkDataMeasured: difficulty.linkDataMeasured,
    emd: emdAssessment,
    acquired,
    emdDomainName: emd.domain,
    emdAvailable: emd.available,
  }
}

export interface ComputeWinnabilityResult {
  results: WinnabilityResult[]
  skippedNoRaw: number
  authority: AuthorityPass
  emdChecked: number
}

/**
 * Extract, batch, score. `apply` persists; otherwise this is read-only.
 */
export async function computeWinnability(
  db: Database,
  opts: { runId?: number; limit?: number; apply?: boolean; checkEmd?: boolean } = {},
): Promise<ComputeWinnabilityResult> {
  const { rows, skippedNoRaw } = await loadWinnabilityRows(db, {
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  })
  if (rows.length === 0) {
    return {
      results: [],
      skippedNoRaw,
      authority: { authorities: new Map(), fetched: 0, cached: 0, requestCount: 0, failed: false },
      emdChecked: 0,
    }
  }

  const authority = await fetchAuthorities(db, rows)

  /**
   * The candidate EMD per (locality, niche). Free via RDAP, and throttled, so
   * it is computed once per distinct domain rather than once per row -- the
   * same cell appears twice when a run measures desktop and mobile.
   */
  const emdByRow = new Map<number, string>()
  const wanted = new Set<string>()
  for (const r of rows) {
    if (!r.localityName || !r.nicheEmdToken) continue
    const d = emdDomain(r.localityName, r.nicheEmdToken)
    emdByRow.set(r.metricId, d)
    wanted.add(d)
  }
  const availability =
    opts.checkEmd === false || wanted.size === 0
      ? new Map<string, { available: boolean | null }>()
      : await checkAvailabilityBatch([...wanted])

  const results = rows.map((r) => {
    const domain = emdByRow.get(r.metricId) ?? null
    return scoreRow(r, authority.authorities, {
      domain,
      available: domain ? (availability.get(domain)?.available ?? null) : null,
    })
  })

  if (opts.apply) {
    const now = new Date()
    for (const res of results) {
      await db
        .update(discoverySerpMetrics)
        .set({
          difficulty: res.difficulty,
          weightCovered: res.weightCovered,
          difficultyComponents: res.components,
          slotsOpen: res.slotsOpen,
          platformHeldSlots: res.platformHeldSlots,
          medianRefDomains: res.medianRefDomains,
          minRefDomains: res.minRefDomains,
          exactMatchHomepagesTop5: res.exactMatchHomepagesTop5,
          localBusinessesTop5Dedicated: res.localBusinessesTop5Dedicated,
          linkDataMeasured: res.linkDataMeasured,
          verdictEmd: res.emd?.verdict ?? null,
          blockersEmd: res.emd?.blockers ?? null,
          verdictAcquired: res.acquired.verdict,
          blockersAcquired: res.acquired.blockers,
          emdDomain: res.emdDomainName,
          emdAvailable: res.emdAvailable,
          winnabilityComputedAt: now,
        })
        .where(eq(discoverySerpMetrics.id, res.metricId))
    }
  }

  return { results, skippedNoRaw, authority, emdChecked: wanted.size }
}
