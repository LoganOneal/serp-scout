import 'server-only'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { centsToMicros, estimateDiscoveryCostMicros, PRICE } from '@rnr/core'
import type { Database } from '../db.js'
import {
  researchGeos,
  researchKeywords,
  type DiscoveryRun,
  type ResearchGeo,
  type ResearchKeyword,
} from '../schema.js'
import { liveCallsEnabled } from '../providers/index.js'
import {
  DEFAULT_MAX_JOBS,
  DiscoveryEnqueueError,
  enqueueDiscoveryRun,
  type DiscoveryGeoInput,
  type DiscoveryNicheInput,
  type EnqueuePreview,
  type ResearchDevice,
} from './run-discovery.js'

/**
 * Catalog research: preview / enqueue cell & bulk against research_* tables.
 * Spend only via discovery_jobs + reserveDiscoverySpend.
 */

export const DEFAULT_BULK_TOP_KEYWORDS = 50
export const DEFAULT_BULK_TOP_GEOS = 50

export function researchBulkEnabled(): boolean {
  // Opportunity funnel needs bulk by default; set RESEARCH_BULK_ENABLED=false to hard-block.
  return process.env['RESEARCH_BULK_ENABLED'] !== 'false'
}

export function researchCatalogEnabled(): boolean {
  // Import UI ships with MVP; default true unless explicitly off.
  return process.env['RESEARCH_CATALOG_ENABLED'] !== 'false'
}

export interface ResearchCatalogSummary {
  keywordCount: number
  primaryCount: number
  geoCount: number
  purchasableGeoCount: number
  softMatchedKeywords: number
  softMatchedGeos: number
}

export async function getResearchCatalogSummary(db: Database): Promise<ResearchCatalogSummary> {
  const [kw] = await db
    .select({
      total: sql<number>`count(*)::int`,
      primaries: sql<number>`count(*) filter (where ${researchKeywords.variant} = 'primary')::int`,
      matched: sql<number>`count(*) filter (where ${researchKeywords.nicheId} is not null)::int`,
    })
    .from(researchKeywords)
    .where(eq(researchKeywords.active, true))

  const [geo] = await db
    .select({
      total: sql<number>`count(*)::int`,
      purchasable: sql<number>`count(*) filter (where ${researchGeos.dataforseoLocationCode} is not null)::int`,
      matched: sql<number>`count(*) filter (where ${researchGeos.localityId} is not null)::int`,
    })
    .from(researchGeos)
    .where(eq(researchGeos.active, true))

  return {
    keywordCount: kw?.total ?? 0,
    primaryCount: kw?.primaries ?? 0,
    geoCount: geo?.total ?? 0,
    purchasableGeoCount: geo?.purchasable ?? 0,
    softMatchedKeywords: kw?.matched ?? 0,
    softMatchedGeos: geo?.matched ?? 0,
  }
}

export async function listResearchKeywords(
  db: Database,
  opts?: { limit?: number; primaryOnly?: boolean },
): Promise<ResearchKeyword[]> {
  const limit = opts?.limit ?? 100
  const where = opts?.primaryOnly
    ? and(eq(researchKeywords.active, true), eq(researchKeywords.variant, 'primary'))
    : eq(researchKeywords.active, true)
  return db
    .select()
    .from(researchKeywords)
    .where(where)
    // Names-only catalog: no import volume ranking.
    .orderBy(asc(researchKeywords.keyword))
    .limit(limit)
}

export async function listResearchGeos(
  db: Database,
  opts?: { limit?: number; purchasableOnly?: boolean },
): Promise<ResearchGeo[]> {
  const limit = opts?.limit ?? 100
  const where = opts?.purchasableOnly
    ? and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode))
    : eq(researchGeos.active, true)
  return db
    .select()
    .from(researchGeos)
    .where(where)
    .orderBy(asc(researchGeos.selectedRank), asc(researchGeos.market))
    .limit(limit)
}

