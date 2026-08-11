import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { keywordPathFor, matchesKeywordPath } from '@rnr/core'
import type { Database } from '../db.js'
import {
  discoveryGeos,
  discoveryHits,
  discoveryJobs,
  discoveryNiches,
  discoveryRuns,
  discoverySerpMetrics,
  localities,
  niches,
  researchGeos,
  type DiscoveryRun,
  type DiscoverySerpMetric,
} from '../schema.js'
import { ensureKeywordVolumesFromEnv } from './keyword-volume-cache.js'
import { reconcileDiscoverySpend } from './discovery-budget.js'

/** List discovery runs newest first. */
export async function listDiscoveryRuns(
  db: Database,
  limit = 40,
): Promise<DiscoveryRun[]> {
  return db
    .select()
    .from(discoveryRuns)
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(limit)
}

export interface DiscoveryRunDetail {
  run: DiscoveryRun
  spend: Awaited<ReturnType<typeof reconcileDiscoverySpend>>
  geos: {
    resolved: number
    unresolved: number
    unscannable: number
  }
  niches: Array<{
    id: number
    label: string
    keywordPrimary: string
    keywordNearMe: string
    nearMeSynthesised: boolean
    nicheId: number | null
    mappedNicheSlug: string | null
    mappedNicheLabel: string | null
  }>
}

export async function getDiscoveryRunDetail(
  db: Database,
  runId: number,
): Promise<DiscoveryRunDetail | null> {
  const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId)).limit(1)
  if (!run) return null

  const spend = await reconcileDiscoverySpend(db, runId)

  const geoRows = await db
    .select({
      status: discoveryGeos.resolveStatus,
      n: sql<number>`count(*)::int`,
    })
    .from(discoveryGeos)
    .where(eq(discoveryGeos.runId, runId))
    .groupBy(discoveryGeos.resolveStatus)

  const geos = { resolved: 0, unresolved: 0, unscannable: 0 }
  for (const g of geoRows) {
    if (g.status === 'resolved') geos.resolved = g.n
    else if (g.status === 'unresolved') geos.unresolved = g.n
    else if (g.status === 'unscannable_source') geos.unscannable = g.n
  }

  const nicheRows = await db
    .select({
      id: discoveryNiches.id,
      label: discoveryNiches.label,
      keywordPrimary: discoveryNiches.keywordPrimary,
      keywordNearMe: discoveryNiches.keywordNearMe,
      nearMeSynthesised: discoveryNiches.nearMeSynthesised,
      nicheId: discoveryNiches.nicheId,
      mappedNicheSlug: niches.slug,
      mappedNicheLabel: niches.label,
    })
    .from(discoveryNiches)
    .leftJoin(niches, eq(niches.id, discoveryNiches.nicheId))
    .where(eq(discoveryNiches.runId, runId))
    .orderBy(discoveryNiches.id)

  return {
    run,
    spend,
    geos,
    niches: nicheRows.map((r) => ({
      id: r.id,
      label: r.label,
      keywordPrimary: r.keywordPrimary,
      keywordNearMe: r.keywordNearMe,
      nearMeSynthesised: r.nearMeSynthesised,
      nicheId: r.nicheId,
      mappedNicheSlug: r.mappedNicheSlug ?? null,
      mappedNicheLabel: r.mappedNicheLabel ?? null,
    })),
  }
}

export interface DiscoveryHitRow {
  id: number
  runId: number
  keyword: string
  redditUrl: string
  redditPostId: string
  subreddit: string | null
  title: string | null
  sourceKind: string
  organicPosition: number | null
  packPosition: number | null
  rankAbsolute: number | null
  commentable: boolean | null
  commentableDetail: string | null
  promotedTargetId: number | null
  promotedSiteId: number | null
  discoveryNicheId: number | null
  nicheId: number | null
  localityId: number | null
  localityName: string | null
  localitySlug: string | null
  stateCode: string | null
  population: number | null
  nicheSlug: string | null
  nicheLabel: string | null
  discoveryNicheLabel: string | null
}

