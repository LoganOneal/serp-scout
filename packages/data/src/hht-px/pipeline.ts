import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  HHT_PX_CLUSTER_TOPICAL_FIT,
  HHT_PX_PRIORITY_SCORE,
  HHT_PX_SERP_OVERLAP_THRESHOLD,
  HHT_PX_SERP_STALE_DAYS,
  classifyHhtPxSerpResult,
  editorialDensity,
  estimatedNonduplicatedDemand,
  expectedProspectsPerSerpCall,
  hhtPxRootDomain,
  hhtPxSubdomain,
  isHhtPxCluster,
  inventoryFit,
  isProspectablePageType,
  normalizeHhtPxUrl,
  pickVariantRepresentatives,
  prospectableDensity,
  qualityAdjustedProspectsPerSerpCall,
  recommendHhtTargetUrl,
  scoreHhtPxDomain,
  scoreHhtPxKeyword,
  scoreHhtPxPage,
  serpUrlOverlap,
  whyTheyCouldLink,
  type HhtPxCluster,
  type HhtPxPageType,
  type HhtPxStage,
  HHT_PX_KEYWORD_IDEA_SEEDS,
} from '@rnr/core'
import type { Database } from '../db.js'
import { GOOGLE_ADS_GEO_US, fetchKeywordVolumes, type KeywordVolumeRow } from '../providers/google-ads/keyword-volume.js'
import { fetchDfsKeywordVolumesFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchKeywordIdeas } from '../providers/google-ads/keyword-ideas.js'
import {
  HHT_PX_MCP_ENRICH_MESSAGE,
  HHT_PX_MCP_SERP_MESSAGE,
  backlinksFromMcpPayload,
  domainOverviewFromMcpPayload,
  mcpPayloadError,
  mcpNothingFound,
  serpRowsFromMcpPayload,
  type HhtPxMcpDomainHarvest,
  type HhtPxMcpOrganicHarvest,
  type HhtPxSerpRawRow,
} from './mcp.js'
import {
  hhtPxClusterYields,
  hhtPxDomainOverrides,
  hhtPxGeographies,
  hhtPxKeywordVolumes,
  hhtPxKeywords,
  hhtPxPageKeywordMatches,
  hhtPxPipelineJobs,
  hhtPxPipelineRuns,
  hhtPxProspectDomains,
  hhtPxProspectPages,
  hhtPxSerpResults,
  hhtPxSerpSnapshots,
  keywordVolumeCache,
} from '../schema.js'
import { generateHhtPxKeywordRows, seedHhtPxGeographies, seedHhtPxTemplates } from './seed.js'

const VOLUME_BATCH = 100
const DFS_VOLUME_BATCH = 1000
const DEFAULT_VOLUME_LIMIT = 500
const DEFAULT_SERP_LIMIT = 25
const DEFAULT_ENRICH_LIMIT = 25
const PLANNING_VOLUME = 500

export interface PipelineLimitOptions {
  runId?: number
  limit?: number
  keywordIds?: number[]
  clusters?: HhtPxCluster[]
  retryFailed?: boolean
  includeExperimental?: boolean
  refresh?: boolean
  mcpHarvests?: HhtPxMcpOrganicHarvest[]
  mcpDomainHarvests?: HhtPxMcpDomainHarvest[]
}

export type { HhtPxMcpDomainHarvest, HhtPxMcpOrganicHarvest }

function jobKey(stage: HhtPxStage, target: string): string {
  return createHash('sha256').update(`${stage}:${target}`).digest('hex')
}

function staleBefore(): Date {
  return new Date(Date.now() - HHT_PX_SERP_STALE_DAYS * 24 * 60 * 60 * 1000)
}

async function ensureRun(database: Database, runId?: number): Promise<number> {
  if (runId) return runId
  const [existing] = await database
    .select({ id: hhtPxPipelineRuns.id })
    .from(hhtPxPipelineRuns)
    .orderBy(sql`${hhtPxPipelineRuns.id} desc`)
    .limit(1)
  if (existing) return existing.id
  const [created] = await database
    .insert(hhtPxPipelineRuns)
    .values({ name: 'HHT SERP prospecting', status: 'draft' })
    .returning({ id: hhtPxPipelineRuns.id })
  return created!.id
}

async function touchRun(
  database: Database,
  runId: number,
  patch: Partial<{
    status: 'draft' | 'running' | 'paused' | 'waiting' | 'complete' | 'failed'
    currentStage: HhtPxStage
    error: string | null
    progress: Record<string, number>
  }>,
): Promise<void> {
  await database
    .update(hhtPxPipelineRuns)
    .set({ ...patch, updatedAt: new Date(), startedAt: patch.status === 'running' ? new Date() : undefined })
    .where(eq(hhtPxPipelineRuns.id, runId))
}

async function recordJob(
  database: Database,
  args: {
    runId: number
    stage: HhtPxStage
    provider: string
    target: string
    status: 'running' | 'complete' | 'failed' | 'waiting'
    recordsCompleted?: number
    error?: string | null
    estimatedUnits?: number | null
    parameters?: Record<string, unknown>
  },
): Promise<number> {
  const requestKey = jobKey(args.stage, args.target)
  const [existing] = await database
    .select({ id: hhtPxPipelineJobs.id, attempts: hhtPxPipelineJobs.attempts })
    .from(hhtPxPipelineJobs)
    .where(and(eq(hhtPxPipelineJobs.runId, args.runId), eq(hhtPxPipelineJobs.requestKey, requestKey)))
    .limit(1)
  const finished = args.status === 'complete' || args.status === 'failed' ? new Date() : null
  if (existing) {
    await database
      .update(hhtPxPipelineJobs)
      .set({
        status: args.status,
        attempts: existing.attempts + 1,
        recordsCompleted: args.recordsCompleted ?? 0,
        error: args.error ?? null,
        estimatedUnits: args.estimatedUnits ?? null,
        updatedAt: new Date(),
        finishedAt: finished,
      })
      .where(eq(hhtPxPipelineJobs.id, existing.id))
    return existing.id
  }
  const [created] = await database
    .insert(hhtPxPipelineJobs)
    .values({
      runId: args.runId,
      stage: args.stage,
      provider: args.provider,
      target: args.target,
      requestKey,
      status: args.status,
      attempts: 1,
      recordsCompleted: args.recordsCompleted ?? 0,
      error: args.error ?? null,
      estimatedUnits: args.estimatedUnits ?? null,
      parameters: args.parameters ?? {},
      finishedAt: finished,
    })
    .returning({ id: hhtPxPipelineJobs.id })
  return created!.id
}

export async function seedHhtPxLibrary(database: Database, runId?: number): Promise<{
  runId: number
  geographies: number
  templates: number
  keywords: { inserted: number; total: number }
}> {
  const id = await ensureRun(database, runId)
  await touchRun(database, id, { status: 'running', currentStage: 'geographies' })
  const geographies = await seedHhtPxGeographies(database)
  await recordJob(database, {
    runId: id,
    stage: 'geographies',
    provider: 'seed',
    target: 'geographies',
    status: 'complete',
    recordsCompleted: geographies,
  })
  await touchRun(database, id, { currentStage: 'keyword_generation' })
  const templates = await seedHhtPxTemplates(database)
  const keywords = await generateHhtPxKeywordRows(database)
  await recordJob(database, {
    runId: id,
    stage: 'keyword_generation',
    provider: 'seed',
    target: 'keywords',
    status: 'complete',
    recordsCompleted: keywords.total,
  })
  await touchRun(database, id, {
    status: 'paused',
    currentStage: 'google_ads_volume',
    progress: { geographies, templates, keywords: keywords.total },
  })
  return { runId: id, geographies, templates, keywords }
}

