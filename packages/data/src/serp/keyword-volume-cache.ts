import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { PRICE, type Micros } from '@rnr/core'
import type { Database } from '../db.js'
import { keywordVolumeCache } from '../schema.js'
import {
  DFS_VOLUME_LOCATION_US,
  type DfsKeywordVolumeRow,
} from '../providers/dataforseo/keyword-volume.js'
import { liveCallsEnabled, type EnvLike } from '../providers/index.js'
import { fetchKeywordVolumes as fetchGoogleAdsVolumes } from '../providers/google-ads/keyword-volume.js'
import { recordDiscoverySpend } from './discovery-budget.js'

/**
 * Volume is a slow-moving number and the request is expensive; a month-old
 * figure is worth far more than a fresh $0.09 charge on every re-run.
 */
export const VOLUME_CACHE_TTL_DAYS = 30

/** DataForSEO accepts up to 1000 keywords per search_volume request. */
export const VOLUME_BATCH_MAX = 1000

export interface CachedVolume {
  keyword: string
  avgMonthlySearches: number | null
  competitionIndex: number | null
  competition: string | null
  cpcMicros: bigint | null
  lowTopOfPageBidMicros: bigint | null
  highTopOfPageBidMicros: bigint | null
  monthlySearches: Array<{ year: number; month: number; searchVolume: number }>
  source: string
  geoTarget: string | null
}

const norm = (k: string): string => k.trim().toLowerCase()

function toCached(row: typeof keywordVolumeCache.$inferSelect): CachedVolume {
  return {
    keyword: row.keyword,
    avgMonthlySearches: row.avgMonthlySearches,
    competitionIndex: row.competitionIndex,
    competition: row.competition,
    cpcMicros: row.cpcMicros,
    lowTopOfPageBidMicros: row.lowTopOfPageBidMicros,
    highTopOfPageBidMicros: row.highTopOfPageBidMicros,
    monthlySearches: row.monthlySearches ?? [],
    source: row.source,
    geoTarget: row.geoTarget,
  }
}

/** Rows still inside the TTL for these keywords at this location. */
export async function readFreshVolumes(
  db: Database,
  args: { keywords: string[]; locationCode: number; languageCode?: string },
): Promise<Map<string, CachedVolume>> {
  const keys = [...new Set(args.keywords.map(norm))].filter(Boolean)
  const out = new Map<string, CachedVolume>()
  if (keys.length === 0) return out

  const rows = await db
    .select()
    .from(keywordVolumeCache)
    .where(
      and(
        eq(keywordVolumeCache.locationCode, args.locationCode),
        eq(keywordVolumeCache.languageCode, args.languageCode ?? 'en'),
        inArray(keywordVolumeCache.keyword, keys),
        sql`${keywordVolumeCache.fetchedAt} > now() - (${VOLUME_CACHE_TTL_DAYS} || ' days')::interval`,
      ),
    )
  for (const row of rows) out.set(norm(row.keyword), toCached(row))
  return out
}