/** Hits for a run, sorted by locality population then name (design default). */
export async function listDiscoveryHitsForRun(
  db: Database,
  runId: number,
): Promise<DiscoveryHitRow[]> {
  const rows = await db
    .select({
      id: discoveryHits.id,
      runId: discoveryHits.runId,
      keyword: discoveryHits.keyword,
      redditUrl: discoveryHits.redditUrl,
      redditPostId: discoveryHits.redditPostId,
      subreddit: discoveryHits.subreddit,
      title: discoveryHits.title,
      sourceKind: discoveryHits.sourceKind,
      organicPosition: discoveryHits.organicPosition,
      packPosition: discoveryHits.packPosition,
      rankAbsolute: discoveryHits.rankAbsolute,
      commentable: discoveryHits.commentable,
      commentableDetail: discoveryHits.commentableDetail,
      promotedTargetId: discoveryHits.promotedTargetId,
      promotedSiteId: discoveryHits.promotedSiteId,
      discoveryNicheId: discoveryHits.discoveryNicheId,
      nicheId: discoveryHits.nicheId,
      localityId: discoveryHits.localityId,
      localityName: localities.name,
      localitySlug: localities.slug,
      stateCode: localities.stateCode,
      population: localities.population,
      nicheSlug: niches.slug,
      nicheLabel: niches.label,
      discoveryNicheLabel: discoveryNiches.label,
    })
    .from(discoveryHits)
    .leftJoin(localities, eq(localities.id, discoveryHits.localityId))
    .leftJoin(niches, eq(niches.id, discoveryHits.nicheId))
    .leftJoin(discoveryNiches, eq(discoveryNiches.id, discoveryHits.discoveryNicheId))
    .where(eq(discoveryHits.runId, runId))
    .orderBy(
      sql`${localities.population} DESC NULLS LAST`,
      localities.name,
      discoveryHits.keyword,
      discoveryHits.id,
    )

  return rows.map(mapHitRow)
}

function mapHitRow(r: {
  id: number
  runId: number
  keyword: string
  redditUrl: string
  redditPostId: string
  subreddit: string | null
  title: string | null
  sourceKind: string
  organicPosition: number | null
  packPosition: number | null
  rankAbsolute: number | null
  commentable: boolean | null
  commentableDetail: string | null
  promotedTargetId: number | null
  promotedSiteId: number | null
  discoveryNicheId: number | null
  nicheId: number | null
  localityId: number | null
  localityName: string | null
  localitySlug: string | null
  stateCode: string | null
  population: number | null
  nicheSlug: string | null
  nicheLabel: string | null
  discoveryNicheLabel: string | null
}): DiscoveryHitRow {
  return {
    id: r.id,
    runId: r.runId,
    keyword: r.keyword,
    redditUrl: r.redditUrl,
    redditPostId: r.redditPostId,
    subreddit: r.subreddit,
    title: r.title,
    sourceKind: r.sourceKind,
    organicPosition: r.organicPosition,
    packPosition: r.packPosition,
    rankAbsolute: r.rankAbsolute,
    commentable: r.commentable,
    commentableDetail: r.commentableDetail,
    promotedTargetId: r.promotedTargetId,
    promotedSiteId: r.promotedSiteId,
    discoveryNicheId: r.discoveryNicheId,
    nicheId: r.nicheId,
    localityId: r.localityId,
    localityName: r.localityName,
    localitySlug: r.localitySlug,
    stateCode: r.stateCode,
    population: r.population,
    nicheSlug: r.nicheSlug,
    nicheLabel: r.nicheLabel,
    discoveryNicheLabel: r.discoveryNicheLabel,
  }
}

const hitSelect = {
  id: discoveryHits.id,
  runId: discoveryHits.runId,
  keyword: discoveryHits.keyword,
  redditUrl: discoveryHits.redditUrl,
  redditPostId: discoveryHits.redditPostId,
  subreddit: discoveryHits.subreddit,
  title: discoveryHits.title,
  sourceKind: discoveryHits.sourceKind,
  organicPosition: discoveryHits.organicPosition,
  packPosition: discoveryHits.packPosition,
  rankAbsolute: discoveryHits.rankAbsolute,
  commentable: discoveryHits.commentable,
  commentableDetail: discoveryHits.commentableDetail,
  promotedTargetId: discoveryHits.promotedTargetId,
  promotedSiteId: discoveryHits.promotedSiteId,
  discoveryNicheId: discoveryHits.discoveryNicheId,
  nicheId: discoveryHits.nicheId,
  localityId: discoveryHits.localityId,
  localityName: localities.name,
  localitySlug: localities.slug,
  stateCode: localities.stateCode,
  population: localities.population,
  nicheSlug: niches.slug,
  nicheLabel: niches.label,
  discoveryNicheLabel: discoveryNiches.label,
}

