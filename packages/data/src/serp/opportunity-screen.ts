import 'server-only'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  PRICE,
  expandServiceIntentKeywords,
  selectKeywords,
  scoreLeadGenNiche,
  scoreRedditLeadOpportunity,
  totalRedditVolume,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  discoveryHits,
  discoveryRuns,
  discoverySerpMetrics,
  localities,
  niches,
  researchGeos,
  researchKeywordImports,
  researchKeywords,
  type NicheRow,
} from '../schema.js'
import { ensureKeywordVolumesFromEnv } from './keyword-volume-cache.js'
import { liveCallsEnabled } from '../providers/index.js'
import { fetchKeywordIdeas } from '../providers/google-ads/keyword-ideas.js'
import { googleAdsGeoIdsForLocation } from '../providers/google-ads/keyword-volume.js'
import {
  DEFAULT_BULK_TOP_GEOS,
  DEFAULT_BULK_TOP_KEYWORDS,
  enqueueCatalogBulkResearch,
  type ResearchEnqueuePreview,
} from './catalog-research.js'
import type { ResearchDevice } from './run-discovery.js'
import type { DiscoveryRun } from '../schema.js'

/**
 * Stage 1 screen (free) + Stage 2 deep-dive enqueue + opportunity grid.
 */

export interface ScreenKeywordRow {
  id: number
  keyword: string
  volume: number | null
  competition: string | null
  variant: string
  nicheId: number | null
}

export interface ScreenGeoRow {
  id: number
  market: string
  stateAbbr: string | null
  selectedRank: number | null
  population2025: number | null
  dataforseoLocationCode: number | null
  localityId: number | null
}

export interface ScreenBoard {
  keywords: ScreenKeywordRow[]
  geos: ScreenGeoRow[]
  keywordTotal: number
  geoPurchasableTotal: number
  defaultTopKeywordIds: number[]
  defaultTopGeoIds: number[]
}

export async function getOpportunityScreenBoard(
  db: Database,
  opts?: { keywordLimit?: number; geoLimit?: number },
): Promise<ScreenBoard> {
  // Full seeded catalog (hundreds of primary keywords + 200 markets).
  const kwLimit = opts?.keywordLimit ?? 2000
  const geoLimit = opts?.geoLimit ?? 250

  // Catalog is names-only (avg_monthly_searches null). Sort A–Z; Google Ads fills volume on deep dive.
  const keywords = await db
    .select({
      id: researchKeywords.id,
      keyword: researchKeywords.keyword,
      volume: researchKeywords.avgMonthlySearches,
      competition: researchKeywords.competition,
      variant: researchKeywords.variant,
      nicheId: researchKeywords.nicheId,
    })
    .from(researchKeywords)
    .where(and(eq(researchKeywords.active, true), eq(researchKeywords.variant, 'primary')))
    .orderBy(asc(researchKeywords.keyword))
    .limit(kwLimit)

  const geos = await db
    .select({
      id: researchGeos.id,
      market: researchGeos.market,
      stateAbbr: researchGeos.stateAbbr,
      selectedRank: researchGeos.selectedRank,
      population2025: researchGeos.population2025,
      dataforseoLocationCode: researchGeos.dataforseoLocationCode,
      localityId: researchGeos.localityId,
    })
    .from(researchGeos)
    .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))
    .orderBy(asc(researchGeos.selectedRank), desc(researchGeos.population2025), asc(researchGeos.market))
    .limit(geoLimit)

  const [kwCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(researchKeywords)
    .where(and(eq(researchKeywords.active, true), eq(researchKeywords.variant, 'primary')))

  const [geoCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(researchGeos)
    .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))

  return {
    keywords,
    geos,
    keywordTotal: kwCount?.n ?? 0,
    geoPurchasableTotal: geoCount?.n ?? 0,
    defaultTopKeywordIds: keywords.slice(0, DEFAULT_BULK_TOP_KEYWORDS).map((k) => k.id),
    defaultTopGeoIds: geos.slice(0, DEFAULT_BULK_TOP_GEOS).map((g) => g.id),
  }
}

export interface DeepDiveCostPreview {
  keywordCount: number
  geoCount: number
  devices: string[]
  jobCount: number
  estimatedCostMicros: bigint
  estimatedCostUsd: number
  usedFixtures: boolean
  hardCap: number
  truncated: boolean
  selectionNote: string | null
  defaultBudgetCapCents: number
  requiresLongLivedWorker: boolean
  maxLiveSpendUnderHardCapUsd: number
}

/** Pure cost math for UI (also used when DB preview not needed). */
export function estimateDeepDiveCost(args: {
  keywordCount: number
  geoCount: number
  devices: number
  includeNearMe?: boolean
  usedFixtures?: boolean
  hardCap?: number
}): DeepDiveCostPreview {
  const variants = args.includeNearMe ? 2 : 1
  const hardCap = args.hardCap ?? 5000
  let kw = Math.max(0, args.keywordCount)
  let geo = Math.max(0, args.geoCount)
  let jobCount = kw * variants * geo * args.devices
  let truncated = false
  let selectionNote: string | null = null

  if (jobCount > hardCap && kw > 0 && geo > 0) {
    const origKw = kw
    const origGeo = geo
    while (kw * variants * geo * args.devices > hardCap && kw > 1) kw -= 1
    while (kw * variants * geo * args.devices > hardCap && geo > 1) geo -= 1
    jobCount = kw * variants * geo * args.devices
    truncated = true
    selectionNote = `truncated to ${kw} kw × ${geo} geo to fit hard cap ${hardCap} (was ${origKw}×${origGeo})`
  }

  const usedFixtures = args.usedFixtures ?? false
  const estimatedCostMicros = usedFixtures ? 0n : BigInt(jobCount) * PRICE.serpOrganicLive
  const estimatedCostUsd = Number(estimatedCostMicros) / 1_000_000
  const estimateCents = Math.ceil(estimatedCostUsd * 100)
  const defaultBudgetCapCents = usedFixtures ? 0 : Math.max(1000, estimateCents)

  return {
    keywordCount: kw,
    geoCount: geo,
    devices: args.devices === 2 ? ['desktop', 'mobile'] : ['desktop'],
    jobCount,
    estimatedCostMicros,
    estimatedCostUsd,
    usedFixtures,
    hardCap,
    truncated,
    selectionNote,
    defaultBudgetCapCents,
    requiresLongLivedWorker: jobCount > 50 && !usedFixtures,
    maxLiveSpendUnderHardCapUsd: (hardCap * Number(PRICE.serpOrganicLive)) / 1_000_000,
  }
}