type VolumePending = {
  id: number
  keyword: string
  volumeId: number | null
  retrievedAt: Date | null
  error: string | null
}

async function hydrateHhtPxVolumesFromCache(database: Database): Promise<number> {
  const hits = await database
    .select({
      keywordId: hhtPxKeywords.id,
      keyword: hhtPxKeywords.keyword,
      volume: keywordVolumeCache.avgMonthlySearches,
      monthly: keywordVolumeCache.monthlySearches,
      competition: keywordVolumeCache.competition,
      competitionIndex: keywordVolumeCache.competitionIndex,
      lowBid: keywordVolumeCache.lowTopOfPageBidMicros,
      highBid: keywordVolumeCache.highTopOfPageBidMicros,
      geoTarget: keywordVolumeCache.geoTarget,
      volumeId: hhtPxKeywordVolumes.id,
      retrievedAt: hhtPxKeywordVolumes.retrievedAt,
    })
    .from(hhtPxKeywords)
    .innerJoin(
      keywordVolumeCache,
      and(
        eq(keywordVolumeCache.keyword, hhtPxKeywords.keywordNorm),
        eq(keywordVolumeCache.locationCode, GOOGLE_ADS_GEO_US),
        eq(keywordVolumeCache.hasData, true),
      ),
    )
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .where(isNull(hhtPxKeywordVolumes.retrievedAt))

  let written = 0
  for (const hit of hits) {
    const payload = {
      keywordId: hit.keywordId,
      requestedKeyword: hit.keyword,
      returnedKeyword: hit.keyword,
      closeVariants: [] as string[],
      nationalDestinationVolume: hit.volume,
      monthlySearches: hit.monthly ?? [],
      competition: hit.competition,
      competitionIndex: hit.competitionIndex,
      lowBidMicros: hit.lowBid,
      highBidMicros: hit.highBid,
      googleAdsGeoTarget: GOOGLE_ADS_GEO_US,
      googleAdsGeoLabel: hit.geoTarget ?? 'keyword_volume_cache location_code=2840',
      retrievedAt: new Date(),
      error: null,
      updatedAt: new Date(),
    }
    if (hit.volumeId) {
      await database.update(hhtPxKeywordVolumes).set(payload).where(eq(hhtPxKeywordVolumes.id, hit.volumeId))
    } else {
      await database.insert(hhtPxKeywordVolumes).values(payload).onConflictDoNothing()
    }
    written += 1
  }
  return written
}

async function persistHhtPxVolumeBatch(
  database: Database,
  batch: VolumePending[],
  rows: KeywordVolumeRow[],
  geoLabel: string,
): Promise<number> {
  const byRequested = new Map(rows.map((row) => [row.keyword.toLowerCase(), row]))
  let processed = 0
  for (const item of batch) {
    const row = byRequested.get(item.keyword.toLowerCase())
    const payload = {
      keywordId: item.id,
      requestedKeyword: item.keyword,
      returnedKeyword: row?.returnedKeyword ?? null,
      closeVariants: row?.closeVariants ?? [],
      nationalDestinationVolume: row?.avgMonthlySearches ?? null,
      monthlySearches: row?.monthlySearches ?? [],
      competition: row?.competition ?? null,
      competitionIndex: row?.competitionIndex ?? null,
      lowBidMicros: row?.lowTopOfPageBidMicros ?? null,
      highBidMicros: row?.highTopOfPageBidMicros ?? null,
      googleAdsGeoTarget: GOOGLE_ADS_GEO_US,
      googleAdsGeoLabel: geoLabel,
      retrievedAt: new Date(),
      error: null,
      updatedAt: new Date(),
    }
    if (item.volumeId) {
      await database.update(hhtPxKeywordVolumes).set(payload).where(eq(hhtPxKeywordVolumes.id, item.volumeId))
    } else {
      await database.insert(hhtPxKeywordVolumes).values(payload).onConflictDoNothing()
    }
    processed += 1
  }
  return processed
}

function dfsRowsToVolume(requested: string[], dfs: Awaited<ReturnType<typeof fetchDfsKeywordVolumesFromEnv>>): KeywordVolumeRow[] {
  const byKw = new Map(dfs.rows.map((row) => [row.keyword.toLowerCase(), row]))
  return requested.map((keyword) => {
    const row = byKw.get(keyword.toLowerCase())
    return {
      keyword,
      returnedKeyword: row?.keyword ?? null,
      closeVariants: [],
      avgMonthlySearches: row?.avgMonthlySearches ?? null,
      competition: row?.competition ?? null,
      competitionIndex: row?.competitionIndex ?? null,
      lowTopOfPageBidMicros: row?.lowTopOfPageBidMicros ?? null,
      highTopOfPageBidMicros: row?.highTopOfPageBidMicros ?? null,
      monthlySearches: row?.monthlySearches ?? [],
    }
  })
}

