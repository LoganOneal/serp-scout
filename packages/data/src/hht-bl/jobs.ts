import 'server-only'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { HhtBlJobStatus, HhtBlStage } from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtBlCandidateSites,
  hhtBlJobs,
  hhtBlKeywords,
  hhtBlResearchSites,
  hhtBlRunEvents,
  hhtBlRuns,
  hhtBlSiteClassifications,
  hhtBlSiteMetrics,
  sites,
} from '../schema.js'
import {
  activeHhtBlProfile,
  buildHhtBlKeywordUniverse,
  expandHhtBlKeywordSample,
  loadHhtBlConfig,
  sampleHhtBlKeywords,
} from './config.js'
import {
  applyHhtSemrushRequestFilters,
  classifySemrushError,
  resumeSemrushInstruction,
  semrushRequestKey,
} from './semrush.js'

export async function createHhtBlRun(
  db: Database,
  options: { siteDomain?: string; name?: string; profile?: string } = {},
): Promise<{ runId: number; keywords: number; profile: string }> {
  const domain = options.siteDomain ?? 'hotelhottubs.com'
  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.domain, domain)).limit(1)
  if (!site) throw new Error(`No site record exists for ${domain}`)

  const config = await loadHhtBlConfig()
  const selected = activeHhtBlProfile(config, {
    ...process.env,
    ...(options.profile ? { HHT_BL_PROFILE: options.profile } : {}),
  })
  const [run] = await db
    .insert(hhtBlRuns)
    .values({
      siteId: site.id,
      name: options.name ?? `HotelHotTubs backlink research - ${selected.name}`,
      profile: selected.name,
      status: 'DRAFT',
      currentStage: 'keywords',
      configuration: selected.profile as unknown as Record<string, unknown>,
    })
    .returning({ id: hhtBlRuns.id })
  if (!run) throw new Error('failed to create HHT backlink run')

  const universe = buildHhtBlKeywordUniverse(config)
  const keywords = sampleHhtBlKeywords(universe, selected.profile.discovery.serp_sample_size)
  if (keywords.length > 0) {
    await db.insert(hhtBlKeywords).values(
      keywords.map((row) => ({
        runId: run.id,
        category: row.category,
        destination: row.destination,
        keyword: row.keyword,
      })),
    )
  }
  await recordHhtBlEvent(db, {
    runId: run.id,
    stage: 'keywords',
    message: `Built ${keywords.length} stratified pilot keywords`,
    recordsProcessed: keywords.length,
  })
  return { runId: run.id, keywords: keywords.length, profile: selected.name }
}

export async function expandHhtBlRunKeywords(
  db: Database,
  runId: number,
  target: number,
): Promise<{ added: number; total: number }> {
  const [run] = await db.select({ id: hhtBlRuns.id }).from(hhtBlRuns).where(eq(hhtBlRuns.id, runId)).limit(1)
  if (!run) throw new Error(`HHT backlink run ${runId} does not exist`)

  const config = await loadHhtBlConfig()
  const universe = buildHhtBlKeywordUniverse(config)
  const existing = await db
    .select({ keyword: hhtBlKeywords.keyword })
    .from(hhtBlKeywords)
    .where(eq(hhtBlKeywords.runId, runId))
  const additions = expandHhtBlKeywordSample(
    universe,
    existing.map((row) => row.keyword),
    target,
  )

  if (additions.length > 0) {
    await db.insert(hhtBlKeywords).values(
      additions.map((row) => ({
        runId,
        category: row.category,
        destination: row.destination,
        keyword: row.keyword,
      })),
    )
  }
  await db
    .update(hhtBlRuns)
    .set({ status: 'RUNNING', currentStage: 'keywords', finishedAt: null, updatedAt: new Date() })
    .where(eq(hhtBlRuns.id, runId))
  await recordHhtBlEvent(db, {
    runId,
    stage: 'keywords',
    message: `Expanded keyword sample from ${existing.length} to ${existing.length + additions.length}`,
    recordsProcessed: additions.length,
  })
  return { added: additions.length, total: existing.length + additions.length }
}

export interface CreateHhtBlJobInput {
  runId: number
  stage: HhtBlStage
  reportType: string
  target?: string | null
  parameters: Record<string, unknown>
  offset?: number
  limit?: number
}