/**
 * Google Ads geo criterion ids for the markets a run is about.
 *
 * Discovery is only worth doing if it is asked about the right place: the
 * phrasing people use for a service is local, which is the entire reason the
 * template failed. Capped because the ideas endpoint takes a list and a
 * 50-market sweep would otherwise ask about the whole country at once, which
 * averages the vernacular back out.
 */
async function geoTargetsForDiscovery(
  db: Database,
  geoIds: number[] | undefined,
  max = 10,
): Promise<number[]> {
  if (!geoIds?.length) return []
  const rows = await db
    .select({
      code: researchGeos.dataforseoLocationCode,
      source: researchGeos.locationSource,
      rank: researchGeos.selectedRank,
    })
    .from(researchGeos)
    .where(and(eq(researchGeos.active, true), inArray(researchGeos.id, geoIds)))
    .orderBy(asc(researchGeos.selectedRank))
    .limit(max)

  const ids = new Set<number>()
  for (const r of rows) {
    for (const id of googleAdsGeoIdsForLocation({
      locationCode: r.code,
      locationSource: r.source,
    })) {
      ids.add(id)
    }
  }
  return [...ids]
}

/** Default heads per niche on niche×market deep dive (cost control). */
export const DEFAULT_KEYWORDS_PER_NICHE = 8

/**
 * Expand selected niches into research_keyword IDs (upsert names + nicheId).
 * Prefer primary heads (skip "near me" by default) so volume is commercial.
 */
export async function resolveKeywordIdsForNiches(
  db: Database,
  nicheIds: number[],
  opts?: {
    maxPerNiche?: number
    includeNearMe?: boolean
    /**
     * Ask Google Ads what people actually search, instead of expanding a
     * template. Scoped to these geo criterion ids -- the markets the run is
     * about -- so the phrasing is the one used there.
     */
    discoverWithGeoIds?: number[]
  },
): Promise<{
  keywordIds: number[]
  nicheCount: number
  keywordsPerNiche: number
  /** Per niche: what discovery chose, and what it threw away. */
  discovery: Array<{
    nicheSlug: string
    source: 'google_ads' | 'template'
    selected: Array<{ keyword: string; volume: number | null }>
    rejected: number
    note: string | null
  }>
}> {
  const maxPer = opts?.maxPerNiche ?? DEFAULT_KEYWORDS_PER_NICHE
  const includeNearMe = opts?.includeNearMe === true

  const nicheRows = await db
    .select()
    .from(niches)
    .where(and(eq(niches.active, true), inArray(niches.id, nicheIds)))

  if (nicheRows.length === 0) {
    return { keywordIds: [], nicheCount: 0, keywordsPerNiche: maxPer, discovery: [] }
  }

  // Synthetic import id for seed-from-niche upserts (reuse latest seed import or 0).
  // research_keywords.import_id is NOT NULL FK — need a real import row.
  let importId: number
  const [imp] = await db
    .insert(researchKeywordImports)
    .values({
      sourceFilename: 'niche-expand',
      sourceKind: 'niche_cluster',
      rowCount: 0,
      skippedCount: 0,
    })
    .returning({ id: researchKeywordImports.id })
  importId = imp!.id

  const keywordIds: number[] = []
  const seen = new Set<string>()
  const discovery: Array<{
    nicheSlug: string
    source: 'google_ads' | 'template'
    selected: Array<{ keyword: string; volume: number | null }>
    rejected: number
    note: string | null
  }> = []

  for (const n of nicheRows) {
    let heads = expandServiceIntentKeywords(
      {
        slug: n.slug,
        label: n.label,
        keywordNoun: n.keywordNoun,
        category: n.category,
      },
      { max: includeNearMe ? maxPer : maxPer * 2 },
    )
    if (!includeNearMe) {
      heads = heads.filter((h) => !/\s+near me\s*$/i.test(h)).slice(0, maxPer)
    } else {
      heads = heads.slice(0, maxPer)
    }
    // Always include the seed noun first.
    if (!heads.includes(n.keywordNoun.toLowerCase())) {
      heads = [n.keywordNoun.toLowerCase(), ...heads].slice(0, maxPer)
    }

    /**
     * ==================== ASK, DO NOT GUESS ====================
     * The template above is a cross product of {niche} x {intent modifier}. It
     * produced "bathroom remodeling installation" and "bathroom remodeling
     * repair", which have no volume anywhere -- measured across runs 37+, only
     * 31% of the geo-explicit keywords it generated had ANY demand behind them,
     * and 115 of 256 SERPs were bought for queries nobody types.
     *
     * Google Ads answers the same question from data, for free, scoped to the
     * markets being swept. For "bathroom remodeling" in Chicago it returns
     * "bathroom remodel contractors" (1,300) and "tub to shower conversion"
     * (90) -- one a phrasing the template got wrong, the other a service line
     * no rule would have produced.
     *
     * The template stays as the fallback. Discovery being unavailable must cost
     * a worse keyword list, never a run.
     * ===========================================================
     */
    let source: 'google_ads' | 'template' = 'template'
    let note: string | null = null
    let selectedForNiche: Array<{ keyword: string; volume: number | null }> = []
    let rejectedCount = 0

    if (opts?.discoverWithGeoIds?.length) {
      const seeds = [n.keywordNoun, n.label].filter(Boolean) as string[]
      const res = await fetchKeywordIdeas(seeds, {
        geoTargetCriteriaIds: opts.discoverWithGeoIds,
      })
      if (res.source === 'google_ads' && res.ideas.length > 0) {
        const picked = selectKeywords(
          res.ideas.map((i) => ({ keyword: i.keyword, avgMonthlySearches: i.avgMonthlySearches })),
          {
            limit: maxPer,
            // The head term rides along so two runs of one niche stay comparable.
            alwaysInclude: [n.keywordNoun.toLowerCase()],
          },
        )
        if (picked.keywords.length > 0) {
          heads = picked.keywords.map((k) => k.toLowerCase())
          source = 'google_ads'
          selectedForNiche = picked.selected.map((sk) => ({
            keyword: sk.keyword,
            volume: sk.avgMonthlySearches,
          }))
          rejectedCount = picked.rejected.length
        } else {
          note = 'discovery returned ideas but none cleared the intent or volume floor'
        }
      } else {
        note = res.error ?? 'discovery returned nothing'
      }
    }

    discovery.push({ nicheSlug: n.slug, source, selected: selectedForNiche, rejected: rejectedCount, note })

    for (const raw of heads) {
      const keyword = raw.trim().toLowerCase().replace(/\s+/g, ' ')
      if (!keyword || seen.has(keyword)) continue
      seen.add(keyword)
      const keywordNorm = keyword
      const variant = /\s+near me\s*$/i.test(keyword) ? 'near_me' : 'primary'
      const seedKey = variant === 'near_me' ? keyword.replace(/\s+near me\s*$/i, '').trim() : keyword

      const [row] = await db
        .insert(researchKeywords)
        .values({
          importId,
          keyword,
          keywordNorm,
          seedKey,
          variant,
          avgMonthlySearches: null,
          nicheId: n.id,
          active: true,
        })
        .onConflictDoUpdate({
          target: researchKeywords.keywordNorm,
          set: {
            active: true,
            nicheId: n.id,
            updatedAt: new Date(),
          },
        })
        .returning({ id: researchKeywords.id })

      if (row) keywordIds.push(row.id)
    }
  }

  return {
    keywordIds,
    nicheCount: nicheRows.length,
    keywordsPerNiche: maxPer,
    discovery,
  }
}