export async function fetchHhtPxVolumes(
  database: Database,
  options: PipelineLimitOptions = {},
): Promise<{ processed: number; remaining: number; error: string | null; runId: number }> {
  const runId = await ensureRun(database, options.runId)
  await touchRun(database, runId, { status: 'running', currentStage: 'google_ads_volume' })
  const cached = options.keywordIds?.length ? 0 : await hydrateHhtPxVolumesFromCache(database)
  const limit = Math.max(1, options.limit ?? DEFAULT_VOLUME_LIMIT)
  const volumeWhere = [
    options.keywordIds?.length
      ? inArray(hhtPxKeywords.id, options.keywordIds)
      : options.retryFailed
        ? or(isNull(hhtPxKeywordVolumes.retrievedAt), sql`${hhtPxKeywordVolumes.error} is not null`)
        : isNull(hhtPxKeywordVolumes.retrievedAt),
  ]
  if (options.clusters?.length) {
    volumeWhere.push(inArray(hhtPxKeywords.cluster, options.clusters.filter(isHhtPxCluster)))
    if (!options.keywordIds?.length) {
      volumeWhere.push(eq(hhtPxKeywords.promoted, true))
      volumeWhere.push(eq(hhtPxKeywords.isRepresentative, true))
    }
  }
  const pending = await database
    .select({
      id: hhtPxKeywords.id,
      keyword: hhtPxKeywords.keyword,
      volumeId: hhtPxKeywordVolumes.id,
      retrievedAt: hhtPxKeywordVolumes.retrievedAt,
      error: hhtPxKeywordVolumes.error,
    })
    .from(hhtPxKeywords)
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .where(and(...volumeWhere))
    .orderBy(
      sql`case ${hhtPxKeywords.priority}
        when 'very_high' then 0
        when 'high' then 1
        when 'medium_high' then 2
        when 'medium' then 3
        when 'low_medium' then 4
        else 5 end`,
      sql`${hhtPxGeographies.priority} asc nulls last`,
      asc(hhtPxKeywords.id),
    )
    .limit(limit)

  if (pending.length === 0) {
    await touchRun(database, runId, {
      status: 'paused',
      currentStage: 'keyword_prioritization',
      progress: { volumes: cached },
    })
    return { processed: cached, remaining: 0, error: null, runId }
  }

  let processed = cached
  let lastError: string | null = null
  let useDfs = false
  let index = 0
  while (index < pending.length) {
    if (!useDfs) {
      const batch = pending.slice(index, index + VOLUME_BATCH)
      await recordJob(database, {
        runId,
        stage: 'google_ads_volume',
        provider: 'google_ads',
        target: `keywords:${batch[0]!.id}-${batch.at(-1)!.id}`,
        status: 'running',
        parameters: { keywordIds: batch.map((row) => row.id) },
      })
      const result = await fetchKeywordVolumes(
        batch.map((row) => row.keyword),
        { geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US], live: true },
      )
      if (result.source === 'google_ads') {
        processed += await persistHhtPxVolumeBatch(database, batch, result.rows, result.geoTargetLabel)
        await recordJob(database, {
          runId,
          stage: 'google_ads_volume',
          provider: 'google_ads',
          target: `keywords:${batch[0]!.id}-${batch.at(-1)!.id}`,
          status: 'complete',
          recordsCompleted: batch.length,
        })
        index += batch.length
        continue
      }
      lastError = result.error
      useDfs = true
    }

    const batch = pending.slice(index, index + DFS_VOLUME_BATCH)
    await recordJob(database, {
      runId,
      stage: 'google_ads_volume',
      provider: 'dataforseo',
      target: `keywords:${batch[0]!.id}-${batch.at(-1)!.id}`,
      status: 'running',
      parameters: { keywordIds: batch.map((row) => row.id), fallback: 'dataforseo_google_ads' },
    })
    const dfs = await fetchDfsKeywordVolumesFromEnv({
      keywords: batch.map((row) => row.keyword),
      locationCode: GOOGLE_ADS_GEO_US,
      live: true,
    })
    if (dfs.source !== 'dataforseo_google_ads') {
      lastError = dfs.error ?? lastError ?? 'DataForSEO Google Ads volume failed.'
      await recordJob(database, {
        runId,
        stage: 'google_ads_volume',
        provider: 'dataforseo',
        target: `keywords:${batch[0]!.id}-${batch.at(-1)!.id}`,
        status: 'failed',
        error: lastError,
      })
      await touchRun(database, runId, { status: 'failed', error: lastError })
      return { processed, remaining: pending.length - (index), error: lastError, runId }
    }
    processed += await persistHhtPxVolumeBatch(
      database,
      batch,
      dfsRowsToVolume(batch.map((row) => row.keyword), dfs),
      `${dfs.volumeGeoTarget} (US national destination demand; Google Ads API ${lastError ?? 'unavailable'})`,
    )
    await recordJob(database, {
      runId,
      stage: 'google_ads_volume',
      provider: 'dataforseo',
      target: `keywords:${batch[0]!.id}-${batch.at(-1)!.id}`,
      status: 'complete',
      recordsCompleted: batch.length,
    })
    index += batch.length
  }

  const remainingRow = await database
    .select({ remaining: sql<number>`count(*)::int` })
    .from(hhtPxKeywords)
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .where(isNull(hhtPxKeywordVolumes.retrievedAt))
  const remaining = remainingRow[0]?.remaining ?? 0
  await touchRun(database, runId, {
    status: 'paused',
    currentStage: remaining > 0 ? 'google_ads_volume' : 'keyword_prioritization',
    progress: { volumes: processed },
    error: lastError,
  })
  return { processed, remaining: remaining ?? 0, error: lastError, runId }
}

export async function prioritizeHhtPxKeywords(database: Database, runId?: number): Promise<{ representatives: number; runId: number }> {
  const id = await ensureRun(database, runId)
  const rows = await database
    .select({
      keywordId: hhtPxKeywords.id,
      geographyId: hhtPxKeywords.geographyId,
      variantGroup: hhtPxKeywords.variantGroup,
      cluster: hhtPxKeywords.cluster,
      priority: hhtPxKeywords.priority,
      volume: hhtPxKeywordVolumes.nationalDestinationVolume,
    })
    .from(hhtPxKeywords)
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .where(eq(hhtPxKeywords.promoted, true))

  const selected = pickVariantRepresentatives(
    rows.map((row) => ({
      keywordId: row.keywordId,
      geographyId: row.geographyId,
      variantGroup: row.variantGroup,
      volume: row.volume,
      priorityScore: HHT_PX_PRIORITY_SCORE[row.priority],
    })),
  )

  await database.update(hhtPxKeywords).set({ isRepresentative: false, updatedAt: new Date() })
  if (selected.size > 0) {
    await database
      .update(hhtPxKeywords)
      .set({ isRepresentative: true, updatedAt: new Date() })
      .where(inArray(hhtPxKeywords.id, [...selected]))
  }
  // Experimental near-queries stay representatives internally but are not auto-queued.
  await database
    .update(hhtPxKeywords)
    .set({ serpStatus: 'skipped', updatedAt: new Date() })
    .where(and(eq(hhtPxKeywords.cluster, 'near_queries'), eq(hhtPxKeywords.serpStatus, 'unchecked')))

  await touchRun(database, id, { status: 'paused', currentStage: 'semrush_serps', progress: { representatives: selected.size } })
  return { representatives: selected.size, runId: id }
}

export interface SerpCallPreview {
  selected: number
  cached: number
  stale: number
  newCalls: number
  keywordIds: number[]
  keywords: Array<{ id: number; keyword: string; cluster: string; volume: number | null }>
}

export async function previewHhtPxSerpCalls(
  database: Database,
  options: PipelineLimitOptions = {},
): Promise<SerpCallPreview> {
  const candidates = await serpCandidates(database, options)
  const nowStale = staleBefore()
  let cached = 0
  let stale = 0
  let newCalls = 0
  const keywordIds: number[] = []
  const keywords: SerpCallPreview['keywords'] = []
  for (const row of candidates) {
    keywordIds.push(row.id)
    keywords.push({ id: row.id, keyword: row.keyword, cluster: row.cluster, volume: row.volume })
    if (!row.retrievedAt) {
      newCalls += 1
    } else if (row.retrievedAt < nowStale || options.refresh) {
      stale += 1
    } else {
      cached += 1
    }
  }
  return {
    selected: candidates.length,
    cached,
    stale,
    newCalls: newCalls + (options.refresh ? 0 : stale),
    keywordIds,
    keywords,
  }
}