/**
 * Reddit hits for one market cell (locality + seeded niche).
 * Includes hits mapped via discovery_niches.niche_id even if hit.niche_id was null at insert.
 */
export async function listDiscoveryHitsForCell(
  db: Database,
  args: { localityId: number; nicheId: number; runId?: number | null },
): Promise<DiscoveryHitRow[]> {
  const rows = await db
    .select(hitSelect)
    .from(discoveryHits)
    .leftJoin(localities, eq(localities.id, discoveryHits.localityId))
    .leftJoin(niches, eq(niches.id, discoveryHits.nicheId))
    .leftJoin(discoveryNiches, eq(discoveryNiches.id, discoveryHits.discoveryNicheId))
    .where(
      and(
        args.runId == null ? undefined : eq(discoveryHits.runId, args.runId),
        eq(discoveryHits.localityId, args.localityId),
        sql`(
          ${discoveryHits.nicheId} = ${args.nicheId}
          OR ${discoveryNiches.nicheId} = ${args.nicheId}
        )`,
      ),
    )
    .orderBy(desc(discoveryHits.createdAt), discoveryHits.keyword, discoveryHits.id)

  return rows.map(mapHitRow)
}

/**
 * Recent discovery runs that touch this locality (for progress on the market page).
 * Default sources=['market_cell'] so catalog bulk soft-maps do not flood the panel (K16).
 */
export async function listDiscoveryRunsForLocality(
  db: Database,
  localityId: number,
  limit = 5,
  opts?: { sources?: Array<'market_cell' | 'catalog' | 'legacy_csv'> },
): Promise<DiscoveryRun[]> {
  const sources = opts?.sources ?? (['market_cell'] as const)
  const runIds = await db
    .selectDistinct({ runId: discoveryGeos.runId })
    .from(discoveryGeos)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryGeos.runId))
    .where(
      and(
        eq(discoveryGeos.localityId, localityId),
        eq(discoveryGeos.resolveStatus, 'resolved'),
        inArray(discoveryRuns.source, [...sources]),
      ),
    )
    .orderBy(desc(discoveryGeos.runId))
    .limit(limit)

  if (runIds.length === 0) return []
  const ids = runIds.map((r) => r.runId)
  return db
    .select()
    .from(discoveryRuns)
    .where(inArray(discoveryRuns.id, ids))
    .orderBy(desc(discoveryRuns.createdAt))
}

export interface ActiveNicheOption {
  id: number
  slug: string
  label: string
  keywordNoun: string
}

/**
 * Latest market_cell metrics for a cell: one row per exact query × device.
 * Includes Google Ads avg monthly searches for that exact query string when available.
 * Backfills missing volumes from Google Ads (prefer city geo, else US national).
 */
export async function listSerpMetricsForCell(
  db: Database,
  args: { localityId: number; nicheId: number; runId?: number | null },
): Promise<DiscoverySerpMetric[]> {
  const rows = await db
    .select({ metric: discoverySerpMetrics })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoverySerpMetrics.runId))
    .where(
      and(
        eq(discoverySerpMetrics.localityId, args.localityId),
        eq(discoverySerpMetrics.nicheId, args.nicheId),
        /**
         * ==================== SCOPE TO ONE RUN, OR RUNS COLLIDE ====================
         * Without a runId this collapses to the newest row per keyword x device
         * ACROSS EVERY RUN. Houston x HVAC had metrics from six runs spanning
         * five days, so the page showed one keyword measured on the 5th next to
         * another measured on the 10th and called it a market -- a picture that
         * never existed at any single moment, and one that silently changes
         * under the operator whenever any run touches the cell.
         *
         * A null runId keeps the old "newest across runs" behaviour for callers
         * that genuinely want a current-best view; the market page passes one.
         * ==========================================================================
         */
        args.runId == null ? undefined : eq(discoverySerpMetrics.runId, args.runId),
        args.runId == null ? eq(discoveryRuns.source, 'market_cell') : undefined,
        args.runId == null ? sql`${discoverySerpMetrics.researchKeywordId} IS NULL` : undefined,
      ),
    )
    .orderBy(desc(discoverySerpMetrics.measuredAt))

  // Latest per exact query × device
  const byKey = new Map<string, DiscoverySerpMetric>()
  for (const r of rows) {
    const m = r.metric
    const key = `${m.keyword.toLowerCase()}|${m.device}`
    if (!byKey.has(key)) byKey.set(key, m)
  }
  let metrics = [...byKey.values()].sort((a, b) => {
    // Prefer higher volume first, then keyword alpha, desktop before mobile
    const va = a.avgMonthlySearches ?? -1
    const vb = b.avgMonthlySearches ?? -1
    if (vb !== va) return vb - va
    const kc = a.keyword.localeCompare(b.keyword)
    if (kc !== 0) return kc
    return a.device.localeCompare(b.device)
  })

  metrics = await ensureGoogleAdsVolumesForMetrics(db, metrics, args.localityId)
  return metrics
}