export async function previewOpportunityDeepDive(
  db: Database,
  args: {
    keywordIds?: number[]
    nicheIds?: number[]
    geoIds?: number[]
    devices?: ResearchDevice[]
    includeNearMe?: boolean
    /**
     * Ask Google Ads which keywords a market actually searches, rather than
     * expanding the template. On by default: the template's keywords were 31%
     * real on the geo-explicit variant, and asking costs nothing.
     */
    discoverKeywords?: boolean
    maxKeywordsPerNiche?: number
    /** Also measure "<keyword> <city>". See discoveryRuns.includeGeoExplicit. */
    includeGeoExplicit?: boolean
    /** Paid extras, off unless asked for. See discoveryRuns in schema.ts. */
    fetchVolume?: boolean
    fetchMaps?: boolean
  },
): Promise<
  DeepDiveCostPreview & {
    preview: ResearchEnqueuePreview
    nicheCount?: number
    keywordsPerNiche?: number
  }
> {
  const devices = args.devices?.length ? args.devices : (['desktop'] as ResearchDevice[])
  let keywordIds = args.keywordIds
  let nicheCount: number | undefined
  let keywordsPerNiche: number | undefined
  let discovery: Awaited<ReturnType<typeof resolveKeywordIdsForNiches>>['discovery'] = []

  if (args.nicheIds?.length) {
    const resolved = await resolveKeywordIdsForNiches(db, args.nicheIds, {
      maxPerNiche: args.maxKeywordsPerNiche,
      includeNearMe: args.includeNearMe,
      discoverWithGeoIds:
        args.discoverKeywords === false
          ? []
          : await geoTargetsForDiscovery(db, args.geoIds),
    })
    keywordIds = resolved.keywordIds
    nicheCount = resolved.nicheCount
    keywordsPerNiche = resolved.keywordsPerNiche
    discovery = resolved.discovery
  }

  const { preview } = await enqueueCatalogBulkResearch(db, {
    keywordIds,
    geoIds: args.geoIds,
    devices,
    includeNearMe: false, // already expanded
    includeGeoExplicit: args.includeGeoExplicit === true,
    fetchVolume: args.fetchVolume === true,
    fetchMaps: args.fetchMaps === true,
    dryRun: true,
    autoTruncate: true,
  })

  /**
   * Say where the keywords came from, in the preview, before anything is spent.
   * A sweep of eight invented phrases and a sweep of the eight most-searched
   * ones cost the same and look identical on a cost line.
   */
  const discovered = discovery.filter((d) => d.source === 'google_ads')
  const topPicks = discovered
    .flatMap((d) => d.selected)
    .filter((k) => k.volume != null)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 3)
    .map((k) => `${k.keyword} (${k.volume})`)

  const noteParts = [
    nicheCount != null ? `${nicheCount} niches × ~${keywordsPerNiche} kw` : null,
    discovery.length > 0
      ? `keywords: ${discovered.length}/${discovery.length} niches from Google Ads` +
        (topPicks.length > 0 ? ` — top: ${topPicks.join(', ')}` : '')
      : null,
    discovery.find((d) => d.source === 'template' && d.note)
      ? `template fallback used (${discovery.find((d) => d.source === 'template' && d.note)?.note})`
      : null,
    preview.selectionNote,
  ].filter(Boolean)

  return {
    keywordCount: preview.keywordCount,
    geoCount: preview.geoCount,
    devices: preview.devices,
    jobCount: preview.jobCount,
    estimatedCostMicros: preview.estimatedCostMicros,
    estimatedCostUsd: Number(preview.estimatedCostMicros) / 1_000_000,
    usedFixtures: preview.usedFixtures,
    hardCap: preview.hardCap,
    truncated: preview.truncated,
    selectionNote: noteParts.join(' · ') || null,
    defaultBudgetCapCents: preview.defaultBudgetCapCents,
    requiresLongLivedWorker: preview.requiresLongLivedWorker,
    maxLiveSpendUnderHardCapUsd: Number(preview.maxLiveSpendUnderHardCapMicros) / 1_000_000,
    preview,
    nicheCount,
    keywordsPerNiche,
  }
}