async function serpCandidates(database: Database, options: PipelineLimitOptions) {
  const limit = Math.max(1, options.limit ?? DEFAULT_SERP_LIMIT)
  const conditions = [
    eq(hhtPxKeywords.promoted, true),
    options.keywordIds?.length
      ? inArray(hhtPxKeywords.id, options.keywordIds)
      : eq(hhtPxKeywords.isRepresentative, true),
  ]
  if (options.retryFailed) {
    conditions.push(sql`${hhtPxKeywords.serpStatus} in ('unchecked', 'failed')`)
  }
  if (options.clusters?.length) {
    conditions.push(inArray(hhtPxKeywords.cluster, options.clusters.filter(isHhtPxCluster)))
  }
  const rows = await database
    .select({
      id: hhtPxKeywords.id,
      keyword: hhtPxKeywords.keyword,
      cluster: hhtPxKeywords.cluster,
      geographyId: hhtPxKeywords.geographyId,
      geoPriority: hhtPxGeographies.priority,
      volume: hhtPxKeywordVolumes.nationalDestinationVolume,
      retrievedAt: hhtPxSerpSnapshots.retrievedAt,
      serpStatus: hhtPxKeywords.serpStatus,
      equivalent: hhtPxKeywords.serpEquivalent,
      isRepresentative: hhtPxKeywords.isRepresentative,
    })
    .from(hhtPxKeywords)
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.keywordId, hhtPxKeywords.id))
    .where(and(...conditions))
    .orderBy(sql`${hhtPxKeywordVolumes.nationalDestinationVolume} desc nulls last`, asc(hhtPxKeywords.id))
    .limit(limit * 4)

  return rows
    .filter((row) => {
      if (row.equivalent && !options.keywordIds?.length) return false
      if (row.cluster === 'near_queries' && !options.includeExperimental && !options.keywordIds?.length) return false
      if (
        row.cluster === 'destination_planning' &&
        !options.keywordIds?.length &&
        (row.volume ?? 0) < PLANNING_VOLUME &&
        (row.geoPriority ?? 99) > 2
      ) {
        return false
      }
      if (!options.refresh && row.retrievedAt && row.retrievedAt >= staleBefore() && row.serpStatus === 'cached') {
        return false
      }
      return options.retryFailed ? row.serpStatus === 'failed' || !row.retrievedAt : !row.retrievedAt || options.refresh || row.retrievedAt < staleBefore()
    })
    .slice(0, limit)
}

export async function fetchHhtPxSerps(
  database: Database,
  options: PipelineLimitOptions = {},
): Promise<{
  processed: number
  queued: number
  cached: number
  error: string | null
  runId: number
  preview: SerpCallPreview
}> {
  if (options.mcpHarvests?.length) {
    return ingestHhtPxMcpOrganicSerps(database, options.mcpHarvests, options)
  }
  const runId = await ensureRun(database, options.runId)
  const preview = await previewHhtPxSerpCalls(database, options)
  if (preview.keywords.length === 0) {
    return { processed: 0, queued: 0, cached: preview.cached, error: null, runId, preview }
  }
  await database
    .update(hhtPxKeywords)
    .set({ serpStatus: 'queued', updatedAt: new Date() })
    .where(inArray(hhtPxKeywords.id, preview.keywordIds))
  await touchRun(database, runId, {
    status: 'waiting',
    currentStage: 'semrush_serps',
    error: HHT_PX_MCP_SERP_MESSAGE,
  })
  return {
    processed: 0,
    queued: preview.keywords.length,
    cached: preview.cached,
    error: HHT_PX_MCP_SERP_MESSAGE,
    runId,
    preview,
  }
}

async function resolveHhtPxKeyword(
  database: Database,
  harvest: HhtPxMcpOrganicHarvest,
): Promise<{ id: number; keyword: string; cluster: HhtPxCluster } | null> {
  if (harvest.keywordId) {
    const [row] = await database
      .select({ id: hhtPxKeywords.id, keyword: hhtPxKeywords.keyword, cluster: hhtPxKeywords.cluster })
      .from(hhtPxKeywords)
      .where(eq(hhtPxKeywords.id, harvest.keywordId))
      .limit(1)
    return row ?? null
  }
  if (!harvest.keyword) return null
  const [exact] = await database
    .select({ id: hhtPxKeywords.id, keyword: hhtPxKeywords.keyword, cluster: hhtPxKeywords.cluster })
    .from(hhtPxKeywords)
    .where(eq(hhtPxKeywords.keyword, harvest.keyword))
    .limit(1)
  if (exact) return exact
  const norm = harvest.keyword.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()
  const [fuzzy] = await database
    .select({ id: hhtPxKeywords.id, keyword: hhtPxKeywords.keyword, cluster: hhtPxKeywords.cluster })
    .from(hhtPxKeywords)
    .where(eq(hhtPxKeywords.keywordNorm, norm))
    .limit(1)
  return fuzzy ?? null
}

async function persistHhtPxSerpRows(
  database: Database,
  args: {
    runId: number
    keywordId: number
    cluster: HhtPxCluster
    keyword: string
    rows: HhtPxSerpRawRow[]
  },
): Promise<void> {
  const jobId = await recordJob(database, {
    runId: args.runId,
    stage: 'semrush_serps',
    provider: 'semrush_mcp',
    target: `${args.keyword}|us`,
    status: 'complete',
    recordsCompleted: args.rows.length,
    estimatedUnits: 1,
  })
  const [existing] = await database
    .select()
    .from(hhtPxSerpSnapshots)
    .where(eq(hhtPxSerpSnapshots.keywordId, args.keywordId))
    .limit(1)
  const [snapshot] = existing
    ? await database
        .update(hhtPxSerpSnapshots)
        .set({ jobId, retrievedAt: new Date(), resultCount: args.rows.length })
        .where(eq(hhtPxSerpSnapshots.id, existing.id))
        .returning()
    : await database
        .insert(hhtPxSerpSnapshots)
        .values({ keywordId: args.keywordId, jobId, resultCount: args.rows.length })
        .returning()
  if (!snapshot) return
  await database.delete(hhtPxSerpResults).where(eq(hhtPxSerpResults.snapshotId, snapshot.id))
  const classified = args.rows
    .map((row, index) => {
      const url = row.url ?? `https://${row.domain}`
      const normalizedUrl = normalizeHhtPxUrl(url) ?? url
      const rootDomain = hhtPxRootDomain(url) ?? row.domain
      const classifiedRow = classifyHhtPxSerpResult({ url, domain: rootDomain })
      return {
        snapshotId: snapshot.id,
        position: row.position ?? index + 1,
        url,
        normalizedUrl,
        rootDomain,
        subdomain: hhtPxSubdomain(url),
        title: row.title,
        snippet: row.snippet,
        serpFeatures: row.features,
        pageType: classifiedRow.pageType,
        isProspectable: classifiedRow.isProspectable,
        competitorStrength: classifiedRow.competitorStrength,
        excludedByRule: classifiedRow.excludedByRule,
        classificationReason: classifiedRow.reason,
      }
    })
    .filter((row) => row.rootDomain)
  if (classified.length) await database.insert(hhtPxSerpResults).values(classified)
  await applySnapshotMetrics(database, snapshot.id, args.cluster)
  await database
    .update(hhtPxKeywords)
    .set({ serpStatus: 'cached', updatedAt: new Date() })
    .where(eq(hhtPxKeywords.id, args.keywordId))
  await markSerpEquivalents(database, args.keywordId)
}