export interface ResearchEnqueuePreview extends EnqueuePreview {
  keywordCount: number
  geoCount: number
  devices: string[]
  includeNearMe: boolean
  /** Whether "<keyword> <city>" was measured alongside the city-free keyword. */
  includeGeoExplicit: boolean
  truncated: boolean
  selectionNote: string | null
  filtersSummary: string
  requiresLongLivedWorker: boolean
  maxLiveSpendUnderHardCapMicros: bigint
  defaultBudgetCapCents: number
}

function defaultBudgetCapCents(estimatedCostMicros: bigint, usedFixtures: boolean): number {
  if (usedFixtures) return 0
  const estimateCents = Math.ceil(Number(estimatedCostMicros) / 10_000)
  return Math.max(1000, estimateCents)
}

function keywordToNicheInput(
  kw: ResearchKeyword,
  nearMeSibling: ResearchKeyword | null,
  includeNearMe: boolean,
): DiscoveryNicheInput {
  const primary =
    kw.variant === 'primary'
      ? kw
      : nearMeSibling?.variant === 'primary'
        ? nearMeSibling
        : kw
  const nearMe =
    nearMeSibling?.variant === 'near_me'
      ? nearMeSibling.keyword
      : `${primary.keyword} near me`
  return {
    label: primary.keyword,
    slug: null,
    keywordPrimary: primary.keyword,
    keywordNearMe: nearMe,
    nearMeSynthesised: nearMeSibling?.variant !== 'near_me',
    nicheId: primary.nicheId,
    researchKeywordId: primary.id,
  }
}

function geoToInput(g: ResearchGeo): DiscoveryGeoInput {
  return {
    name: g.market,
    state: g.stateAbbr ?? g.state ?? '',
    population: g.population2025,
    providerLocationCode: g.dataforseoLocationCode,
    localityId: g.localityId,
    locationSource: g.locationSource ?? 'csv_preresolved',
    researchGeoId: g.id,
    /**
     * Curated per market because reconstructing it from the market name is
     * wrong exactly where it matters: "Springfield" needs a state, "New York
     * City" is what people type but Google's geotarget is "New York".
     */
    queryModifier: g.recommendedExplicitModifier ?? g.naturalQueryModifier ?? null,
    lineNumber: g.lineNumber,
  }
}