export async function startOpportunityDeepDive(
  db: Database,
  args: {
    keywordIds?: number[]
    nicheIds?: number[]
    geoIds?: number[]
    devices?: ResearchDevice[]
    includeNearMe?: boolean
    /**
     * Ask Google Ads which keywords a market actually searches, rather than
     * expanding the template. On by default: the template's keywords were 31%
     * real on the geo-explicit variant, and asking costs nothing.
     */
    discoverKeywords?: boolean
    maxKeywordsPerNiche?: number
    /** Also measure "<keyword> <city>". See discoveryRuns.includeGeoExplicit. */
    includeGeoExplicit?: boolean
    /** Paid extras, off unless asked for. See discoveryRuns in schema.ts. */
    fetchVolume?: boolean
    fetchMaps?: boolean
    /**
     * Buy SERPs through the queue: $0.0006 rather than $0.0020, at the cost of
     * results arriving in minutes instead of seconds.
     */
    useQueuedSerp?: boolean
    budgetCapCents?: number
    workerAck?: boolean
  },
): Promise<{ preview: ResearchEnqueuePreview; run: DiscoveryRun }> {
  const devices = args.devices?.length ? args.devices : (['desktop'] as ResearchDevice[])
  let keywordIds = args.keywordIds
  let nicheCount = 0

  if (args.nicheIds?.length) {
    const resolved = await resolveKeywordIdsForNiches(db, args.nicheIds, {
      maxPerNiche: args.maxKeywordsPerNiche,
      includeNearMe: args.includeNearMe,
      discoverWithGeoIds:
        args.discoverKeywords === false
          ? []
          : await geoTargetsForDiscovery(db, args.geoIds),
    })
    keywordIds = resolved.keywordIds
    nicheCount = resolved.nicheCount
  }

  const label =
    nicheCount > 0
      ? `Niche×market deep dive · ${nicheCount} niches × ${devices.join('+')}`
      : `Opportunity deep dive · top selection × ${devices.join('+')}`

  const { preview, run } = await enqueueCatalogBulkResearch(db, {
    keywordIds,
    geoIds: args.geoIds,
    devices,
    includeNearMe: false,
    includeGeoExplicit: args.includeGeoExplicit === true,
    fetchVolume: args.fetchVolume === true,
    fetchMaps: args.fetchMaps === true,
    useQueuedSerp: args.useQueuedSerp === true,
    dryRun: false,
    autoTruncate: true,
    budgetCapCents: args.budgetCapCents,
    label,
  })
  if (!run) throw new Error('Deep dive enqueue returned no run.')
  if (preview.requiresLongLivedWorker && !args.workerAck && !preview.usedFixtures) {
    // Still allow — cron multi-drain handles bulk; ack is UX only when live large.
  }
  return { preview, run }
}

function microsToNumber(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'bigint' ? Number(v) : v
}

export interface OpportunityGridRow {
  /**
   * The measurement this row IS.
   *
   * researchKeywordId + researchGeoId does not identify a row: the geo-explicit
   * variant reuses the primary's keyword row, and each pair is measured once per
   * device. The metrics id is the only stable handle, and it is what the
   * per-keyword detail page is addressed by.
   */
  metricId: number
  jobId: number
  researchKeywordId: number
  researchGeoId: number
  keyword: string
  /**
   * Groups keyword variations that describe the same service.
   *
   * Carried on the row so the grid can collapse "fire damage restoration",
   * "fire damage repair" and "smoke damage restoration" into one niche x market
   * cell when no niche has been matched to them yet.
   */
  seedKey: string
  /** `primary` for the seed query, otherwise the variation label. */
  variant: string
  /** Exact SERP query string (same as purchased). */
  exactQuery: string
  /**
   * Google Ads measured avg monthly searches for the exact query (geo-scoped when possible).
   * Never catalog import volume — that figure is untrusted.
   */
  volume: number | null
  volumeSource: string | null
  volumeGeoTarget: string | null
  market: string
  stateAbbr: string | null
  /**
   * Google's geotarget name for this market (DataForSEO `location_name`) --
   * what the SERP was actually measured against, and the only string a UULE
   * verification link can be built from safely. See buildLocalSerpLinks.
   */
  geoTargetName: string | null
  /**
   * How a person in this market actually types the location ("new york city").
   * Curated per market on import, because reconstructing it from the market name
   * is wrong exactly where it matters -- ambiguous markets like Springfield.
   */
  queryModifier: string | null
  selectedRank: number | null
  device: string
  redditHitCount: number
  bestRedditAbsoluteRank: number | null
  bestRedditSource: string | null
  commentable: boolean | null
  /** Paid search ads above first organic (excludes LSA). */
  adsAboveOrganic: number
  /** Local pack containers above organic (legacy). */
  localAboveOrganic: number
  firstOrganicRankAbsolute: number | null
  discussionsPackPresent: boolean
  mapPresent: boolean
  mapRankAbsolute: number | null
  /** Local Services Ads (≠ paid search). */
  lsaCount: number
  lsaAboveOrganic: number
  lsaRankAbsolute: number | null
  localBusinessCount: number
  localBusinessAboveOrganic: number
  localPackRankAbsolute: number | null
  forumsCount: number
  forumsRankAbsolute: number | null
  sponsoredAboveOrganic: number
  paidCount: number
  monthlySearches: Array<{ year: number; month: number; searchVolume: number }> | null
  serpCompetitionIndex: number | null
  serpCompetition: string | null
  cpcMicros: number | null
  lowTopOfPageBidMicros: number | null
  highTopOfPageBidMicros: number | null
  topOrganicDomains: Array<{ domain: string; rankAbsolute: number }> | null
  gbpLeaders: Array<{
    title: string
    domain: string | null
    rating: number | null
    reviewsCount: number | null
    rankAbsolute: number | null
  }> | null
  hasAiOverview: boolean
  hasPeopleAlsoAsk: boolean
  mapsEntryCount: number | null
  mapsDomains: string[] | null
  mapsKeyword: string | null
  opportunityScore: number | null
  opportunityReasons: string[]
  /**
   * SERP winnability. Null means NOT COMPUTED, never "easy" -- a null must
   * render as an em dash and sort LAST in an easiest-first table.
   */
  /**
   * Estimated monthly searches landing on a Reddit thread for this cell.
   * Null = volume was never measured, which is not the same as no audience.
   */
  redditVisits: number | null
  /** Best organic position any Reddit thread held here. */
  redditBestPosition: number | null
  difficulty: number | null
  weightCovered: number | null
  slotsOpen: number | null
  platformHeldSlots: number | null
  medianRefDomains: number | null
  linkDataMeasured: boolean | null
  /** Verdict assuming a freshly REGISTERED exact-match domain. */
  verdictEmd: string | null
  /** Verdict assuming an ACQUIRED domain -- availability is not a constraint. */
  verdictAcquired: string | null
  blockersAcquired: Array<{ code: string; message: string }> | null
  emdDomain: string | null
  emdAvailable: boolean | null
  measuredAt: string | null
  runId: number | null
  runStatus: string | null
  /** When resolved, row can open /markets/{localitySlug}/{nicheSlug}. */
  localitySlug: string | null
  /** Market centroid, for a coordinate UULE Google honours. */
  lat: number | null
  lon: number | null
  nicheSlug: string | null
  localityId: number | null
  nicheId: number | null
  marketHref: string | null
  /** Lead economics from matched niche (priors or calibrated). */
  avgTicketMicros: number | null
  leadValueMicros: number | null
  competitionIndex: number | null
}