export async function ingestHhtPxMcpOrganicSerps(
  database: Database,
  harvests: HhtPxMcpOrganicHarvest[],
  options: PipelineLimitOptions = {},
): Promise<{
  processed: number
  queued: number
  cached: number
  error: string | null
  runId: number
  preview: SerpCallPreview
}> {
  const runId = await ensureRun(database, options.runId)
  const preview = await previewHhtPxSerpCalls(database, {
    ...options,
    keywordIds: harvests.map((row) => row.keywordId).filter((id): id is number => typeof id === 'number'),
    limit: Math.max(harvests.length, options.limit ?? harvests.length),
  })
  await touchRun(database, runId, { status: 'running', currentStage: 'semrush_serps' })
  let processed = 0
  const errors: string[] = []
  for (const harvest of harvests) {
    const item = await resolveHhtPxKeyword(database, harvest)
    if (!item) {
      errors.push(`Unknown HHT PX keyword for MCP harvest${harvest.keyword ? `: ${harvest.keyword}` : harvest.keywordId ? `: #${harvest.keywordId}` : ''}`)
      continue
    }
    const payloadError = mcpPayloadError(harvest.payload)
    if (payloadError && !mcpNothingFound(payloadError)) {
      await recordJob(database, {
        runId,
        stage: 'semrush_serps',
        provider: 'semrush_mcp',
        target: `${item.keyword}|us`,
        status: 'failed',
        error: payloadError,
      })
      await database
        .update(hhtPxKeywords)
        .set({ serpStatus: 'failed', updatedAt: new Date() })
        .where(eq(hhtPxKeywords.id, item.id))
      errors.push(`${item.keyword}: ${payloadError}`)
      continue
    }
    await persistHhtPxSerpRows(database, {
      runId,
      keywordId: item.id,
      cluster: item.cluster,
      keyword: item.keyword,
      rows: payloadError ? [] : serpRowsFromMcpPayload(harvest.payload),
    })
    processed += 1
  }
  const error = errors.length ? errors.join('; ') : null
  await touchRun(database, runId, { status: 'paused', currentStage: 'serp_classification', error })
  return { processed, queued: 0, cached: 0, error, runId, preview }
}

async function applySnapshotMetrics(database: Database, snapshotId: number, cluster: HhtPxCluster): Promise<void> {
  const results = await database.select().from(hhtPxSerpResults).where(eq(hhtPxSerpResults.snapshotId, snapshotId))
  const types = results.map((row) => row.pageType)
  const editorial = editorialDensity(types)
  const prospectable = prospectableDensity(results)
  const competitorCount = results.filter((row) => row.pageType === 'direct_hht_competitor' || row.competitorStrength === 'direct').length
  const uniqueProspectDomains = new Set(results.filter((row) => row.isProspectable).map((row) => row.rootDomain)).size
  const [keyword] = await database
    .select({
      keywordId: hhtPxSerpSnapshots.keywordId,
      volume: hhtPxKeywordVolumes.nationalDestinationVolume,
      geoHotel: hhtPxGeographies.hotelCount,
      geoPrivate: hhtPxGeographies.privateHotTubCount,
      geoShared: hhtPxGeographies.sharedHotTubCount,
      geoEditors: hhtPxGeographies.editorsChoiceCount,
    })
    .from(hhtPxSerpSnapshots)
    .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxSerpSnapshots.keywordId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .where(eq(hhtPxSerpSnapshots.id, snapshotId))
    .limit(1)
  const [yieldRow] = await database
    .select()
    .from(hhtPxClusterYields)
    .where(eq(hhtPxClusterYields.cluster, cluster))
    .limit(1)
  const score = scoreHhtPxKeyword({
    prospectableDensity: prospectable,
    editorialDensity: editorial,
    avgMonthlySearches: keyword?.volume ?? null,
    cluster,
    inventoryFit: inventoryFit({
      hotelCount: keyword?.geoHotel ?? null,
      privateHotTubCount: keyword?.geoPrivate ?? null,
      sharedHotTubCount: keyword?.geoShared ?? null,
      editorsChoiceCount: keyword?.geoEditors ?? null,
    }),
    uniqueProspectDomains,
    resultCount: results.length,
    clusterYield: yieldRow?.avgProspectsPerSerp ?? null,
    serpChecked: true,
  })
  await database
    .update(hhtPxSerpSnapshots)
    .set({
      editorialDensity: editorial,
      prospectableDensity: prospectable,
      competitorCount,
      uniqueProspectDomains,
      keywordOpportunityScore: score,
      resultCount: results.length,
    })
    .where(eq(hhtPxSerpSnapshots.id, snapshotId))
}

async function markSerpEquivalents(database: Database, keywordId: number): Promise<void> {
  const [keyword] = await database.select().from(hhtPxKeywords).where(eq(hhtPxKeywords.id, keywordId)).limit(1)
  if (!keyword) return
  const urls = (
    await database
      .select({ url: hhtPxSerpResults.normalizedUrl })
      .from(hhtPxSerpResults)
      .innerJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.id, hhtPxSerpResults.snapshotId))
      .where(eq(hhtPxSerpSnapshots.keywordId, keywordId))
  ).map((row) => row.url)
  const siblings = await database
    .select({ id: hhtPxKeywords.id })
    .from(hhtPxKeywords)
    .innerJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.keywordId, hhtPxKeywords.id))
    .where(
      and(
        eq(hhtPxKeywords.variantGroup, keyword.variantGroup),
        keyword.geographyId == null ? isNull(hhtPxKeywords.geographyId) : eq(hhtPxKeywords.geographyId, keyword.geographyId),
        sql`${hhtPxKeywords.id} <> ${keywordId}`,
      ),
    )
  for (const sibling of siblings) {
    const siblingUrls = (
      await database
        .select({ url: hhtPxSerpResults.normalizedUrl })
        .from(hhtPxSerpResults)
        .innerJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.id, hhtPxSerpResults.snapshotId))
        .where(eq(hhtPxSerpSnapshots.keywordId, sibling.id))
    ).map((row) => row.url)
    if (serpUrlOverlap(urls, siblingUrls) >= HHT_PX_SERP_OVERLAP_THRESHOLD) {
      await database
        .update(hhtPxKeywords)
        .set({ serpEquivalent: true, serpStatus: 'skipped', updatedAt: new Date() })
        .where(inArray(hhtPxKeywords.id, [keywordId, sibling.id].filter((id) => id !== keyword.id || sibling.id !== keyword.id)))
      await database
        .update(hhtPxKeywords)
        .set({ serpEquivalent: true, updatedAt: new Date() })
        .where(eq(hhtPxKeywords.id, sibling.id))
    }
  }
}

export async function overrideHhtPxSerpResult(
  database: Database,
  resultId: number,
  patch: { pageType?: HhtPxPageType; isProspectable?: boolean },
): Promise<void> {
  const [row] = await database.select().from(hhtPxSerpResults).where(eq(hhtPxSerpResults.id, resultId)).limit(1)
  if (!row) throw new Error('SERP result not found')
  const pageType = patch.pageType ?? row.pageType
  const competitor = row.competitorStrength
  const isProspectable =
    patch.isProspectable ?? isProspectablePageType(pageType, competitor)
  await database
    .update(hhtPxSerpResults)
    .set({
      pageType,
      isProspectable,
      manualOverride: true,
      updatedAt: new Date(),
    })
    .where(eq(hhtPxSerpResults.id, resultId))
  const [snapshot] = await database.select().from(hhtPxSerpSnapshots).where(eq(hhtPxSerpSnapshots.id, row.snapshotId)).limit(1)
  if (!snapshot) return
  const [keyword] = await database.select().from(hhtPxKeywords).where(eq(hhtPxKeywords.id, snapshot.keywordId)).limit(1)
  if (keyword) await applySnapshotMetrics(database, snapshot.id, keyword.cluster)
}