function buildFiltersSummary(args: {
  keywordCount: number
  geoCount: number
  devices: ResearchDevice[]
  includeNearMe: boolean
  includeGeoExplicit?: boolean
  geoTier?: string | null
}): string {
  return [
    `${args.keywordCount} keywords`,
    `${args.geoCount} geos`,
    args.devices.join('+'),
    args.includeNearMe ? 'near_me on' : 'near_me off',
    args.includeGeoExplicit ? 'geo-explicit on' : null,
    args.geoTier ? `tier=${args.geoTier}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Single catalog cell: one primary keyword × one geo × devices (default both).
 * includeNearMe default true.
 */
export async function enqueueCatalogCellResearch(
  db: Database,
  args: {
    researchKeywordId: number
    researchGeoId: number
    devices?: ResearchDevice[]
    includeNearMe?: boolean
    /** Also measure "<keyword> <city>". See discoveryRuns.includeGeoExplicit. */
    includeGeoExplicit?: boolean
    budgetCapCents?: number
    dryRun?: boolean
  },
): Promise<{ preview: ResearchEnqueuePreview; run?: DiscoveryRun }> {
  const [kw] = await db
    .select()
    .from(researchKeywords)
    .where(eq(researchKeywords.id, args.researchKeywordId))
    .limit(1)
  if (!kw) throw new DiscoveryEnqueueError(`Catalog keyword ${args.researchKeywordId} not found.`)
  if (!kw.active) throw new DiscoveryEnqueueError(`Catalog keyword ${kw.keyword} is inactive.`)

  const [geo] = await db
    .select()
    .from(researchGeos)
    .where(eq(researchGeos.id, args.researchGeoId))
    .limit(1)
  if (!geo) throw new DiscoveryEnqueueError(`Catalog geo ${args.researchGeoId} not found.`)
  if (!geo.active) throw new DiscoveryEnqueueError(`Catalog geo ${geo.market} is inactive.`)
  if (geo.dataforseoLocationCode === null) {
    throw new DiscoveryEnqueueError(
      `${geo.market} has no DataForSEO location code and cannot be researched.`,
    )
  }

  const includeNearMe = args.includeNearMe !== false
  const includeGeoExplicit = args.includeGeoExplicit === true
  const devices = args.devices?.length ? args.devices : (['desktop', 'mobile'] as ResearchDevice[])

  let nearMeSibling: ResearchKeyword | null = null
  if (includeNearMe) {
    const [sib] = await db
      .select()
      .from(researchKeywords)
      .where(
        and(
          eq(researchKeywords.active, true),
          eq(researchKeywords.seedKey, kw.seedKey),
          eq(researchKeywords.variant, 'near_me'),
        ),
      )
      .limit(1)
    nearMeSibling = sib ?? null
  }

  const primary = kw.variant === 'primary' ? kw : kw
  const niches = [keywordToNicheInput(primary, nearMeSibling, includeNearMe)]
  const geos = [geoToInput(geo)]

  const usedFixtures = !liveCallsEnabled()
  const variantsPerKw = 1 + (includeNearMe ? 1 : 0) + (includeGeoExplicit ? 1 : 0)
  const jobCount = niches.length * variantsPerKw * 1 * devices.length
  const estimatedCostMicros = usedFixtures ? 0n : BigInt(jobCount) * PRICE.serpOrganicLive
  const budgetCapCents =
    args.budgetCapCents ?? defaultBudgetCapCents(estimatedCostMicros, usedFixtures)

  const preview: ResearchEnqueuePreview = {
    nicheCount: 1,
    keywordCount: 1,
    geoCount: 1,
    geoResolved: 1,
    geoUnresolved: 0,
    geoUnscannableSource: 0,
    jobCount,
    estimatedCostMicros,
    budgetCapMicros: centsToMicros(budgetCapCents),
    usedFixtures,
    hardCap: DEFAULT_MAX_JOBS,
    devices: [...devices],
    includeNearMe,
    includeGeoExplicit,
    truncated: false,
    selectionNote: null,
    filtersSummary: buildFiltersSummary({
      keywordCount: 1,
      geoCount: 1,
      devices,
      includeNearMe,
    }),
    requiresLongLivedWorker: jobCount > 50 && !usedFixtures,
    maxLiveSpendUnderHardCapMicros: BigInt(DEFAULT_MAX_JOBS) * PRICE.serpOrganicLive,
    defaultBudgetCapCents: defaultBudgetCapCents(estimatedCostMicros, usedFixtures),
  }

  if (args.dryRun) return { preview }

  const { run, preview: enqPreview } = await enqueueDiscoveryRun(db, {
    niches,
    geos,
    budgetCapCents,
    devices,
    includeNearMe,
    includeGeoExplicit,
    source: 'catalog',
    label: `${primary.keyword} · ${geo.market}${geo.stateAbbr ? ', ' + geo.stateAbbr : ''}`,
    usedFixtures,
  })

  return {
    run,
    preview: {
      ...preview,
      ...enqPreview,
      keywordCount: 1,
      geoCount: 1,
      devices: [...devices],
      includeNearMe,
      includeGeoExplicit,
      truncated: false,
      selectionNote: null,
      filtersSummary: preview.filtersSummary,
      requiresLongLivedWorker: preview.requiresLongLivedWorker,
      maxLiveSpendUnderHardCapMicros: preview.maxLiveSpendUnderHardCapMicros,
      defaultBudgetCapCents: preview.defaultBudgetCapCents,
    },
  }
}

/**
 * Bulk catalog research. Defaults: top 50 KW by volume × top 50 geos.
 * Opportunity funnel default devices = desktop only (caller passes devices).
 * near_me off → 50×50×1 = 2500 jobs / $5 live. Dual-device hits 5000 / $10 hard cap.
 */
export async function enqueueCatalogBulkResearch(
  db: Database,
  args: {
    keywordIds?: number[]
    geoIds?: number[]
    geoTier?: 'top_50' | 'all' | string
    includeNearMe?: boolean
    devices?: ResearchDevice[]
    maxJobs?: number
    budgetCapCents?: number
    autoTruncate?: boolean
    dryRun?: boolean
    label?: string
    /** Paid extras, off unless asked for. See discoveryRuns in schema.ts. */
    fetchVolume?: boolean
    fetchMaps?: boolean
    /** Queue SERPs at $0.0006 instead of buying live at $0.0020. */
    useQueuedSerp?: boolean
    /**
     * Also measure "<keyword> <city>". Adds one SERP per keyword x geo x
     * device. See discoveryRuns.includeGeoExplicit for why it is worth it and
     * why it is off by default.
     */
    includeGeoExplicit?: boolean
  },
): Promise<{ preview: ResearchEnqueuePreview; run?: DiscoveryRun }> {
  if (!researchBulkEnabled() && !args.dryRun) {
    throw new DiscoveryEnqueueError(
      'Bulk catalog research is disabled. Unset RESEARCH_BULK_ENABLED or set it to anything but false.',
    )
  }

  const includeNearMe = args.includeNearMe === true
  const includeGeoExplicit = args.includeGeoExplicit === true
  // Opportunity funnel prefers desktop-only; dual-device only when explicitly passed.
  const devices = args.devices?.length ? args.devices : (['desktop'] as ResearchDevice[])
  const maxJobs = args.maxJobs ?? DEFAULT_MAX_JOBS
  const autoTruncate = args.autoTruncate !== false
  const usedFixtures = !liveCallsEnabled()

  // Load keywords
  let keywords: ResearchKeyword[]
  if (args.keywordIds?.length) {
    keywords = await db
      .select()
      .from(researchKeywords)
      .where(
        and(
          eq(researchKeywords.active, true),
          inArray(researchKeywords.id, args.keywordIds),
        ),
      )
    // Prefer primaries; if operator picked near_me only, keep them.
    const primaries = keywords.filter((k) => k.variant === 'primary')
    if (primaries.length > 0) keywords = primaries
  } else {
    keywords = await db
      .select()
      .from(researchKeywords)
      .where(and(eq(researchKeywords.active, true), eq(researchKeywords.variant, 'primary')))
      .orderBy(asc(researchKeywords.keyword))
      .limit(DEFAULT_BULK_TOP_KEYWORDS)
  }

  // Load geos
  let geos: ResearchGeo[]
  if (args.geoIds?.length) {
    geos = await db
      .select()
      .from(researchGeos)
      .where(and(eq(researchGeos.active, true), inArray(researchGeos.id, args.geoIds)))
  } else {
    const tier = args.geoTier ?? 'top_50'
    const q = db
      .select()
      .from(researchGeos)
      .where(
        and(
          eq(researchGeos.active, true),
          isNotNull(researchGeos.dataforseoLocationCode),
          tier === 'top_50' ? sql`${researchGeos.selectedRank} is not null AND ${researchGeos.selectedRank} <= 50` : sql`true`,
        ),
      )
      .orderBy(asc(researchGeos.selectedRank), asc(researchGeos.market))
    geos = await (tier === 'all' ? q : q.limit(DEFAULT_BULK_TOP_GEOS))
  }

  geos = geos.filter((g) => g.dataforseoLocationCode !== null)

  if (keywords.length === 0) {
    throw new DiscoveryEnqueueError('No active catalog keywords to research.')
  }
  if (geos.length === 0) {
    throw new DiscoveryEnqueueError('No purchasable catalog geos to research.')
  }

  /**
   * geo_explicit is an upper bound: markets with no curated modifier, and
   * keywords that already carry a city or say "near me", skip the variant. The
   * spend gate should overshoot rather than under-reserve.
   */
  const variantsPerKw = 1 + (includeNearMe ? 1 : 0) + (includeGeoExplicit ? 1 : 0)
  let selectedKw = keywords
  let selectedGeos = geos
  let truncated = false
  let selectionNote: string | null = null

  const jobCountFor = (kwN: number, geoN: number) =>
    kwN * variantsPerKw * geoN * devices.length

  let jobCount = jobCountFor(selectedKw.length, selectedGeos.length)

  if (jobCount > maxJobs) {
    if (!autoTruncate) {
      throw new DiscoveryEnqueueError(
        `Job count ${jobCount} exceeds hard cap ${maxJobs}. Narrow selection or enable auto-truncate.`,
      )
    }
    // Rank-and-cut: keywords A–Z (no import volume), geos by market rank.
    selectedKw = [...selectedKw].sort((a, b) => a.keyword.localeCompare(b.keyword))
    selectedGeos = [...selectedGeos].sort(
      (a, b) => (a.selectedRank ?? 9999) - (b.selectedRank ?? 9999),
    )

    const origKw = selectedKw.length
    const origGeo = selectedGeos.length

    // Cut keywords first while keeping geos, then geos if needed.
    while (jobCountFor(selectedKw.length, selectedGeos.length) > maxJobs && selectedKw.length > 1) {
      selectedKw.pop()
    }
    while (jobCountFor(selectedKw.length, selectedGeos.length) > maxJobs && selectedGeos.length > 1) {
      selectedGeos.pop()
    }
    jobCount = jobCountFor(selectedKw.length, selectedGeos.length)
    if (jobCount > maxJobs) {
      throw new DiscoveryEnqueueError(
        `Cannot fit under hard cap ${maxJobs} even with one keyword × one geo × devices.`,
      )
    }
    truncated = true
    const parts: string[] = []
    if (selectedKw.length !== origKw) {
      parts.push(`truncated keywords ${origKw} → ${selectedKw.length}`)
    }
    if (selectedGeos.length !== origGeo) {
      parts.push(`truncated geos ${origGeo} → ${selectedGeos.length}`)
    }
    selectionNote = `${parts.join('; ')} to fit hard cap ${maxJobs}`
  }

  // Near-me siblings for selected seeds
  const seedKeys = [...new Set(selectedKw.map((k) => k.seedKey))]
  const nearMeRows =
    includeNearMe && seedKeys.length > 0
      ? await db
          .select()
          .from(researchKeywords)
          .where(
            and(
              eq(researchKeywords.active, true),
              eq(researchKeywords.variant, 'near_me'),
              inArray(researchKeywords.seedKey, seedKeys),
            ),
          )
      : []
  const nearMeBySeed = new Map(nearMeRows.map((r) => [r.seedKey, r]))

  const niches: DiscoveryNicheInput[] = selectedKw.map((kw) =>
    keywordToNicheInput(kw, nearMeBySeed.get(kw.seedKey) ?? null, includeNearMe),
  )
  const geoInputs: DiscoveryGeoInput[] = selectedGeos.map(geoToInput)

  /**
   * SERP is jobCount; volume is one $0.09 request per distinct (keyword,
   * location) the runner will ask for — desktop and mobile share one — and maps
   * is one per (niche, location). Quoting only the SERP line is what made a
   * 3,200-job deep dive advertise $6.40 when volume alone was ~$144.
   */
  /**
   * Volume is batched to ONE request per location (see keyword-volume-cache),
   * so it scales with markets, not markets x keywords. Cache hits from earlier
   * runs make it cheaper still; quoting the cold-cache price is the honest
   * ceiling. Both extras contribute nothing when switched off.
   */
  const billExtras = !usedFixtures
  const costBreakdown = estimateDiscoveryCostMicros({
    jobCount,
    serpUnitMicros:
      args.useQueuedSerp === true ? PRICE.serpOrganicTask : PRICE.serpOrganicLive,
    /**
     * ZERO, not the market count. Keyword volume comes from Google Ads, which
     * is free -- fetchVolumeBatch returns costMicros 0n and billableRequests 0
     * on every path, and the $0.09 DataForSEO endpoint it used to fall back to
     * was removed by policy. Charging for it here inflated every preview by
     * $0.09 per market ($4.50 on a 50-market sweep) against a bill that never
     * arrives. The client-side estimate already prices it at 0; this is the
     * server catching up, not a policy change.
     */
    volumeRequests: 0,
    mapsRequests:
      billExtras && args.fetchMaps === true ? selectedKw.length * selectedGeos.length : 0,
  })
  const estimatedCostMicros = usedFixtures ? 0n : costBreakdown.totalMicros
  const budgetCapCents =
    args.budgetCapCents ?? defaultBudgetCapCents(estimatedCostMicros, usedFixtures)

  const preview: ResearchEnqueuePreview = {
    nicheCount: niches.length,
    keywordCount: selectedKw.length,
    geoCount: selectedGeos.length,
    geoResolved: selectedGeos.length,
    geoUnresolved: 0,
    geoUnscannableSource: 0,
    jobCount,
    estimatedCostMicros,
    budgetCapMicros: centsToMicros(budgetCapCents),
    usedFixtures,
    hardCap: maxJobs,
    devices: [...devices],
    includeNearMe,
    includeGeoExplicit,
    truncated,
    selectionNote,
    filtersSummary: buildFiltersSummary({
      keywordCount: selectedKw.length,
      geoCount: selectedGeos.length,
      devices,
      includeNearMe,
      includeGeoExplicit,
      geoTier: args.geoTier ?? (args.geoIds ? 'custom' : 'top_50'),
    }),
    requiresLongLivedWorker: jobCount > 50 && !usedFixtures,
    maxLiveSpendUnderHardCapMicros:
      BigInt(maxJobs) *
      (args.useQueuedSerp === true ? PRICE.serpOrganicTask : PRICE.serpOrganicLive),
    defaultBudgetCapCents: defaultBudgetCapCents(estimatedCostMicros, usedFixtures),
  }

  if (args.dryRun) return { preview }

  if (preview.estimatedCostMicros > preview.budgetCapMicros && !usedFixtures) {
    throw new DiscoveryEnqueueError(
      `Estimated cost exceeds budget cap. Raise budgetCapCents or shrink the grid.`,
      preview,
    )
  }

  const { run, preview: enqPreview } = await enqueueDiscoveryRun(db, {
    niches,
    geos: geoInputs,
    budgetCapCents,
    devices,
    includeNearMe,
    /**
     * Load-bearing. Without it the PREVIEW counted the geo-explicit variant
     * (variantsPerKw above) while the ENQUEUE did not build it -- an operator
     * approved 4 SERPs and got 2, with the run row reporting the feature off.
     * Caught by running the real flow; no test covered the preview and the
     * fan-out agreeing.
     */
    includeGeoExplicit,
    source: 'catalog',
    maxJobs,
    selectionNote,
    geoTierFilter: args.geoTier ?? (args.geoIds ? 'custom' : 'top_50'),
    label:
      args.label ??
      `Bulk catalog · ${selectedKw.length} kw × ${selectedGeos.length} geo × ${devices.join('+')}`,
    usedFixtures,
    fetchVolume: args.fetchVolume === true,
    fetchMaps: args.fetchMaps === true,
    useQueuedSerp: args.useQueuedSerp === true,
  })

  return {
    run,
    preview: {
      ...preview,
      ...enqPreview,
      keywordCount: selectedKw.length,
      geoCount: selectedGeos.length,
      devices: [...devices],
      includeNearMe,
      includeGeoExplicit,
      truncated,
      selectionNote,
      filtersSummary: preview.filtersSummary,
      requiresLongLivedWorker: preview.requiresLongLivedWorker,
      maxLiveSpendUnderHardCapMicros: preview.maxLiveSpendUnderHardCapMicros,
      defaultBudgetCapCents: preview.defaultBudgetCapCents,
    },
  }
}