/**
 * Latest desktop metrics per catalog keyword × geo with Reddit opportunity score.
 * Volume = Google Ads measured on the exact query only (never CSV import).
 */
export async function listOpportunityGrid(
  db: Database,
  opts?: {
    limit?: number
    device?: 'desktop' | 'mobile'
    /**
     * Scope to a single deep-dive run.
     *
     * ==================== WHY THIS CHANGES THE SHAPE ====================
     * Unscoped, this is a "current best picture" view: newest metric per
     * keyword×geo across every run, desktop only, so one cell appears once no
     * matter how often it was measured. That is the wrong answer for "show me
     * what run #17 bought" -- there you want THAT run's rows, both devices,
     * including cells a later run has since re-measured. So scoping by run also
     * turns off the cross-run collapse and the desktop-only default.
     * ==================================================================
     */
    runId?: number
  },
): Promise<OpportunityGridRow[]> {
  const limit = opts?.limit ?? 500
  const runId = opts?.runId
  const device = opts?.device

  const metrics = await db
    .select({
      metric: discoverySerpMetrics,
      runStatus: discoveryRuns.status,
    })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoverySerpMetrics.runId))
    .where(
      and(
        isNotNull(discoverySerpMetrics.researchKeywordId),
        isNotNull(discoverySerpMetrics.researchGeoId),
        // Unscoped keeps the historical desktop-only default; a run shows both.
        device ? eq(discoverySerpMetrics.device, device) : undefined,
        runId === undefined ? eq(discoverySerpMetrics.device, 'desktop') : undefined,
        runId === undefined ? undefined : eq(discoverySerpMetrics.runId, runId),
      ),
    )
    .orderBy(desc(discoverySerpMetrics.measuredAt))
    .limit(runId === undefined ? limit * 4 : limit)

  const best = new Map<string, (typeof metrics)[0]>()
  for (const row of metrics) {
    /**
     * Within one run a cell is measured once per device, so device is part of
     * the identity; across runs we deliberately collapse to the newest.
     *
     * ==================== VARIANT IS PART OF THE IDENTITY ====================
     * `keywordVariant` belongs here because geo_explicit reuses the PRIMARY's
     * research_keywords row -- unlike near_me, which has its own. Without it
     * "plumber" and "plumber new york city" hash to the same cell, and since
     * the geo-explicit row is measured second it evicted the primary outright:
     * the grid showed one row reading "Google Ads vol 2900" for a cell that
     * also held 18,100, and the rank-and-rent signal the primary exists to
     * carry vanished the moment the toggle was switched on.
     *
     * A feature that silently deletes the measurement it was added to sit
     * BESIDE is worse than one that does nothing.
     * ========================================================================
     */
    const variant = row.metric.keywordVariant ?? 'primary'
    const k =
      runId === undefined
        ? `${row.metric.researchKeywordId}:${row.metric.researchGeoId}:${variant}`
        : `${row.metric.researchKeywordId}:${row.metric.researchGeoId}:${variant}:${row.metric.device}`
    if (!best.has(k)) best.set(k, row)
  }

  const pairs = [...best.values()].slice(0, limit)
  if (pairs.length === 0) return []

  // Backfill Google Ads volumes for metrics that never stored one (old runs / import not used).
  await ensureCatalogMetricVolumes(db, pairs.map((p) => p.metric))

  // Re-read metrics after possible volume backfill (ids stable).
  const metricIds = pairs.map((p) => p.metric.id)
  const refreshed =
    metricIds.length === 0
      ? []
      : await db
          .select()
          .from(discoverySerpMetrics)
          .where(inArray(discoverySerpMetrics.id, metricIds))
  const refreshedMap = new Map(refreshed.map((m) => [m.id, m]))

  const kwIds = [...new Set(pairs.map((p) => p.metric.researchKeywordId!))]
  const geoIds = [...new Set(pairs.map((p) => p.metric.researchGeoId!))]
  const jobIds = pairs.map((p) => p.metric.jobId)

  /**
   * Active only. Without this, deactivating a keyword left every cell it had
   * already measured sitting in the grid forever -- so retiring a bad keyword
   * did nothing, and the row loop's `if (!kw) continue` is what makes it work.
   */
  const kws = await db
    .select()
    .from(researchKeywords)
    .where(and(inArray(researchKeywords.id, kwIds), eq(researchKeywords.active, true)))
  const geos = await db.select().from(researchGeos).where(inArray(researchGeos.id, geoIds))
  const kwMap = new Map(kws.map((k) => [k.id, k]))
  const geoMap = new Map(geos.map((g) => [g.id, g]))

  const localityIds = [
    ...new Set(geos.map((g) => g.localityId).filter((id): id is number => id != null)),
  ]
  const nicheIds = [
    ...new Set(kws.map((k) => k.nicheId).filter((id): id is number => id != null)),
  ]

  const locRows =
    localityIds.length === 0
      ? []
      : await db
          .select({
            id: localities.id,
            slug: localities.slug,
            lat: localities.lat,
            lon: localities.lon,
          })
          .from(localities)
          .where(inArray(localities.id, localityIds))
  const allNichesEco = await db
    .select({
      id: niches.id,
      slug: niches.slug,
      keywordNoun: niches.keywordNoun,
      keywordAliases: niches.keywordAliases,
      leadValueMicros: niches.leadValueMicros,
      gadsCompetitionIndex: niches.gadsCompetitionIndex,
      avgTicketMicros: niches.avgTicketMicros,
    })
    .from(niches)
    .where(eq(niches.active, true))

  const locSlugById = new Map(locRows.map((l) => [l.id, l.slug]))
  /**
   * Coordinates drive the UULE on the Live SERP links. Without them the link
   * falls back to a place-name UULE that Google ignores, so the operator ends up
   * verifying against their own city. See buildLocalSerpLinks in @rnr/core.
   */
  const locCoordsById = new Map(locRows.map((l) => [l.id, { lat: l.lat, lon: l.lon }]))
  const nicheById = new Map(allNichesEco.map((n) => [n.id, n]))
  const allNichesForMatch = allNichesEco

  const hits =
    jobIds.length === 0
      ? []
      : await db
          .select({
            jobId: discoveryHits.jobId,
            rankAbsolute: discoveryHits.rankAbsolute,
            /** The organic CTR curve needs an ORGANIC rank, not an absolute one. */
            organicPosition: discoveryHits.organicPosition,
            sourceKind: discoveryHits.sourceKind,
            commentable: discoveryHits.commentable,
          })
          .from(discoveryHits)
          .where(inArray(discoveryHits.jobId, jobIds))

  const hitsByJob = new Map<number, typeof hits>()
  for (const h of hits) {
    const list = hitsByJob.get(h.jobId) ?? []
    list.push(h)
    hitsByJob.set(h.jobId, list)
  }

  const out: OpportunityGridRow[] = []
  for (const row of pairs) {
    const m = refreshedMap.get(row.metric.id) ?? row.metric
    const kw = kwMap.get(m.researchKeywordId!)
    const geo = geoMap.get(m.researchGeoId!)
    if (!kw || !geo) continue

    const jobHits = hitsByJob.get(m.jobId) ?? []
    let bestRank: number | null = m.bestRedditRankAbsolute ?? null
    let bestSource: string | null = null
    let commentable: boolean | null = null
    for (const h of jobHits) {
      if (h.rankAbsolute !== null && (bestRank === null || h.rankAbsolute < bestRank)) {
        bestRank = h.rankAbsolute
        bestSource = h.sourceKind
        commentable = h.commentable
      } else if (bestSource == null && h.rankAbsolute === bestRank) {
        bestSource = h.sourceKind
        commentable = h.commentable
      }
    }

    /**
     * Estimated monthly visits reaching a Reddit thread on THIS query.
     *
     * Volume x CTR at the position the best thread holds. Computed per cell so
     * the grouping can sum it across distinct keywords exactly the way it sums
     * volume -- one keyword measured on two devices must not count twice.
     */
    const redditVisits = totalRedditVolume(
      jobHits.map((h) => ({
        keyword: m.keyword,
        volume: m.avgMonthlySearches,
        organicPosition: h.organicPosition,
        rankAbsolute: h.rankAbsolute,
        fromPack: h.sourceKind !== 'organic',
      })),
    )

    // Measured Google Ads only — never catalog import avg_monthly_searches.
    const measuredVol = m.avgMonthlySearches
    const volumeSource = m.volumeSource
    const exactQuery = (m.keyword || kw.keyword).trim()

    const localityId = geo.localityId ?? m.localityId
    const localitySlug = localityId != null ? (locSlugById.get(localityId) ?? null) : null
    const coords = localityId != null ? locCoordsById.get(localityId) : undefined

    let nicheId = kw.nicheId ?? m.nicheId
    let nicheSlug: string | null = null
    let nicheEco = nicheId != null ? nicheById.get(nicheId) : undefined
    if (nicheSlug == null || !nicheEco) {
      const matched = matchNicheByKeyword(exactQuery || kw.keyword, allNichesForMatch)
      if (matched) {
        nicheId = matched.id
        nicheSlug = matched.slug
        nicheEco = matched
      }
    } else {
      nicheSlug = nicheEco.slug
    }

    const scored = scoreRedditLeadOpportunity({
      volume: measuredVol,
      volumeSource,
      bestRedditAbsoluteRank: bestRank,
      redditOnPage1: m.redditHitCount > 0 || bestRank !== null,
      commentable,
      adsAboveOrganic: m.adsAboveOrganicCount,
      localAboveOrganic: m.localProfilesAboveOrganicCount,
      // Was hardcoded null, so the grid's score had zero SERP-competitiveness
      // input. Difficulty enters as a divisor clamped at 0.15, so wiring it up
      // materially re-orders the grid -- which is the point.
      difficulty: m.difficulty,
      discussionsPackPresent: m.discussionsPackPresent,
      bestRedditSource:
        bestSource === 'discussions_and_forums' || bestSource === 'organic'
          ? bestSource
          : null,
      leadValueMicros: nicheEco?.leadValueMicros ?? null,
      competitionIndex: nicheEco?.gadsCompetitionIndex ?? null,
    })

    const marketHref =
      localitySlug && nicheSlug ? `/markets/${localitySlug}/${nicheSlug}` : null

    out.push({
      metricId: m.id,
      jobId: m.jobId,
      researchKeywordId: kw.id,
      seedKey: kw.seedKey,
      variant: kw.variant,
      researchGeoId: geo.id,
      /**
       * The query actually MEASURED, not the catalog phrase it expanded from.
       *
       * Both live under one research_keywords row, so carrying kw.keyword made
       * "plumber" and "plumber new york city" identical strings. The grouper
       * dedupes volume and Reddit visits by this field, so the two collapsed
       * into one: the grid showed the variation twice as "plumber" and reported
       * 2,900 searches for a cell holding 18,100 + 2,900.
       *
       * Group identity is unaffected -- nicheGroupKey prefers nicheId and only
       * falls back to this -- and seedLabel still titles the group "plumber",
       * because it picks the phrase the siblings are built on top of.
       */
      keyword: exactQuery || kw.keyword,
      exactQuery,
      volume: measuredVol,
      volumeSource,
      volumeGeoTarget: m.volumeGeoTarget,
      market: geo.market,
      stateAbbr: geo.stateAbbr,
      geoTargetName: geo.dataforseoLocationName,
      queryModifier:
        geo.recommendedExplicitModifier?.trim() ||
        geo.naturalQueryModifier?.trim() ||
        null,
      selectedRank: geo.selectedRank,
      device: m.device,
      redditHitCount: m.redditHitCount,
      bestRedditAbsoluteRank: bestRank,
      bestRedditSource: bestSource,
      commentable,
      adsAboveOrganic: m.adsAboveOrganicCount,
      localAboveOrganic: m.localProfilesAboveOrganicCount,
      firstOrganicRankAbsolute: m.firstOrganicRankAbsolute,
      discussionsPackPresent: m.discussionsPackPresent,
      mapPresent: m.mapPresent ?? false,
      mapRankAbsolute: m.mapRankAbsolute ?? null,
      lsaCount: m.lsaCount ?? 0,
      lsaAboveOrganic: m.lsaAboveOrganicCount ?? 0,
      lsaRankAbsolute: m.lsaRankAbsolute ?? null,
      localBusinessCount: m.localBusinessCount ?? 0,
      localBusinessAboveOrganic: m.localBusinessAboveOrganicCount ?? 0,
      localPackRankAbsolute: m.localPackRankAbsolute ?? null,
      forumsCount: m.forumsCount ?? 0,
      forumsRankAbsolute: m.forumsRankAbsolute ?? null,
      sponsoredAboveOrganic: m.sponsoredAboveOrganicCount ?? m.adsAboveOrganicCount,
      paidCount: m.paidCount,
      monthlySearches: m.monthlySearches ?? null,
      serpCompetitionIndex: m.serpCompetitionIndex ?? null,
      serpCompetition: m.serpCompetition ?? null,
      cpcMicros: microsToNumber(m.cpcMicros ?? null),
      lowTopOfPageBidMicros: microsToNumber(m.lowTopOfPageBidMicros ?? null),
      highTopOfPageBidMicros: microsToNumber(m.highTopOfPageBidMicros ?? null),
      topOrganicDomains: m.topOrganicDomains ?? null,
      gbpLeaders: m.gbpLeaders ?? null,
      hasAiOverview: m.hasAiOverview ?? false,
      hasPeopleAlsoAsk: m.hasPeopleAlsoAsk ?? false,
      mapsEntryCount: m.mapsEntryCount ?? null,
      mapsDomains: m.mapsDomains ?? null,
      mapsKeyword: m.mapsKeyword ?? null,
      opportunityScore: scored.score,
      opportunityReasons: scored.reasons,
      redditVisits: redditVisits.visits,
      redditBestPosition: redditVisits.bestPosition,
      difficulty: m.difficulty,
      weightCovered: m.weightCovered,
      slotsOpen: m.slotsOpen,
      platformHeldSlots: m.platformHeldSlots,
      medianRefDomains: m.medianRefDomains,
      linkDataMeasured: m.linkDataMeasured,
      verdictEmd: m.verdictEmd,
      verdictAcquired: m.verdictAcquired,
      blockersAcquired: (m.blockersAcquired ?? null) as
        | Array<{ code: string; message: string }>
        | null,
      emdDomain: m.emdDomain,
      emdAvailable: m.emdAvailable,
      measuredAt: m.measuredAt?.toISOString() ?? null,
      runId: m.runId,
      runStatus: row.runStatus,
      localitySlug,
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      nicheSlug,
      localityId: localityId ?? null,
      nicheId: nicheId ?? null,
      marketHref,
      avgTicketMicros: microsToNumber(nicheEco?.avgTicketMicros ?? null),
      leadValueMicros: microsToNumber(nicheEco?.leadValueMicros ?? null),
      competitionIndex: nicheEco?.gadsCompetitionIndex ?? null,
    })
  }

  out.sort((a, b) => (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1))
  return out
}