export async function reclassifyHhtPxSerpResults(
  database: Database,
  options: PipelineLimitOptions = {},
): Promise<{ updated: number; skipped: number; runId: number }> {
  const runId = await ensureRun(database, options.runId)
  await touchRun(database, runId, { status: 'running', currentStage: 'serp_classification' })
  const rows = await database.select().from(hhtPxSerpResults)
  let updated = 0
  let skipped = 0
  const snapshotIds = new Set<number>()
  for (const row of rows) {
    if (row.manualOverride) {
      skipped += 1
      continue
    }
    const classified = classifyHhtPxSerpResult({
      url: row.url,
      domain: row.rootDomain,
      title: row.title,
      snippet: row.snippet,
    })
    if (
      classified.pageType === row.pageType &&
      classified.isProspectable === row.isProspectable &&
      classified.competitorStrength === row.competitorStrength &&
      classified.excludedByRule === row.excludedByRule
    ) {
      continue
    }
    await database
      .update(hhtPxSerpResults)
      .set({
        pageType: classified.pageType,
        isProspectable: classified.isProspectable,
        competitorStrength: classified.competitorStrength,
        excludedByRule: classified.excludedByRule,
        classificationReason: classified.reason,
        updatedAt: new Date(),
      })
      .where(eq(hhtPxSerpResults.id, row.id))
    snapshotIds.add(row.snapshotId)
    updated += 1
  }
  for (const snapshotId of snapshotIds) {
    const [snapshot] = await database
      .select({ id: hhtPxSerpSnapshots.id, keywordId: hhtPxSerpSnapshots.keywordId })
      .from(hhtPxSerpSnapshots)
      .where(eq(hhtPxSerpSnapshots.id, snapshotId))
      .limit(1)
    if (!snapshot) continue
    const [keyword] = await database
      .select({ cluster: hhtPxKeywords.cluster })
      .from(hhtPxKeywords)
      .where(eq(hhtPxKeywords.id, snapshot.keywordId))
      .limit(1)
    if (keyword) await applySnapshotMetrics(database, snapshot.id, keyword.cluster)
  }
  await touchRun(database, runId, { status: 'paused', currentStage: 'page_deduplication' })
  return { updated, skipped, runId }
}

export async function aggregateHhtPxProspects(database: Database, runId?: number): Promise<{ pages: number; domains: number; runId: number }> {
  const id = await ensureRun(database, runId)
  await touchRun(database, id, { status: 'running', currentStage: 'page_deduplication' })
  await database.update(hhtPxProspectPages).set({ isProspectable: false, updatedAt: new Date() })
  await database.update(hhtPxProspectDomains).set({ isProspectable: false, updatedAt: new Date() })
  const matches = await database
    .select({
      resultId: hhtPxSerpResults.id,
      snapshotId: hhtPxSerpSnapshots.id,
      keywordId: hhtPxKeywords.id,
      cluster: hhtPxKeywords.cluster,
      keyword: hhtPxKeywords.keyword,
      volume: hhtPxKeywordVolumes.nationalDestinationVolume,
      keywordScore: hhtPxSerpSnapshots.keywordOpportunityScore,
      position: hhtPxSerpResults.position,
      url: hhtPxSerpResults.url,
      normalizedUrl: hhtPxSerpResults.normalizedUrl,
      rootDomain: hhtPxSerpResults.rootDomain,
      title: hhtPxSerpResults.title,
      pageType: hhtPxSerpResults.pageType,
      isProspectable: hhtPxSerpResults.isProspectable,
      competitorStrength: hhtPxSerpResults.competitorStrength,
      geoName: hhtPxGeographies.name,
      geoType: hhtPxGeographies.type,
      geoState: hhtPxGeographies.state,
      geoSlug: hhtPxGeographies.hhtSlug,
      hotelCount: hhtPxGeographies.hotelCount,
      privateCount: hhtPxGeographies.privateHotTubCount,
      sharedCount: hhtPxGeographies.sharedHotTubCount,
      editorsCount: hhtPxGeographies.editorsChoiceCount,
    })
    .from(hhtPxSerpResults)
    .innerJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.id, hhtPxSerpResults.snapshotId))
    .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxSerpSnapshots.keywordId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))

  const overrides = new Map(
    (await database.select().from(hhtPxDomainOverrides)).map((row) => [row.rootDomain, row]),
  )

  const byPage = new Map<string, typeof matches>()
  for (const row of matches) {
    if (row.pageType === 'ota' || row.pageType === 'hotel' || row.pageType === 'hotel_chain' || row.pageType === 'social_media' || row.pageType === 'reddit' || row.pageType === 'maps' || row.pageType === 'search_engine' || row.pageType === 'coupon_site' || row.pageType === 'spam_site' || row.pageType === 'direct_hht_competitor' || row.pageType === 'directory' || row.pageType === 'ugc_forum' || row.pageType === 'irrelevant') {
      continue
    }
    const list = byPage.get(row.normalizedUrl) ?? []
    list.push(row)
    byPage.set(row.normalizedUrl, list)
  }

  for (const [normalizedUrl, rows] of byPage) {
    const primary = rows[0]!
    const override = overrides.get(primary.rootDomain)
    const pageType = override?.pageType ?? primary.pageType
    const competitor = override?.competitorStrength ?? strongestCompetitor(rows.map((row) => row.competitorStrength))
    const isProspectable = override?.isProspectable ?? (rows.some((row) => row.isProspectable) && competitor !== 'direct')
    const [domain] = await database
      .insert(hhtPxProspectDomains)
      .values({
        rootDomain: primary.rootDomain,
        domainType: pageType,
        competitorStrength: competitor,
        isProspectable,
      })
      .onConflictDoNothing()
      .returning()
    const domainId =
      domain?.id ??
      (
        await database
          .select({ id: hhtPxProspectDomains.id })
          .from(hhtPxProspectDomains)
          .where(eq(hhtPxProspectDomains.rootDomain, primary.rootDomain))
          .limit(1)
      )[0]?.id
    if (!domainId) continue

    const volumes = rows.map((row) => row.volume)
    const positions = rows.map((row) => row.position)
    const geographies = rows
      .filter((row) => row.geoName)
      .map((row) => ({
        name: row.geoName!,
        type: row.geoType!,
        state: row.geoState,
        hhtSlug: row.geoSlug,
      }))
    const cluster = rows.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1))[0]!.cluster
    const target = recommendHhtTargetUrl({ geographies, cluster })
    const why = whyTheyCouldLink({
      cluster,
      geographyName: geographies[0]?.name ?? null,
      pageTitle: primary.title,
    })
    const keywordOpportunity = rows
      .map((row) => row.keywordScore)
      .filter((n): n is number => n != null)
      .sort((a, b) => b - a)[0] ?? null
    const inv = inventoryFit({
      hotelCount: primary.hotelCount,
      privateHotTubCount: primary.privateCount,
      sharedHotTubCount: primary.sharedCount,
      editorsChoiceCount: primary.editorsCount,
    })
    const pageScore = scoreHhtPxPage({
      pageType,
      competitorStrength: competitor,
      isProspectable,
      cluster,
      keywordOpportunity,
      bestPosition: Math.min(...positions),
      maxKeywordVolume: estimatedNonduplicatedDemand(volumes),
      matchedKeywordCount: rows.length,
      authorityScore: null,
      inventoryFit: inv,
      independentPublisher:
        pageType === 'travel_blog' ||
        pageType === 'lifestyle_blog' ||
        pageType === 'local_media' ||
        pageType === 'editorial_travel_site',
    })

    const [page] = await database
      .insert(hhtPxProspectPages)
      .values({
        domainId,
        url: primary.url,
        normalizedUrl,
        title: primary.title,
        pageType,
        isProspectable,
        competitorStrength: competitor,
        matchedKeywordCount: rows.length,
        maxKeywordVolume: estimatedNonduplicatedDemand(volumes),
        bestPosition: Math.min(...positions),
        avgPosition: positions.reduce((sum, n) => sum + n, 0) / positions.length,
        estimatedNondupDemand: estimatedNonduplicatedDemand(volumes),
        topicalFit: HHT_PX_CLUSTER_TOPICAL_FIT[cluster],
        linkFit: pageScore,
        opportunityScore: pageScore,
        suggestedHhtUrl: target.url,
        whyLinkCategory: why.category,
        whyLink: why.explanation,
      })
      .onConflictDoUpdate({
        target: [hhtPxProspectPages.normalizedUrl],
        set: {
          title: primary.title,
          pageType,
          isProspectable,
          competitorStrength: competitor,
          matchedKeywordCount: rows.length,
          maxKeywordVolume: estimatedNonduplicatedDemand(volumes),
          bestPosition: Math.min(...positions),
          avgPosition: positions.reduce((sum, n) => sum + n, 0) / positions.length,
          estimatedNondupDemand: estimatedNonduplicatedDemand(volumes),
          topicalFit: HHT_PX_CLUSTER_TOPICAL_FIT[cluster],
          opportunityScore: pageScore,
          suggestedHhtUrl: target.url,
          whyLinkCategory: why.category,
          whyLink: why.explanation,
          updatedAt: new Date(),
        },
      })
      .returning({ id: hhtPxProspectPages.id })
    const pageId =
      page?.id ??
      (
        await database
          .select({ id: hhtPxProspectPages.id })
          .from(hhtPxProspectPages)
          .where(eq(hhtPxProspectPages.normalizedUrl, normalizedUrl))
          .limit(1)
      )[0]?.id
    if (!pageId) continue
    await database.delete(hhtPxPageKeywordMatches).where(eq(hhtPxPageKeywordMatches.pageId, pageId))
    await database.insert(hhtPxPageKeywordMatches).values(
      uniqueBy(
        rows.map((row) => ({
          pageId,
          keywordId: row.keywordId,
          snapshotId: row.snapshotId,
          position: row.position,
          volume: row.volume,
        })),
        (row) => `${row.pageId}:${row.keywordId}`,
      ),
    )
  }

  await database.delete(hhtPxProspectPages).where(eq(hhtPxProspectPages.isProspectable, false))
  await database.delete(hhtPxProspectDomains).where(
    sql`${hhtPxProspectDomains.id} not in (select ${hhtPxProspectPages.domainId} from ${hhtPxProspectPages})`,
  )

  await rollupDomains(database)
  await refreshClusterYields(database)
  const pages = (await database.select({ id: hhtPxProspectPages.id }).from(hhtPxProspectPages)).length
  const domains = (await database.select({ id: hhtPxProspectDomains.id }).from(hhtPxProspectDomains)).length
  await touchRun(database, id, { status: 'paused', currentStage: 'domain_enrichment', progress: { pages, domains } })
  return { pages, domains, runId: id }
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const k = key(row)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(row)
  }
  return out
}

