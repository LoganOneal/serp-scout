import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import type { HhtBlJobStatus, HhtBlStage } from '@rnr/core'
import type { Database } from '../db.js'
import { hhtBlJobs, hhtBlKeywords, hhtBlRunEvents, hhtBlRuns, sites } from '../schema.js'
import { activeHhtBlProfile, buildHhtBlKeywordUniverse, loadHhtBlConfig, sampleHhtBlKeywords } from './config.js'
import { classifySemrushError, resumeSemrushInstruction, semrushRequestKey } from './semrush.js'

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

export interface CreateHhtBlJobInput {
  runId: number
  stage: HhtBlStage
  reportType: string
  target?: string | null
  parameters: Record<string, unknown>
  offset?: number
  limit?: number
}

export async function createHhtBlJob(
  db: Database,
  input: CreateHhtBlJobInput,
): Promise<{ id: number; created: boolean }> {
  const offset = input.offset ?? Number(input.parameters['display_offset'] ?? 0)
  const limit = input.limit ?? Number(input.parameters['display_limit'] ?? 50)
  const stableParameters = { ...input.parameters }
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