/** Soft-map a SERP query to a seeded niche for market cell deep links. */
/**
 * Route a search to the niche it belongs to.
 *
 * ==================== WHY ALIASES EXIST ====================
 * The last rule below needs the WHOLE keyword_noun to appear in the query, and
 * that quietly failed on the most ordinary phrasings there are: "roofers" does
 * not contain "roofing", and "fence installation" does not contain "fence
 * company". Against a 1,273-keyword Keyword Planner export it matched 42.9% of
 * volume; alias matching reaches 84.3% of the same keywords, with no change to
 * the catalog itself.
 *
 * Aliases are DATA on `niches.keyword_aliases`, so closing the next gap is a
 * row rather than a deploy.
 * ===========================================================
 */
function matchNicheByKeyword<
  T extends { id: number; slug: string; keywordNoun: string; keywordAliases?: string[] | null },
>(keyword: string, list: T[]): T | null {
  const k = keyword.trim().toLowerCase()
  if (!k) return null
  const exact = list.find((n) => n.keywordNoun.trim().toLowerCase() === k)
  if (exact) return exact

  // Buy-intent cluster membership (e.g. "ac repair" → hvac-repair).
  for (const n of list) {
    const cluster = expandServiceIntentKeywords({
      slug: n.slug,
      label: n.slug,
      keywordNoun: n.keywordNoun,
    })
    if (cluster.some((c) => c.toLowerCase() === k)) return n
  }

  /**
   * Longest alias or noun contained in the query, either direction.
   *
   * Longest wins so a specific niche beats a general one: "garage floor
   * coating" must not be taken by `flooring-installation` on the strength of
   * "floor" when `garage-floor-coating` matches a longer phrase.
   */
  let best: T | null = null
  let bestLen = 0
  for (const n of list) {
    const candidates = [n.keywordNoun, ...(n.keywordAliases ?? [])]
    for (const raw of candidates) {
      const term = raw.trim().toLowerCase()
      if (!term) continue
      if ((k.includes(term) || term.includes(k)) && term.length > bestLen) {
        best = n
        bestLen = term.length
      }
    }
  }
  return best
}