function strongestCompetitor(
  values: Array<'none' | 'weak' | 'moderate' | 'direct'>,
): 'none' | 'weak' | 'moderate' | 'direct' {
  if (values.includes('direct')) return 'direct'
  if (values.includes('moderate')) return 'moderate'
  if (values.includes('weak')) return 'weak'
  return 'none'
}

async function rollupDomains(database: Database): Promise<void> {
  const pages = await database.select().from(hhtPxProspectPages)
  const byDomain = new Map<number, typeof pages>()
  for (const page of pages) {
    const list = byDomain.get(page.domainId) ?? []
    list.push(page)
    byDomain.set(page.domainId, list)
  }
  for (const [domainId, rows] of byDomain) {
    const matches = await database
      .select({
        keywordId: hhtPxPageKeywordMatches.keywordId,
        geographyId: hhtPxKeywords.geographyId,
        cluster: hhtPxKeywords.cluster,
      })
      .from(hhtPxPageKeywordMatches)
      .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxPageKeywordMatches.keywordId))
      .where(
        inArray(
          hhtPxPageKeywordMatches.pageId,
          rows.map((row) => row.id),
        ),
      )
    const best = [...rows].sort((a, b) => (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1))[0]!
    const [domain] = await database.select().from(hhtPxProspectDomains).where(eq(hhtPxProspectDomains.id, domainId)).limit(1)
    if (!domain) continue
    const score = scoreHhtPxDomain({
      pageCount: rows.filter((row) => row.isProspectable).length,
      geographyCount: new Set(matches.map((row) => row.geographyId).filter(Boolean)).size,
      clusterCount: new Set(matches.map((row) => row.cluster)).size,
      bestPageScore: best.opportunityScore,
      authorityScore: domain.authorityScore,
      organicTraffic: domain.organicTraffic,
      competitorStrength: strongestCompetitor(rows.map((row) => row.competitorStrength)),
      isProspectable: rows.some((row) => row.isProspectable),
    })
    await database
      .update(hhtPxProspectDomains)
      .set({
        pageCount: rows.length,
        keywordCount: new Set(matches.map((row) => row.keywordId)).size,
        geographyCount: new Set(matches.map((row) => row.geographyId).filter(Boolean)).size,
        clusterCount: new Set(matches.map((row) => row.cluster)).size,
        strongestPageId: best.id,
        bestPosition: Math.min(...rows.map((row) => row.bestPosition ?? 99)),
        maxKeywordVolume: estimatedNonduplicatedDemand(rows.map((row) => row.maxKeywordVolume)),
        opportunityScore: score,
        isProspectable: rows.some((row) => row.isProspectable),
        competitorStrength: strongestCompetitor(rows.map((row) => row.competitorStrength)),
        domainType: best.pageType,
        updatedAt: new Date(),
      })
      .where(eq(hhtPxProspectDomains.id, domainId))
  }
}