async function writeVolumes(
  db: Database,
  args: {
    locationCode: number
    languageCode: string
    source: string
    geoTarget: string | null
    rows: DfsKeywordVolumeRow[]
    /** Keywords we asked for; any not in `rows` are cached as a known miss. */
    requested: string[]
  },
): Promise<void> {
  const byKeyword = new Map(args.rows.map((r) => [norm(r.keyword), r]))
  const values = [...new Set(args.requested.map(norm))].filter(Boolean).map((keyword) => {
    const r = byKeyword.get(keyword)
    return {
      keyword,
      locationCode: args.locationCode,
      languageCode: args.languageCode,
      avgMonthlySearches: r?.avgMonthlySearches ?? null,
      competitionIndex: r?.competitionIndex ?? null,
      competition: r?.competition ?? null,
      cpcMicros: r?.cpcMicros ?? null,
      lowTopOfPageBidMicros: r?.lowTopOfPageBidMicros ?? null,
      highTopOfPageBidMicros: r?.highTopOfPageBidMicros ?? null,
      monthlySearches: r?.monthlySearches ?? [],
      source: args.source,
      geoTarget: args.geoTarget,
      hasData: r?.avgMonthlySearches != null,
      fetchedAt: new Date(),
    }
  })
  if (values.length === 0) return

  await db
    .insert(keywordVolumeCache)
    .values(values)
    .onConflictDoUpdate({
      target: [
        keywordVolumeCache.keyword,
        keywordVolumeCache.locationCode,
        keywordVolumeCache.languageCode,
      ],
      set: {
        avgMonthlySearches: sql`excluded.avg_monthly_searches`,
        competitionIndex: sql`excluded.competition_index`,
        competition: sql`excluded.competition`,
        cpcMicros: sql`excluded.cpc_micros`,
        lowTopOfPageBidMicros: sql`excluded.low_top_of_page_bid_micros`,
        highTopOfPageBidMicros: sql`excluded.high_top_of_page_bid_micros`,
        monthlySearches: sql`excluded.monthly_searches`,
        source: sql`excluded.source`,
        geoTarget: sql`excluded.geo_target`,
        hasData: sql`excluded.has_data`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    })
}


/** Google's own thresholds for the LOW / MEDIUM / HIGH label. */
function competitionLabel(index: number | null): string | null {
  if (index == null || !Number.isFinite(index)) return null
  if (index <= 33) return 'LOW'
  if (index <= 66) return 'MEDIUM'
  return 'HIGH'
}

interface VolumeBatchResult {
  rows: DfsKeywordVolumeRow[]
  source: string
  geoTarget: string | null
  /** What this batch cost. Zero on the Google Ads path. */
  costMicros: Micros
  billableRequests: number
  endpoint: string
}

/**
 * One batch of keywords at one location, from the cheapest source that works.
 *
 * ==================== GOOGLE ADS FIRST, AND WHY ====================
 * DataForSEO's endpoint is `keywords_data/GOOGLE_ADS/search_volume` -- it is a
 * reseller wrapper around the Keyword Planner API we already hold credentials
 * for. Measured against the same keywords and market, the two return identical
 * volumes (1.00x on every keyword tested), and Google also returns the
 * competition index, the top-of-page bid range, and the 12-month series. The
 * difference is $0.09 a request versus nothing.
 *
 * DataForSEO stays as the fallback because it resolves locations we might not:
 * US city codes work directly (DataForSEO reuses Google's criteria IDs, which
 * is why a code like 1023191 passes straight through), but that will not hold
 * for every market a catalog can contain.
 * =================================================================
 */
async function fetchVolumeBatch(args: {
  keywords: string[]
  locationCode: number
  live: boolean
}): Promise<VolumeBatchResult> {
  if (args.live) {
    try {
      const gads = await fetchGoogleAdsVolumes(args.keywords, {
        live: true,
        geoTargetCriteriaIds: [args.locationCode],
      })
      // `google_ads` with at least one populated row means the geo resolved.
      const usable =
        gads.source === 'google_ads' && gads.rows.some((r) => r.avgMonthlySearches != null)
      if (usable) {
        return {
          source: 'google_ads',
          geoTarget: `location_code=${args.locationCode}`,
          costMicros: 0n,
          billableRequests: 0,
          endpoint: 'google_ads/keyword_plan_idea/historical_metrics',
          rows: gads.rows.map((r) => ({
            keyword: r.keyword,
            avgMonthlySearches: r.avgMonthlySearches,
            competitionIndex: r.competitionIndex,
            competition: competitionLabel(r.competitionIndex),
            /**
             * Deliberately null. Google publishes a top-of-page bid RANGE, not a
             * CPC, and the two do not map: measured against cached DataForSEO
             * rows, cpc/high ran 0.07x-1.16x and cpc/low 0.79x-2.59x. Any single
             * derived number would be a fabricated figure in a column operators
             * read as measured. The real range is carried below instead.
             */
            cpcMicros: null,
            lowTopOfPageBidMicros: r.lowTopOfPageBidMicros,
            highTopOfPageBidMicros: r.highTopOfPageBidMicros,
            monthlySearches: r.monthlySearches,
          })),
        }
      }
      /**
       * Reached Google Ads and it answered, but with nothing usable. That is
       * either a genuine "no figure" or a failure the provider already logged;
       * either way the keyword gets a null rather than a paid fallback.
       */
      if (gads.source === 'skipped' && gads.error) {
        console.error(`[volume] google ads unusable for ${args.locationCode}: ${gads.error}`)
      }
    } catch (e) {
      // Falls through to the empty result below, NOT to a paid provider.
      console.error(`[volume] google ads threw for ${args.locationCode}: ${(e as Error).message}`)
    }
  }

  /**
   * ============ NO PAID FALLBACK. VOLUME IS FREE OR IT IS NULL. ============
   * This used to fall through to DataForSEO's search_volume endpoint at $0.09
   * PER REQUEST. That fallback is removed by policy: keyword volume comes from
   * Google Ads, which we already hold credentials for and which returns the
   * same figures, or it does not come at all.
   *
   * The fallback existed because DataForSEO resolves some geos Google Ads may
   * not. The trade is now explicit: an unresolvable market gets NULL volume
   * rather than a $0.09 charge. Null is already the honest value everywhere in
   * this codebase -- it renders as an em dash and sorts last, and it never
   * masquerades as zero demand.
   *
   * A single stray fallback charge is what prompted this: one job in run 23
   * cost $0.094 instead of $0.002, and the $0.09 of it was this call.
   * ========================================================================
   */
  return {
    rows: emptyVolumeRows(args.keywords),
    source: 'no_data',
    geoTarget: `location_code=${args.locationCode}`,
    costMicros: 0n,
    billableRequests: 0,
    endpoint: 'google_ads/keyword_plan_idea/historical_metrics',
  }
}

/** Every requested keyword, measured as unknown. Never zero. */
function emptyVolumeRows(keywords: string[]): DfsKeywordVolumeRow[] {
  return [...new Set(keywords.map((k) => k.trim().toLowerCase()))]
    .filter(Boolean)
    .map((keyword) => ({
      keyword,
      avgMonthlySearches: null,
      competitionIndex: null,
      competition: null,
      cpcMicros: null,
      lowTopOfPageBidMicros: null,
      highTopOfPageBidMicros: null,
      monthlySearches: [],
    }))
}

export interface EnsureVolumesResult {
  volumes: Map<string, CachedVolume>
  /** Keywords fetched live this call (0 when everything was cached). */
  fetched: number
  /** Requests actually issued — this is what we were billed for. */
  requests: number
  costMicros: Micros
}

/**
 * Volume for many keywords at one location, buying only what is missing.
 *
 * ==================== ONE REQUEST, NOT ONE PER KEYWORD ====================
 * This is the whole fix. search_volume costs $0.09 per REQUEST and takes 1000
 * keywords, so the price of a run is the number of LOCATIONS, not the number of
 * cells. Asking per keyword made a 50x50 run cost $225; asking per location
 * makes it $4.50, and the cache makes the next run over those markets free.
 *
 * Spend is recorded against the run when a request is issued, so the ledger
 * shows the $0.09 the moment it is spent rather than never.
 * ========================================================================
 */
export async function ensureKeywordVolumes(
  db: Database,
  args: {
    keywords: string[]
    locationCode: number
    languageCode?: string
    live: boolean
    /** Bill the request to this run when one is issued. */
    runId?: number
    jobId?: number
  },
): Promise<EnsureVolumesResult> {
  const languageCode = args.languageCode ?? 'en'
  const wanted = [...new Set(args.keywords.map(norm))].filter(Boolean)
  const volumes = await readFreshVolumes(db, {
    keywords: wanted,
    locationCode: args.locationCode,
    languageCode,
  })

  const missing = wanted.filter((k) => !volumes.has(k))
  if (missing.length === 0) {
    return { volumes, fetched: 0, requests: 0, costMicros: 0n }
  }

  let requests = 0
  let costMicros: Micros = 0n

  for (let i = 0; i < missing.length; i += VOLUME_BATCH_MAX) {
    const batch = missing.slice(i, i + VOLUME_BATCH_MAX)
    const vol = await fetchVolumeBatch({
      keywords: batch,
      locationCode: args.locationCode,
      live: args.live,
    })

    if (vol.billableRequests > 0) {
      requests += vol.billableRequests
      costMicros += vol.costMicros
      if (args.runId !== undefined) {
        await recordDiscoverySpend(db, {
          runId: args.runId,
          costMicros: vol.costMicros,
          endpoint: vol.endpoint,
          note: `volume batch ${batch.length}kw @ ${args.locationCode}`,
          ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
        })
      }
    }

    /**
     * ==================== NEVER CACHE A MISS ====================
     * This used to cache `no_data` alongside real figures, on the reasoning
     * that the next job should not re-ask. That reasoning was sound when a
     * re-ask meant $0.09 to DataForSEO. Volume now comes from Google Ads or it
     * comes from nowhere, and Google Ads is FREE -- so the only thing this
     * bought was persistence for a failure.
     *
     * The cost of that was measured: run 38 asked at 03:27 while Google Ads
     * was returning nothing, and every one of its 16 keywords was written to
     * the cache as `no_data` with the same 30-DAY TTL as a real measurement.
     * Google Ads had worked at 02:55 and would work again, but those keywords
     * in that market were pinned to null until September -- so the grid showed
     * no volume, and with no volume the Reddit-visits estimate is null too, so
     * a run holding 10 genuine Reddit threads displayed an empty Reddit column.
     * 445 rows were poisoned this way before it was caught.
     *
     * A miss is now simply not written. The next run asks again, for free, and
     * a transient outage costs one run rather than a month.
     * ============================================================
     */
    if (vol.source === 'no_data') {
      for (const row of vol.rows) {
        volumes.set(norm(row.keyword), {
          keyword: row.keyword,
          avgMonthlySearches: null,
          competitionIndex: null,
          competition: null,
          cpcMicros: null,
          lowTopOfPageBidMicros: null,
          highTopOfPageBidMicros: null,
          monthlySearches: [],
          source: vol.source,
          geoTarget: vol.geoTarget,
        })
      }
      continue
    }

    await writeVolumes(db, {
      locationCode: args.locationCode,
      languageCode,
      source: vol.source,
      geoTarget: vol.geoTarget,
      rows: vol.rows,
      requested: batch,
    })

    for (const row of vol.rows) {
      volumes.set(norm(row.keyword), {
        keyword: row.keyword,
        avgMonthlySearches: row.avgMonthlySearches,
        competitionIndex: row.competitionIndex,
        competition: row.competition,
        cpcMicros: row.cpcMicros,
        lowTopOfPageBidMicros: row.lowTopOfPageBidMicros,
        highTopOfPageBidMicros: row.highTopOfPageBidMicros,
        monthlySearches: row.monthlySearches ?? [],
        source: vol.source,
        geoTarget: vol.geoTarget,
      })
    }
  }

  return { volumes, fetched: missing.length, requests, costMicros }
}

/**
 * `ensureKeywordVolumes` with the environment's own conventions applied.
 *
 * ============== WHY THIS EXISTS RATHER THAN MORE CALL SITES ==============
 * Three places used to call `fetchDfsKeywordVolumesFromEnv` directly: the grid
 * backfill, the discovery backfill, and promote. Each of them therefore skipped
 * Google Ads (free), skipped the 30-day cache, and wrote nothing to the ledger
 * -- so DataForSEO billed $0.09 a request and the books never showed it, which
 * is precisely the failure that made a 50x50 run cost $225.
 *
 * They differ from the cache's own signature in two small ways, and this
 * function absorbs both so no caller has to reinvent them:
 *   - `locationCode` may be null, meaning "national US" (DataForSEO 2840);
 *   - `live` was implicit, inherited from LIVE_CALLS_ENABLED.
 * ========================================================================
 */
export async function ensureKeywordVolumesFromEnv(
  db: Database,
  args: {
    keywords: string[]
    /** Null means national US, matching the old direct-call behaviour. */
    locationCode: number | null
    languageCode?: string
    /** Attribute the purchase to a run when there is one. */
    runId?: number
    jobId?: number
    env?: EnvLike
  },
): Promise<EnsureVolumesResult> {
  const locationCode =
    args.locationCode != null && Number.isFinite(args.locationCode) && args.locationCode > 0
      ? Math.trunc(args.locationCode)
      : DFS_VOLUME_LOCATION_US

  return ensureKeywordVolumes(db, {
    keywords: args.keywords,
    locationCode,
    live: liveCallsEnabled(args.env ?? process.env),
    ...(args.languageCode === undefined ? {} : { languageCode: args.languageCode }),
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
  })
}