/**
 * Fill avg_monthly_searches from Google Ads for exact queries missing volume.
 * Uses the locality's provider location code as Keyword Planner geo when possible.
 */
async function ensureGoogleAdsVolumesForMetrics(
  db: Database,
  metrics: DiscoverySerpMetric[],
  localityId: number | null,
): Promise<DiscoverySerpMetric[]> {
  const missing = metrics.filter((m) => m.volumeSource == null || m.volumeSource === '')
  if (missing.length === 0) return metrics

  const uniqueKeywords = [...new Set(missing.map((m) => m.keyword.trim()).filter(Boolean))]
  if (uniqueKeywords.length === 0) return metrics

  const [loc] = localityId
    ? await db
        .select({
          providerLocationCode: localities.providerLocationCode,
          locationSource: localities.locationSource,
        })
        .from(localities)
        .where(eq(localities.id, localityId))
        .limit(1)
    : []

  const locationCode = missing[0]?.locationCode ?? loc?.providerLocationCode ?? null

  // The function name was already promising Google Ads; this is what makes it
  // true. Google Ads first (free), then the 30-day cache, and DataForSEO only
  // when the geo will not resolve -- with the purchase recorded either way.
  const vol = await ensureKeywordVolumesFromEnv(db, {
    keywords: uniqueKeywords,
    locationCode,
  })
  const at = (keyword: string) => vol.volumes.get(keyword.trim().toLowerCase())

  const ids = missing.map((m) => m.id)
  if (ids.length > 0) {
    // Persist source even when individual keywords have null volume (honest unmeasured).
    for (const m of missing) {
      const hit = at(m.keyword)
      await db
        .update(discoverySerpMetrics)
        .set({
          avgMonthlySearches: hit?.avgMonthlySearches ?? null,
          // Written even on a miss, so a keyword the provider has no data for
          // is not re-purchased on every subsequent read.
          volumeSource: hit?.source ?? 'no_data',
          volumeGeoTarget: hit?.geoTarget ?? null,
        })
        .where(eq(discoverySerpMetrics.id, m.id))
    }
  }

  return metrics.map((m) => {
    if (m.volumeSource != null && m.volumeSource !== '') return m
    const hit = at(m.keyword)
    return {
      ...m,
      avgMonthlySearches: hit?.avgMonthlySearches ?? null,
      volumeSource: hit?.source ?? 'no_data',
      volumeGeoTarget: hit?.geoTarget ?? null,
    }
  })
}

/**
 * Latest catalog primary metrics per device for one catalog keyword × geo cell.
 */
export async function listCatalogSerpMetricsForCell(
  db: Database,
  args: { researchKeywordId: number; researchGeoId: number },
): Promise<DiscoverySerpMetric[]> {
  const rows = await db
    .select({ metric: discoverySerpMetrics })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoverySerpMetrics.runId))
    .where(
      and(
        eq(discoverySerpMetrics.researchKeywordId, args.researchKeywordId),
        eq(discoverySerpMetrics.researchGeoId, args.researchGeoId),
        eq(discoveryRuns.source, 'catalog'),
        sql`(${discoverySerpMetrics.keywordVariant} = 'primary' OR ${discoverySerpMetrics.keywordVariant} IS NULL)`,
      ),
    )
    .orderBy(desc(discoverySerpMetrics.measuredAt))

  const byDevice = new Map<string, DiscoverySerpMetric>()
  for (const r of rows) {
    const m = r.metric
    if (!byDevice.has(m.device)) byDevice.set(m.device, m)
  }
  return [...byDevice.values()]
}

/** Recent catalog research runs (source=catalog). */
export async function listCatalogDiscoveryRuns(
  db: Database,
  limit = 10,
): Promise<DiscoveryRun[]> {
  return db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.source, 'catalog'))
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(limit)
}