/**
 * Persist local search volumes onto catalog metric rows missing them.
 * Uses DataForSEO Keywords Data (Google Ads metrics) with the row's location_code
 * — same geo family as organic/map-pack SERP. Groups by location_code to batch.
 */
async function ensureCatalogMetricVolumes(
  db: Database,
  metrics: Array<{
    id: number
    keyword: string
    locationCode: number
    volumeSource: string | null
    avgMonthlySearches: number | null
  }>,
): Promise<void> {
  const missing = metrics.filter((m) => m.volumeSource == null || m.volumeSource === '')
  if (missing.length === 0) return

  const byLoc = new Map<number, typeof missing>()
  for (const m of missing) {
    const list = byLoc.get(m.locationCode) ?? []
    list.push(m)
    byLoc.set(m.locationCode, list)
  }

  for (const [locationCode, rows] of byLoc) {
    const uniqueKeywords = [...new Set(rows.map((r) => r.keyword.trim()).filter(Boolean))]
    if (uniqueKeywords.length === 0) continue

    // Google Ads first, then the 30-day cache, and only then DataForSEO --
    // and whatever it does spend now reaches the ledger. This runs on a GRID
    // RENDER, so a direct $0.09 purchase here was both the wrong source and
    // invisible in the books.
    const vol = await ensureKeywordVolumesFromEnv(db, {
      keywords: uniqueKeywords,
      locationCode,
    })

    for (const m of rows) {
      const hit = vol.volumes.get(m.keyword.trim().toLowerCase())
      await db
        .update(discoverySerpMetrics)
        .set({
          avgMonthlySearches: hit?.avgMonthlySearches ?? null,
          // Record the source even on a miss, so the backfill does not re-ask
          // for a keyword the provider genuinely has no data for.
          volumeSource: hit?.source ?? 'no_data',
          volumeGeoTarget: hit?.geoTarget ?? null,
        })
        .where(eq(discoverySerpMetrics.id, m.id))
    }
  }
}