export function hhtBlDomainValidationJob(
  runId: number,
  domain: string,
): CreateHhtBlJobInput {
  return {
    runId,
    stage: 'site_enrichment',
    reportType: 'domain_rank',
    target: domain,
    parameters: {
      target: domain,
      database: 'us',
      export_columns: ['domain', 'organic_keywords', 'organic_traffic', 'organic_traffic_cost'],
    },
    limit: 1,
  }
}

export function hhtBlSiteExpansionJobs(
  runId: number,
  domain: string,
  options: { organicLimit: number; backlinkLimit: number },
): CreateHhtBlJobInput[] {
  return [
    {
      runId,
      stage: 'competitor_discovery',
      reportType: 'domain_organic_organic',
      target: domain,
      parameters: {
        domain,
        database: 'us',
        display_limit: options.organicLimit,
        export_columns: [
          'domain',
          'competition_level',
          'common_keywords',
          'organic_keywords',
          'organic_traffic',
          'organic_traffic_cost',
        ],
      },
      limit: options.organicLimit,
    },
    {
      runId,
      stage: 'competitor_discovery',
      reportType: 'backlinks_competitors',
      target: domain,
      parameters: {
        target: domain,
        target_type: 'root_domain',
        display_limit: options.backlinkLimit,
        export_columns: [
          'score',
          'neighbour',
          'similarity',
          'common_refdomains',
          'domains_num',
          'backlinks_num',
        ],
      },
      limit: options.backlinkLimit,
    },
  ]
}