/** Active seed niches for the discovery map-niche picker. */
export async function listActiveNichesForPicker(db: Database): Promise<ActiveNicheOption[]> {
  return db
    .select({
      id: niches.id,
      slug: niches.slug,
      label: niches.label,
      keywordNoun: niches.keywordNoun,
    })
    .from(niches)
    .where(eq(niches.active, true))
    .orderBy(niches.label)
}

/** Unresolved / unscannable geos for the audit table on a run. */
export async function listDiscoveryGeoAudit(db: Database, runId: number) {
  return db
    .select({
      id: discoveryGeos.id,
      rawName: discoveryGeos.rawName,
      rawState: discoveryGeos.rawState,
      rawPopulation: discoveryGeos.rawPopulation,
      resolveStatus: discoveryGeos.resolveStatus,
      unmatchedReason: discoveryGeos.unmatchedReason,
      candidateCount: discoveryGeos.candidateCount,
      lineNumber: discoveryGeos.lineNumber,
    })
    .from(discoveryGeos)
    .where(
      and(
        eq(discoveryGeos.runId, runId),
        sql`${discoveryGeos.resolveStatus} <> 'resolved'`,
      ),
    )
    .orderBy(discoveryGeos.lineNumber, discoveryGeos.id)
}

export async function countPendingDiscoveryJobs(db: Database, runId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discoveryJobs)
    .where(
      and(
        eq(discoveryJobs.runId, runId),
        sql`${discoveryJobs.status} IN ('pending', 'claimed')`,
      ),
    )
  return row?.n ?? 0
}

/** One run that measured a given niche x locality cell. */
export interface CellRunOption {
  runId: number
  source: string
  status: string
  label: string | null
  measuredAt: Date | null
  /** Distinct keywords this run measured for the cell. */
  keywords: number
  /** How many of those SERPs we still hold the full page for. */
  storedSerps: number
}

/**
 * Every run that measured this cell, newest first.
 *
 * ==================== WHY THE PAGE NEEDS THIS ====================
 * The cell URL is deliberately stable across the whole lifecycle, so it cannot
 * carry a run id in the path. But a market measured six times is six different
 * pictures, and merging them produced a view that existed at no single moment.
 * This is what lets the page pick one and say which.
 *
 * Deliberately NOT filtered to `market_cell`: a catalog sweep measures these
 * same cells, and excluding it meant the biggest source of data for a market
 * was invisible on the market's own page.
 * ================================================================
 */
export async function listRunsForCell(
  db: Database,
  args: { localityId: number; nicheId: number },
): Promise<CellRunOption[]> {
  const rows = await db
    .select({
      runId: discoverySerpMetrics.runId,
      source: discoveryRuns.source,
      status: discoveryRuns.status,
      label: discoveryRuns.label,
      /**
       * Typed as the driver actually returns it. A raw `sql<Date>` here is a
       * lie TypeScript cannot check: drizzle applies no column parser to an
       * aggregate expression, so postgres-js hands back a STRING and the first
       * `.toISOString()` downstream throws at runtime with a green build.
       */
      measuredAt: sql<string | null>`max(${discoverySerpMetrics.measuredAt})`,
      keywords: sql<number>`count(distinct lower(${discoverySerpMetrics.keyword}))::int`,
      storedSerps: sql<number>`count(${discoveryJobs.rawItems})::int`,
    })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoverySerpMetrics.runId))
    .leftJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .where(
      and(
        eq(discoverySerpMetrics.localityId, args.localityId),
        eq(discoverySerpMetrics.nicheId, args.nicheId),
      ),
    )
    .groupBy(
      discoverySerpMetrics.runId,
      discoveryRuns.source,
      discoveryRuns.status,
      discoveryRuns.label,
    )
    .orderBy(desc(discoverySerpMetrics.runId))

  return rows.map((r) => ({
    runId: r.runId,
    source: r.source,
    status: r.status,
    label: r.label,
    measuredAt: r.measuredAt == null ? null : new Date(r.measuredAt),
    keywords: r.keywords,
    storedSerps: r.storedSerps,
  }))
}

/** The stored page-1 SERP for one measured keyword. */
export interface StoredCellSerp {
  jobId: number
  runId: number
  keyword: string
  keywordVariant: string | null
  device: string
  measuredAt: Date | null
  /** Depth the SERP was bought at, so a short capture is not read as a short page. */
  depth: number | null
  /** The complete raw page as the provider returned it. */
  items: Array<Record<string, unknown>>
}