async function refreshClusterYields(database: Database): Promise<void> {
  const snapshots = await database
    .select({
      cluster: hhtPxKeywords.cluster,
      editorial: hhtPxSerpSnapshots.editorialDensity,
      prospectable: hhtPxSerpSnapshots.prospectableDensity,
      uniqueProspects: hhtPxSerpSnapshots.uniqueProspectDomains,
      score: hhtPxSerpSnapshots.keywordOpportunityScore,
    })
    .from(hhtPxSerpSnapshots)
    .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxSerpSnapshots.keywordId))
  const byCluster = new Map<HhtPxCluster, typeof snapshots>()
  for (const row of snapshots) {
    const list = byCluster.get(row.cluster) ?? []
    list.push(row)
    byCluster.set(row.cluster, list)
  }
  for (const [cluster, rows] of byCluster) {
    const prospectablePages = rows.reduce((sum, row) => sum + (row.uniqueProspects ?? 0), 0)
    const avgPageScore =
      rows.map((row) => row.score).filter((n): n is number => n != null).reduce((sum, n, _, all) => sum + n / all.length, 0) || null
    await database
      .insert(hhtPxClusterYields)
      .values({
        cluster,
        serpCount: rows.length,
        prospectablePages,
        avgEditorialDensity: avg(rows.map((row) => row.editorial)),
        avgProspectableDensity: avg(rows.map((row) => row.prospectable)),
        avgProspectsPerSerp: expectedProspectsPerSerpCall({ serpCount: rows.length, prospectablePages }),
        qualityAdjustedPerSerp: qualityAdjustedProspectsPerSerpCall({
          serpCount: rows.length,
          prospectablePages,
          avgPageScore,
        }),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [hhtPxClusterYields.cluster],
        set: {
          serpCount: rows.length,
          prospectablePages,
          avgEditorialDensity: avg(rows.map((row) => row.editorial)),
          avgProspectableDensity: avg(rows.map((row) => row.prospectable)),
          avgProspectsPerSerp: expectedProspectsPerSerpCall({ serpCount: rows.length, prospectablePages }),
          qualityAdjustedPerSerp: qualityAdjustedProspectsPerSerpCall({
            serpCount: rows.length,
            prospectablePages,
            avgPageScore,
          }),
          updatedAt: new Date(),
        },
      })
  }
}

function avg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((n): n is number => n != null)
  if (nums.length === 0) return null
  return nums.reduce((sum, n) => sum + n, 0) / nums.length
}

export async function enrichHhtPxDomains(
  database: Database,
  options: PipelineLimitOptions = {},
): Promise<{ processed: number; skipped: number; queued: number; error: string | null; runId: number; domains: string[] }> {
  const runId = await ensureRun(database, options.runId)
  if (options.mcpDomainHarvests?.length) {
    return ingestHhtPxMcpDomainEnrichment(database, options.mcpDomainHarvests, { ...options, runId })
  }
  const limit = Math.max(1, options.limit ?? DEFAULT_ENRICH_LIMIT)
  const enrichWhere = options.retryFailed
    ? eq(hhtPxProspectDomains.isProspectable, true)
    : and(eq(hhtPxProspectDomains.isProspectable, true), isNull(hhtPxProspectDomains.enrichedAt))
  const pending = await database
    .select({ rootDomain: hhtPxProspectDomains.rootDomain })
    .from(hhtPxProspectDomains)
    .where(enrichWhere)
    .orderBy(sql`${hhtPxProspectDomains.opportunityScore} desc nulls last`)
    .limit(limit)
  const domains = pending.map((row) => row.rootDomain)
  await touchRun(database, runId, {
    status: 'waiting',
    currentStage: 'domain_enrichment',
    error: HHT_PX_MCP_ENRICH_MESSAGE,
  })
  return {
    processed: 0,
    skipped: 0,
    queued: domains.length,
    error: HHT_PX_MCP_ENRICH_MESSAGE,
    runId,
    domains,
  }
}

export async function ingestHhtPxMcpDomainEnrichment(
  database: Database,
  harvests: HhtPxMcpDomainHarvest[],
  options: PipelineLimitOptions = {},
): Promise<{ processed: number; skipped: number; queued: number; error: string | null; runId: number; domains: string[] }> {
  const runId = await ensureRun(database, options.runId)
  await touchRun(database, runId, { status: 'running', currentStage: 'domain_enrichment' })
  let processed = 0
  for (const harvest of harvests) {
    const [domain] = await database
      .select()
      .from(hhtPxProspectDomains)
      .where(eq(hhtPxProspectDomains.rootDomain, harvest.domain))
      .limit(1)
    if (!domain) {
      const message = `Unknown prospect domain for MCP harvest: ${harvest.domain}`
      await touchRun(database, runId, { status: 'paused', error: message })
      return { processed, skipped: 0, queued: 0, error: message, runId, domains: harvests.map((row) => row.domain) }
    }
    const overview = harvest.overviewPayload ? domainOverviewFromMcpPayload(harvest.overviewPayload) : null
    const backlinks = harvest.backlinksPayload ? backlinksFromMcpPayload(harvest.backlinksPayload) : null
    await database
      .update(hhtPxProspectDomains)
      .set({
        authorityScore: backlinks?.authorityScore ?? domain.authorityScore,
        referringDomains: backlinks?.referringDomains ?? domain.referringDomains,
        backlinks: backlinks?.backlinks ?? domain.backlinks,
        organicTraffic: overview?.organicTraffic ?? domain.organicTraffic,
        rankingKeywords: overview?.rankingKeywords ?? domain.rankingKeywords,
        enrichedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hhtPxProspectDomains.id, domain.id))
    await recordJob(database, {
      runId,
      stage: 'domain_enrichment',
      provider: 'semrush_mcp',
      target: harvest.domain,
      status: 'complete',
      recordsCompleted: 1,
      estimatedUnits: 2,
    })
    processed += 1
  }
  await rollupDomains(database)
  await touchRun(database, runId, { status: 'paused', currentStage: 'opportunity_scoring', error: null })
  return { processed, skipped: 0, queued: 0, error: null, runId, domains: harvests.map((row) => row.domain) }
}

export async function expandHhtPxKeywordIdeas(
  database: Database,
  options: { limit?: number } = {},
): Promise<{ inserted: number; error: string | null }> {
  const result = await fetchKeywordIdeas([...HHT_PX_KEYWORD_IDEA_SEEDS], {
    geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US],
    pageSize: options.limit ?? 100,
  })
  if (result.source !== 'google_ads') return { inserted: 0, error: result.error }
  const existing = new Set(
    (await database.select({ keywordNorm: hhtPxKeywords.keywordNorm }).from(hhtPxKeywords)).map((row) => row.keywordNorm),
  )
  let inserted = 0
  for (const idea of result.ideas) {
    const keywordNorm = idea.keyword.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()
    if (!keywordNorm || existing.has(keywordNorm)) continue
    await database.insert(hhtPxKeywords).values({
      keyword: idea.keyword,
      keywordNorm,
      cluster: 'national_editorial',
      variantGroup: 'google_keyword_ideas',
      source: 'google_keyword_ideas',
      priority: 'medium',
      expectedLinkability: 'high',
      promoted: false,
    })
    existing.add(keywordNorm)
    inserted += 1
  }
  return { inserted, error: null }
}

export async function promoteHhtPxKeywordIdeas(database: Database, keywordIds: number[]): Promise<number> {
  if (keywordIds.length === 0) return 0
  await database
    .update(hhtPxKeywords)
    .set({ promoted: true, updatedAt: new Date() })
    .where(inArray(hhtPxKeywords.id, keywordIds))
  return keywordIds.length
}

export async function pauseHhtPxRun(database: Database, runId?: number): Promise<void> {
  const id = await ensureRun(database, runId)
  await touchRun(database, id, { status: 'paused' })
}

export async function getLatestHhtPxRun(database: Database) {
  const [run] = await database.select().from(hhtPxPipelineRuns).orderBy(sql`${hhtPxPipelineRuns.id} desc`).limit(1)
  return run ?? null
}