export async function parkHhtBlSerpJobs(
  db: Database,
  runId: number,
): Promise<number> {
  const parked = await db
    .update(hhtBlJobs)
    .set({ status: 'CANCELLED', error: 'Parked after site-first discovery superseded keyword expansion', updatedAt: new Date() })
    .where(
      and(
        eq(hhtBlJobs.runId, runId),
        eq(hhtBlJobs.stage, 'serp_discovery'),
        inArray(hhtBlJobs.status, ['PENDING', 'WAITING_FOR_CREDENTIALS']),
      ),
    )
    .returning({ id: hhtBlJobs.id })
  await db
    .update(hhtBlRuns)
    .set({
      status: 'RUNNING',
      currentStage: 'competitor_discovery',
      waitingReason: null,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(hhtBlRuns.id, runId))
  await recordHhtBlEvent(db, {
    runId,
    stage: 'serp_discovery',
    message: `Parked ${parked.length} keyword jobs; completed SERPs remain available as domain evidence`,
    recordsProcessed: parked.length,
  })
  return parked.length
}

export async function queueHhtBlDomainValidationJobs(
  db: Database,
  runId: number,
  limit: number,
): Promise<{ considered: number; created: number }> {
  const candidates = await db
    .select({ domain: hhtBlCandidateSites.domain })
    .from(hhtBlCandidateSites)
    .leftJoin(hhtBlSiteMetrics, eq(hhtBlSiteMetrics.candidateSiteId, hhtBlCandidateSites.id))
    .where(and(eq(hhtBlCandidateSites.runId, runId), isNull(hhtBlSiteMetrics.estimatedOrganicTraffic)))
    .orderBy(desc(hhtBlCandidateSites.weightedVisibility), hhtBlCandidateSites.discoveryDepth)
    .limit(limit)
  let created = 0
  for (const candidate of candidates) {
    if ((await createHhtBlJob(db, hhtBlDomainValidationJob(runId, candidate.domain))).created) {
      created += 1
    }
  }
  return { considered: candidates.length, created }
}

export async function queueHhtBlSiteExpansionJobs(
  db: Database,
  runId: number,
  options: { seedLimit: number; organicLimit: number; backlinkLimit: number },
): Promise<{ seeds: string[]; created: number }> {
  const excludedTypes = ['OTA', 'major_travel_brand', 'hotel_brand', 'UGC_platform', 'general_publisher'] as const
  const rows = await db
    .select({
      domain: hhtBlCandidateSites.domain,
      siteType: hhtBlSiteClassifications.siteType,
    })
    .from(hhtBlCandidateSites)
    .innerJoin(
      hhtBlSiteClassifications,
      eq(hhtBlSiteClassifications.candidateSiteId, hhtBlCandidateSites.id),
    )
    .leftJoin(hhtBlSiteMetrics, eq(hhtBlSiteMetrics.candidateSiteId, hhtBlCandidateSites.id))
    .where(
      and(
        eq(hhtBlCandidateSites.runId, runId),
        isNotNull(hhtBlCandidateSites.researchValueScore),
        isNotNull(hhtBlSiteMetrics.estimatedOrganicTraffic),
      ),
    )
    .orderBy(desc(hhtBlCandidateSites.researchValueScore), desc(hhtBlSiteMetrics.estimatedOrganicTraffic))
  const seeds = rows
    .filter((row) => !excludedTypes.includes(row.siteType as (typeof excludedTypes)[number]))
    .slice(0, options.seedLimit)
    .map((row) => row.domain)
  let created = 0
  for (const domain of seeds) {
    for (const input of hhtBlSiteExpansionJobs(runId, domain, options)) {
      if ((await createHhtBlJob(db, input)).created) created += 1
    }
  }
  await db
    .update(hhtBlRuns)
    .set({ status: 'RUNNING', currentStage: 'competitor_discovery', updatedAt: new Date() })
    .where(eq(hhtBlRuns.id, runId))
  return { seeds, created }
}

export async function queueHhtBlBacklinkCollectionJobs(
  db: Database,
  runId: number,
  options: { siteLimit: number; referringDomainLimit: number; backlinkLimit: number },
): Promise<{ sites: string[]; created: number }> {
  const rows = await db
    .select({ domain: hhtBlCandidateSites.domain })
    .from(hhtBlResearchSites)
    .innerJoin(
      hhtBlCandidateSites,
      eq(hhtBlResearchSites.candidateSiteId, hhtBlCandidateSites.id),
    )
    .where(and(eq(hhtBlResearchSites.runId, runId), eq(hhtBlResearchSites.active, true)))
    .orderBy(hhtBlResearchSites.rank)
    .limit(options.siteLimit)
  let created = 0
  for (const row of rows) {
    const inputs: CreateHhtBlJobInput[] = [
      {
        runId,
        stage: 'backlink_collection',
        reportType: 'backlinks_refdomains',
        target: row.domain,
        parameters: {
          target: row.domain,
          target_type: 'root_domain',
          display_sort: 'domain_authority_score_desc',
          display_limit: options.referringDomainLimit,
          export_columns: [
            'domain_authority_score',
            'domain_score',
            'domain',
            'backlinks_num',
            'first_seen',
            'last_seen',
          ],
        },
        limit: options.referringDomainLimit,
      },
      {
        runId,
        stage: 'backlink_collection',
        reportType: 'backlinks',
        target: row.domain,
        parameters: {
          target: row.domain,
          target_type: 'root_domain',
          display_sort: 'page_authority_score_desc',
          display_limit: options.backlinkLimit,
          export_columns: [
            'page_authority_score',
            'page_score',
            'response_code',
            'source_url',
            'source_title',
            'target_url',
            'target_title',
            'anchor',
            'first_seen',
            'last_seen',
            'nofollow',
            'sitewide',
            'newlink',
            'lostlink',
          ],
        },
        limit: options.backlinkLimit,
      },
    ]
    for (const input of inputs) {
      if ((await createHhtBlJob(db, input)).created) created += 1
    }
  }
  return { sites: rows.map((row) => row.domain), created }
}

export async function createHhtBlJob(
  db: Database,
  input: CreateHhtBlJobInput,
): Promise<{ id: number; created: boolean }> {
  const safeParameters = applyHhtSemrushRequestFilters(input.reportType, input.parameters)
  const offset = input.offset ?? Number(safeParameters['display_offset'] ?? 0)
  const limit = input.limit ?? Number(safeParameters['display_limit'] ?? 50)
  const stableParameters = { ...safeParameters }
  delete stableParameters['display_offset']
  const requestKey = semrushRequestKey(input.reportType, {
    ...stableParameters,
    target: input.target ?? null,
  })

  const inserted = await db
    .insert(hhtBlJobs)
    .values({
      runId: input.runId,
      stage: input.stage,
      reportType: input.reportType,
      ...(input.target === undefined ? {} : { target: input.target }),
      parameters: stableParameters,
      requestKey,
      offset,
      limit,
      rowsRequested: limit,
    })
    .onConflictDoNothing()
    .returning({ id: hhtBlJobs.id })
  if (inserted[0]) return { id: inserted[0].id, created: true }

  const [existing] = await db
    .select({ id: hhtBlJobs.id })
    .from(hhtBlJobs)
    .where(and(eq(hhtBlJobs.runId, input.runId), eq(hhtBlJobs.requestKey, requestKey)))
    .limit(1)
  if (!existing) throw new Error('job conflict occurred but existing job could not be read')
  return { id: existing.id, created: false }
}

export async function markHhtBlJobStarted(
  db: Database,
  jobId: number,
  accountIdentifier?: string | null,
): Promise<void> {
  await db
    .update(hhtBlJobs)
    .set({
      status: 'RUNNING',
      ...(accountIdentifier === undefined ? {} : { accountIdentifier }),
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(hhtBlJobs.id, jobId))
}

export async function markHhtBlJobError(
  db: Database,
  jobId: number,
  error: unknown,
): Promise<HhtBlJobStatus> {
  const [job] = await db.select().from(hhtBlJobs).where(eq(hhtBlJobs.id, jobId)).limit(1)
  if (!job) throw new Error(`HHT backlink job ${jobId} does not exist`)
  const message = error instanceof Error ? error.message : String(error)
  const kind = classifySemrushError(error)
  const status: HhtBlJobStatus = kind === 'RETRYABLE' ? 'PENDING' : kind

  await db
    .update(hhtBlJobs)
    .set({ status, error: message, attempts: job.attempts + 1, updatedAt: new Date() })
    .where(eq(hhtBlJobs.id, jobId))
  if (status === 'WAITING_FOR_CREDENTIALS') {
    await db
      .update(hhtBlRuns)
      .set({
        status,
        currentStage: job.stage,
        waitingReason: `${message}\n${resumeSemrushInstruction(jobId)}`,
        updatedAt: new Date(),
      })
      .where(eq(hhtBlRuns.id, job.runId))
  } else if (status === 'FAILED') {
    await db
      .update(hhtBlRuns)
      .set({ status: 'FAILED', currentStage: job.stage, error: message, updatedAt: new Date() })
      .where(eq(hhtBlRuns.id, job.runId))
  }
  await recordHhtBlEvent(db, {
    runId: job.runId,
    jobId,
    stage: job.stage,
    level: status === 'PENDING' ? 'warn' : 'error',
    message,
    provider: job.provider,
    retryCount: job.attempts + 1,
    details: { status, offset: job.offset, limit: job.limit },
  })
  return status
}

export async function resumeHhtBlJob(db: Database, jobId: number): Promise<void> {
  const [job] = await db.select().from(hhtBlJobs).where(eq(hhtBlJobs.id, jobId)).limit(1)
  if (!job) throw new Error(`HHT backlink job ${jobId} does not exist`)
  if (job.status !== 'WAITING_FOR_CREDENTIALS') {
    throw new Error(`Job ${jobId} is ${job.status}, not WAITING_FOR_CREDENTIALS`)
  }
  await db
    .update(hhtBlJobs)
    .set({ status: 'PENDING', error: null, updatedAt: new Date() })
    .where(eq(hhtBlJobs.id, jobId))
  await db
    .update(hhtBlRuns)
    .set({ status: 'RUNNING', waitingReason: null, error: null, updatedAt: new Date() })
    .where(eq(hhtBlRuns.id, job.runId))
  await recordHhtBlEvent(db, {
    runId: job.runId,
    jobId,
    stage: job.stage,
    message: `Job resumed at offset ${job.offset}; verify the replacement MCP account before collecting`,
    provider: job.provider,
  })
}

export async function latestHhtBlRun(db: Database, siteId: number) {
  const [run] = await db
    .select()
    .from(hhtBlRuns)
    .where(eq(hhtBlRuns.siteId, siteId))
    .orderBy(desc(hhtBlRuns.createdAt))
    .limit(1)
  return run ?? null
}

export async function recordHhtBlEvent(
  db: Database,
  event: {
    runId: number
    jobId?: number
    stage: HhtBlStage
    level?: string
    message: string
    domain?: string
    url?: string
    provider?: string
    recordsProcessed?: number
    recordsRemaining?: number
    retryCount?: number
    details?: Record<string, unknown>
  },
): Promise<void> {
  await db.insert(hhtBlRunEvents).values(event)
}