/**
 * The full stored SERPs for a cell, one per keyword x device.
 *
 * ==================== ALREADY BOUGHT, NEVER SHOWN ====================
 * `discovery_jobs.raw_items` has held the complete page for every completed
 * SERP since the sweep was written -- 3,460 of them -- and no product surface
 * ever read it. An operator asking "what did page 1 actually look like" had to
 * take the derived counters on faith, or re-run a live SERP link and hope
 * Google served the same thing.
 *
 * This costs nothing to serve: the page was paid for when the run executed.
 * ====================================================================
 */
export async function listStoredSerpsForCell(
  db: Database,
  args: { localityId: number; nicheId: number; runId?: number | null },
): Promise<StoredCellSerp[]> {
  const rows = await db
    .select({
      jobId: discoveryJobs.id,
      runId: discoverySerpMetrics.runId,
      keyword: discoverySerpMetrics.keyword,
      keywordVariant: discoverySerpMetrics.keywordVariant,
      device: discoverySerpMetrics.device,
      measuredAt: discoverySerpMetrics.measuredAt,
      depth: discoveryJobs.depth,
      items: discoveryJobs.rawItems,
    })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .where(
      and(
        eq(discoverySerpMetrics.localityId, args.localityId),
        eq(discoverySerpMetrics.nicheId, args.nicheId),
        args.runId == null ? undefined : eq(discoverySerpMetrics.runId, args.runId),
        sql`${discoveryJobs.rawItems} IS NOT NULL`,
      ),
    )
    .orderBy(desc(discoverySerpMetrics.measuredAt))

  /**
   * One per keyword x device. Without a runId this spans runs, so the newest
   * wins -- the same rule the metrics query uses, kept identical on purpose so
   * the SERP shown always belongs to the row shown beside it.
   */
  const seen = new Map<string, StoredCellSerp>()
  for (const r of rows) {
    const key = `${r.keyword.trim().toLowerCase()}|${r.device}`
    if (seen.has(key)) continue
    seen.set(key, {
      jobId: r.jobId,
      runId: r.runId,
      keyword: r.keyword,
      keywordVariant: r.keywordVariant,
      device: r.device,
      measuredAt: r.measuredAt,
      depth: r.depth,
      items: (r.items ?? []) as Array<Record<string, unknown>>,
    })
  }
  return [...seen.values()]
}

/** One device's measurement of a keyword, with the page it was read from. */
export interface RunKeywordDevice {
  metricId: number
  jobId: number
  device: string
  measuredAt: Date | null
  depth: number | null
  jobStatus: string
  jobError: string | null
  costMicros: bigint
  /** The complete raw page, exactly as the provider returned it. */
  items: Array<Record<string, unknown>>
  metric: DiscoverySerpMetric
  redditHits: Array<{
    redditUrl: string
    title: string | null
    subreddit: string | null
    sourceKind: string
    organicPosition: number | null
    rankAbsolute: number | null
    packPosition: number | null
  }>
}

export interface RunKeywordDetail {
  runId: number
  runLabel: string | null
  runStatus: string
  keyword: string
  keywordVariant: string | null
  locationCode: number | null
  market: string | null
  stateAbbr: string | null
  nicheSlug: string | null
  nicheLabel: string | null
  localitySlug: string | null
  geoTargetName: string | null
  queryModifier: string | null
  lat: number | null
  lon: number | null
  /** One entry per device measured, desktop first. */
  devices: RunKeywordDevice[]
}

/**
 * Everything one run knows about one keyword.
 *
 * ==================== ADDRESSED BY METRIC, SHOWN BY KEYWORD ====================
 * The URL carries a metrics id because that is the only stable handle on a row:
 * researchKeywordId + researchGeoId does not identify one, since the
 * geo-explicit variant reuses the primary's keyword row and every pair is
 * measured once per device.
 *
 * The PAGE, though, is about the keyword. So the id resolves to its
 * keyword + geo + variant within the run, and every device measured for it
 * comes back together -- desktop and mobile are two readings of one question,
 * and the interesting differences (perspectives modules, local packs) show up
 * precisely when they disagree.
 * ==============================================================================
 */