/** Niche economics for pre-geo ranking (ticket, commission, GAds volume). */
export interface NicheEconomicsRow {
  id: number
  slug: string
  label: string
  keywordNoun: string
  category: string
  avgTicketMicros: number | null
  leadCommissionRateBps: number | null
  leadValueMicros: number | null
  economicsSource: string | null
  gadsAvgMonthlySearches: number | null
  gadsCompetitionIndex: number | null
  gadsCompetition: string | null
  gadsTopOfPageBidHighMicros: number | null
  gadsMeasuredAt: string | null
  compositeScore: number | null
  adsFitScore: number | null
  redditPriorityScore: number | null
  scoreReasons: string[]
}

export async function listNicheEconomicsRanked(db: Database): Promise<NicheEconomicsRow[]> {
  const rows = await db.select().from(niches).where(eq(niches.active, true))
  const out: NicheEconomicsRow[] = rows.map((n: NicheRow) => {
    const scored = scoreLeadGenNiche({
      volume: n.gadsAvgMonthlySearches,
      avgTicketMicros: n.avgTicketMicros,
      leadCommissionRateBps: n.leadCommissionRateBps,
      leadValueMicros: n.leadValueMicros,
      competitionIndex: n.gadsCompetitionIndex,
      topOfPageBidHighMicros: n.gadsTopOfPageBidHighMicros,
    })
    return {
      id: n.id,
      slug: n.slug,
      label: n.label,
      keywordNoun: n.keywordNoun,
      category: n.category,
      avgTicketMicros: microsToNumber(n.avgTicketMicros),
      leadCommissionRateBps: n.leadCommissionRateBps,
      leadValueMicros: microsToNumber(n.leadValueMicros),
      economicsSource: n.economicsSource,
      gadsAvgMonthlySearches: n.gadsAvgMonthlySearches,
      gadsCompetitionIndex: n.gadsCompetitionIndex,
      gadsCompetition: n.gadsCompetition,
      gadsTopOfPageBidHighMicros: microsToNumber(n.gadsTopOfPageBidHighMicros),
      gadsMeasuredAt: n.gadsMeasuredAt?.toISOString() ?? null,
      compositeScore: scored.compositeScore,
      adsFitScore: scored.adsFitScore,
      redditPriorityScore: scored.redditPriorityScore,
      scoreReasons: scored.reasons,
    }
  })
  out.sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1))
  return out
}

export async function listRecentDeepDiveRuns(db: Database, limit = 10) {
  return db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.source, 'catalog'))
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(limit)
}

/** One deep-dive run, for its own detail page. NULL when it was deleted. */
export async function getDeepDiveRun(db: Database, runId: number) {
  if (!Number.isInteger(runId) || runId <= 0) return null
  const [run] = await db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.id, runId))
    .limit(1)
  return run ?? null
}

/**
 * Delete a discovery run and cascaded jobs/hits/metrics/niches/geos.
 * Allows re-running the same opportunity selection cleanly.
 */
export async function deleteDiscoveryRun(
  db: Database,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(runId) || runId <= 0) {
    return { ok: false, error: 'Invalid run id.' }
  }
  const [run] = await db
    .select({ id: discoveryRuns.id, status: discoveryRuns.status })
    .from(discoveryRuns)
    .where(eq(discoveryRuns.id, runId))
    .limit(1)
  if (!run) return { ok: false, error: 'Run not found.' }
  // Allow delete for any status (including in-flight) so operators can clear stuck/partial runs.
  await db.delete(discoveryRuns).where(eq(discoveryRuns.id, runId))
  return { ok: true }
}

/**
 * Delete one opportunity cell's latest metrics (catalog keyword × geo) so it can be re-researched.
 * Removes discovery_serp_metrics rows for that pair (all devices/runs) and orphaned hits on those jobs.
 */
export async function deleteOpportunityCellMetrics(
  db: Database,
  args: { researchKeywordId: number; researchGeoId: number },
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const { researchKeywordId, researchGeoId } = args
  if (!Number.isInteger(researchKeywordId) || !Number.isInteger(researchGeoId)) {
    return { ok: false, error: 'Invalid keyword or market id.' }
  }
  const rows = await db
    .delete(discoverySerpMetrics)
    .where(
      and(
        eq(discoverySerpMetrics.researchKeywordId, researchKeywordId),
        eq(discoverySerpMetrics.researchGeoId, researchGeoId),
      ),
    )
    .returning({ id: discoverySerpMetrics.id })
  return { ok: true, deleted: rows.length }
}

/** Bulk-delete opportunity cells (keyword × geo metric rows). */
export async function deleteOpportunityCellsBulk(
  db: Database,
  pairs: Array<{ researchKeywordId: number; researchGeoId: number }>,
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  if (!pairs.length) return { ok: false, error: 'Nothing selected.' }
  let deleted = 0
  // Dedup pairs
  const seen = new Set<string>()
  for (const p of pairs) {
    if (!Number.isInteger(p.researchKeywordId) || !Number.isInteger(p.researchGeoId)) continue
    const key = `${p.researchKeywordId}:${p.researchGeoId}`
    if (seen.has(key)) continue
    seen.add(key)
    const res = await deleteOpportunityCellMetrics(db, p)
    if (res.ok) deleted += res.deleted
  }
  return { ok: true, deleted }
}