export async function getRunKeywordDetail(
  db: Database,
  args: { runId: number; metricId: number },
): Promise<RunKeywordDetail | null> {
  const [anchor] = await db
    .select()
    .from(discoverySerpMetrics)
    .where(
      and(
        eq(discoverySerpMetrics.id, args.metricId),
        eq(discoverySerpMetrics.runId, args.runId),
      ),
    )
    .limit(1)
  if (!anchor) return null

  const [run] = await db
    .select({
      label: discoveryRuns.label,
      status: discoveryRuns.status,
    })
    .from(discoveryRuns)
    .where(eq(discoveryRuns.id, args.runId))
    .limit(1)

  /**
   * Siblings are matched on the measured KEYWORD, not on researchKeywordId:
   * "roofing repair" and "roofing repair charlotte" share a keyword row but are
   * different questions, and showing them on one page would merge two SERPs.
   */
  const siblings = await db
    .select({ metric: discoverySerpMetrics, job: discoveryJobs })
    .from(discoverySerpMetrics)
    .leftJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .where(
      and(
        eq(discoverySerpMetrics.runId, args.runId),
        eq(discoverySerpMetrics.keyword, anchor.keyword),
        anchor.locationCode == null
          ? undefined
          : eq(discoverySerpMetrics.locationCode, anchor.locationCode),
      ),
    )
    .orderBy(asc(discoverySerpMetrics.device))

  const jobIds = siblings.map((s) => s.metric.jobId)
  const hits =
    jobIds.length === 0
      ? []
      : await db
          .select({
            jobId: discoveryHits.jobId,
            redditUrl: discoveryHits.redditUrl,
            title: discoveryHits.title,
            subreddit: discoveryHits.subreddit,
            sourceKind: discoveryHits.sourceKind,
            organicPosition: discoveryHits.organicPosition,
            rankAbsolute: discoveryHits.rankAbsolute,
            packPosition: discoveryHits.packPosition,
          })
          .from(discoveryHits)
          .where(inArray(discoveryHits.jobId, jobIds))

  const hitsByJob = new Map<number, typeof hits>()
  for (const h of hits) {
    const list = hitsByJob.get(h.jobId) ?? []
    list.push(h)
    hitsByJob.set(h.jobId, list)
  }

  const geoRow = anchor.researchGeoId
    ? (
        await db
          .select()
          .from(researchGeos)
          .where(eq(researchGeos.id, anchor.researchGeoId))
          .limit(1)
      )[0]
    : undefined

  const nicheRow = anchor.nicheId
    ? (await db.select().from(niches).where(eq(niches.id, anchor.nicheId)).limit(1))[0]
    : undefined

  const localityRow = anchor.localityId
    ? (await db.select().from(localities).where(eq(localities.id, anchor.localityId)).limit(1))[0]
    : undefined

  return {
    runId: args.runId,
    runLabel: run?.label ?? null,
    runStatus: run?.status ?? 'unknown',
    keyword: anchor.keyword,
    keywordVariant: anchor.keywordVariant,
    locationCode: anchor.locationCode,
    market: geoRow?.market ?? localityRow?.name ?? null,
    stateAbbr: geoRow?.stateAbbr ?? localityRow?.stateCode ?? null,
    nicheSlug: nicheRow?.slug ?? null,
    nicheLabel: nicheRow?.label ?? null,
    localitySlug: localityRow?.slug ?? null,
    geoTargetName: geoRow?.dataforseoLocationName ?? null,
    queryModifier:
      geoRow?.recommendedExplicitModifier ?? geoRow?.naturalQueryModifier ?? null,
    lat: localityRow?.lat ?? null,
    lon: localityRow?.lon ?? null,
    devices: siblings.map((s) => ({
      metricId: s.metric.id,
      jobId: s.metric.jobId,
      device: s.metric.device,
      measuredAt: s.metric.measuredAt,
      depth: s.job?.depth ?? null,
      jobStatus: s.job?.status ?? 'unknown',
      jobError: s.job?.error ?? null,
      costMicros: s.job?.costMicros ?? 0n,
      items: (s.job?.rawItems ?? []) as Array<Record<string, unknown>>,
      metric: s.metric,
      redditHits: hitsByJob.get(s.metric.jobId) ?? [],
    })),
  }
}

/** One measured keyword in a run, as the run's SERP index lists it. */
export interface RunKeywordIndexRow {
  keyword: string
  keywordVariant: string | null
  market: string | null
  stateAbbr: string | null
  /** Path segment(s) under /research/runs/<id>/serp/. */
  path: string
  devices: string[]
  redditHits: number
  volume: number | null
  storedSerps: number
  measuredAt: Date | null
}

/**
 * Every keyword a run measured, with the path to its SERP page.
 *
 * Paths come from keywordPathFor, which shortens to just the keyword when that
 * is unique in the run and qualifies by market when it is not -- a catalog
 * sweep measures one keyword across many markets, and a bare slug cannot
 * address a single one of them.
 */
export async function listRunKeywords(
  db: Database,
  runId: number,
): Promise<RunKeywordIndexRow[]> {
  const rows = await db
    .select({
      keyword: discoverySerpMetrics.keyword,
      keywordVariant: discoverySerpMetrics.keywordVariant,
      device: discoverySerpMetrics.device,
      volume: discoverySerpMetrics.avgMonthlySearches,
      redditHitCount: discoverySerpMetrics.redditHitCount,
      measuredAt: discoverySerpMetrics.measuredAt,
      market: researchGeos.market,
      stateAbbr: researchGeos.stateAbbr,
      hasRaw: sql<boolean>`${discoveryJobs.rawItems} IS NOT NULL`,
    })
    .from(discoverySerpMetrics)
    .leftJoin(researchGeos, eq(researchGeos.id, discoverySerpMetrics.researchGeoId))
    .leftJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .where(eq(discoverySerpMetrics.runId, runId))
    .orderBy(asc(discoverySerpMetrics.keyword))

  /** Collapse devices: one entry per keyword x market, which is one page. */
  const byCell = new Map<string, RunKeywordIndexRow>()
  for (const r of rows) {
    const key = `${r.keyword.toLowerCase()} ${r.market ?? ''} ${r.stateAbbr ?? ''}`
    const existing = byCell.get(key)
    if (existing) {
      if (!existing.devices.includes(r.device)) existing.devices.push(r.device)
      existing.redditHits += r.redditHitCount
      existing.volume = existing.volume ?? r.volume
      if (r.hasRaw) existing.storedSerps += 1
      continue
    }
    byCell.set(key, {
      keyword: r.keyword,
      keywordVariant: r.keywordVariant,
      market: r.market,
      stateAbbr: r.stateAbbr,
      path: '',
      devices: [r.device],
      redditHits: r.redditHitCount,
      volume: r.volume,
      storedSerps: r.hasRaw ? 1 : 0,
      measuredAt: r.measuredAt,
    })
  }

  const all = [...byCell.values()]
  const candidates = all.map((r) => ({
    keyword: r.keyword,
    market: r.market,
    stateAbbr: r.stateAbbr,
  }))
  for (const r of all) {
    r.path = keywordPathFor(
      { keyword: r.keyword, market: r.market, stateAbbr: r.stateAbbr },
      candidates,
    )
    r.devices.sort()
  }
  return all.sort(
    (a, b) =>
      b.redditHits - a.redditHits ||
      (b.volume ?? -1) - (a.volume ?? -1) ||
      a.keyword.localeCompare(b.keyword),
  )
}

/**
 * Resolve a `/serp/...` path inside a run to a measurement.
 *
 * Returns `ambiguous` rather than guessing when a bare keyword slug matches
 * more than one market: silently opening the first would show an operator a
 * different city's SERP under a URL that named neither.
 */
export async function resolveRunKeywordPath(
  db: Database,
  args: { runId: number; segments: string[] },
): Promise<
  | { kind: 'found'; metricId: number }
  | { kind: 'ambiguous'; options: RunKeywordIndexRow[] }
  | { kind: 'missing' }
> {
  const index = await listRunKeywords(db, args.runId)
  const matches = index.filter((r) =>
    matchesKeywordPath(
      { keyword: r.keyword, market: r.market, stateAbbr: r.stateAbbr },
      args.segments,
    ),
  )
  if (matches.length === 0) return { kind: 'missing' }
  if (matches.length > 1) return { kind: 'ambiguous', options: matches }

  const hit = matches[0]!
  const [metric] = await db
    .select({ id: discoverySerpMetrics.id })
    .from(discoverySerpMetrics)
    .where(
      and(
        eq(discoverySerpMetrics.runId, args.runId),
        eq(discoverySerpMetrics.keyword, hit.keyword),
      ),
    )
    // Desktop before mobile, so the page opens on the same device every time.
    .orderBy(asc(discoverySerpMetrics.device))
    .limit(1)
  if (!metric) return { kind: 'missing' }
  return { kind: 'found', metricId: metric.id }
}
