/** Durable operator CLI for the inventory-first Hotel Backlink Scout. */
import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  closeDb,
  db,
  executeHotelBlRun,
  executeHotelBlUrlValidation,
  hotelBlDomains,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlRuns,
  importHotelBlInventory,
  importHotelBlSemrushMetrics,
  latestHotelBlRun,
  listHotelBlOpportunities,
  listHotelBlUrlValidations,
  parseHhtSemrushEnvelope,
  parseSemrushRows,
  rawSql,
  recalculateHotelBlOpportunities,
  reclassifyStoredHotelBlUrlValidations,
  retryFailedHotelBlJobs,
  semrushInteger,
  workspaceRoot,
} from '../index.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const opt = (name: string): string | undefined => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const integerOpt = (name: string, fallback?: number): number => {
  const raw = opt(name)
  if (raw === undefined && fallback !== undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer.`)
  return value
}

async function applySchema(): Promise<void> {
  for (const migration of ['0030_hotel_backlink_scout.sql', '0031_hotel_bl_url_validation.sql']) {
    const file = resolve(workspaceRoot(), 'packages/data/drizzle', migration)
    await rawSql().unsafe(await readFile(file, 'utf8'))
  }
}

async function latestRunId(): Promise<number> {
  const explicit = opt('run-id')
  if (explicit) return integerOpt('run-id')
  const run = await latestHotelBlRun(db())
  if (!run) throw new Error('No Hotel Backlink Scout run exists. Import an inventory first.')
  return run.id
}

async function importInventory(): Promise<void> {
  await applySchema()
  const file = opt('file')
  if (!file) throw new Error('--file is required.')
  const path = resolve(file)
  const result = await importHotelBlInventory(db(), {
    csv: await readFile(path, 'utf8'),
    filename: path.split('/').pop(),
    runName: opt('name'),
  })
  console.log(JSON.stringify(result, null, 2))
}

async function runPipeline(): Promise<void> {
  await applySchema()
  const runId = await latestRunId()
  const result = await executeHotelBlRun(db(), runId, { concurrency: integerOpt('concurrency', 5) })
  console.log(JSON.stringify({ runId, ...result }, null, 2))
}

async function validateUrls(): Promise<void> {
  await applySchema()
  const runId = await latestRunId()
  const result = await executeHotelBlUrlValidation(db(), runId, {
    concurrency: integerOpt('concurrency', 8),
    limit: opt('limit') ? integerOpt('limit') : undefined,
    force: argv.includes('--force'),
  })
  console.log(JSON.stringify({ runId, ...result }, null, 2))
}

async function reclassifyUrls(): Promise<void> {
  const runId = await latestRunId()
  console.log(JSON.stringify({ runId, ...await reclassifyStoredHotelBlUrlValidations(db(), runId, {
    status: opt('status'),
    hotelId: opt('hotel-id') ? integerOpt('hotel-id') : undefined,
  }) }, null, 2))
}

async function status(): Promise<void> {
  const runId = await latestRunId()
  const [run] = await db().select().from(hotelBlRuns).where(eq(hotelBlRuns.id, runId)).limit(1)
  if (!run) throw new Error(`Run #${runId} does not exist.`)
  const jobs = await db()
    .select({ stage: hotelBlJobs.stage, status: hotelBlJobs.status, count: sql<number>`count(*)::int`, records: sql<number>`coalesce(sum(${hotelBlJobs.recordsProcessed}), 0)::int` })
    .from(hotelBlJobs)
    .where(eq(hotelBlJobs.runId, runId))
    .groupBy(hotelBlJobs.stage, hotelBlJobs.status)
    .orderBy(hotelBlJobs.stage, hotelBlJobs.status)
  console.log(`Run #${run.id} ${run.status} at ${run.currentStage}`)
  if (run.error) console.log(`ERROR: ${run.error}`)
  for (const job of jobs) console.log(`${job.stage.padEnd(30)} ${job.status.padEnd(12)} jobs ${String(job.count).padStart(5)} records ${String(job.records).padStart(6)}`)
  console.log(`Progress ${JSON.stringify(run.progress)}; external usage ${JSON.stringify(run.externalApiUsage)}`)
}

async function validationReport(): Promise<void> {
  const runId = await latestRunId()
  const rowConditions = [
    eq(hotelBlHotels.lastRunId, runId),
    sql`${hotelBlHotels.urlValidatedAt} is not null`,
    ...(opt('status') ? [sql`${hotelBlHotels.urlValidationStatus} = ${opt('status')!}`] : []),
    ...(opt('hotel') ? [sql`lower(${hotelBlHotels.hotelName}) like ${`%${opt('hotel')!.toLowerCase()}%`}`] : []),
    ...(opt('hotel-id') ? [eq(hotelBlHotels.id, integerOpt('hotel-id'))] : []),
    ...(opt('classifier-version') ? [sql`${hotelBlHotels.urlValidationEvidence}->'replay'->>'classifierVersion' = ${opt('classifier-version')!}`] : []),
    ...(argv.includes('--listing-unmatched') ? [eq(hotelBlHotels.listingMatched, false)] : []),
  ]
  const [statuses, scopes, entityTypes, domainScopes, listingMatches, classifierVersions, rows] = await Promise.all([
    db().select({ key: hotelBlHotels.urlValidationStatus, count: sql<number>`count(*)::int` }).from(hotelBlHotels).where(and(eq(hotelBlHotels.lastRunId, runId), sql`${hotelBlHotels.urlValidatedAt} is not null`)).groupBy(hotelBlHotels.urlValidationStatus).orderBy(sql`count(*) desc`),
    db().select({ key: hotelBlHotels.sourceEntityScope, count: sql<number>`count(*)::int` }).from(hotelBlHotels).where(and(eq(hotelBlHotels.lastRunId, runId), sql`${hotelBlHotels.urlValidatedAt} is not null`)).groupBy(hotelBlHotels.sourceEntityScope).orderBy(sql`count(*) desc`),
    db().select({ key: hotelBlHotels.sourceEntityType, count: sql<number>`count(*)::int` }).from(hotelBlHotels).where(and(eq(hotelBlHotels.lastRunId, runId), sql`${hotelBlHotels.urlValidatedAt} is not null`)).groupBy(hotelBlHotels.sourceEntityType).orderBy(sql`count(*) desc`),
    db().select({ key: hotelBlDomains.entityScope, count: sql<number>`count(*)::int` }).from(hotelBlDomains).where(eq(hotelBlDomains.lastRunId, runId)).groupBy(hotelBlDomains.entityScope).orderBy(sql`count(*) desc`),
    db().select({ key: hotelBlHotels.listingMatched, count: sql<number>`count(*)::int` }).from(hotelBlHotels).where(and(eq(hotelBlHotels.lastRunId, runId), sql`${hotelBlHotels.urlValidatedAt} is not null`)).groupBy(hotelBlHotels.listingMatched).orderBy(sql`count(*) desc`),
    db().select({ key: sql<string>`${hotelBlHotels.urlValidationEvidence}->'replay'->>'classifierVersion'`, count: sql<number>`count(*)::int` }).from(hotelBlHotels).where(and(eq(hotelBlHotels.lastRunId, runId), sql`${hotelBlHotels.urlValidatedAt} is not null`)).groupBy(sql`${hotelBlHotels.urlValidationEvidence}->'replay'->>'classifierVersion'`).orderBy(sql`count(*) desc`),
    db().select({ id: hotelBlHotels.id, hotel: hotelBlHotels.hotelName, city: hotelBlHotels.city, state: hotelBlHotels.state, sourceUrl: hotelBlHotels.sourceUrl, finalUrl: hotelBlHotels.candidateFinalUrl, scope: hotelBlHotels.sourceEntityScope, type: hotelBlHotels.sourceEntityType, status: hotelBlHotels.urlValidationStatus, confidence: hotelBlHotels.urlValidationConfidence, listingMatched: hotelBlHotels.listingMatched, classifierVersion: sql<string>`${hotelBlHotels.urlValidationEvidence}->'replay'->>'classifierVersion'`, reason: hotelBlHotels.urlValidationReason, evidence: hotelBlHotels.urlValidationEvidence }).from(hotelBlHotels).where(and(...rowConditions)).orderBy(hotelBlHotels.id).limit(integerOpt('limit', 25)),
  ])
  const reportRows = argv.includes('--compact') ? rows.map(({ evidence: _evidence, ...row }) => row) : rows
  console.log(JSON.stringify({ runId, statuses, scopes, entityTypes, domainScopes, listingMatches, classifierVersions, rows: reportRows }, null, 2))
}

async function semrushRequest(): Promise<void> {
  const jobId = integerOpt('job-id')
  const [job] = await db().select().from(hotelBlJobs).where(eq(hotelBlJobs.id, jobId)).limit(1)
  if (!job || job.stage !== 'semrush_enrichment') throw new Error(`Semrush job #${jobId} does not exist.`)
  const [domain] = job.domainId ? await db().select().from(hotelBlDomains).where(eq(hotelBlDomains.id, job.domainId)).limit(1) : []
  const configuration = job.configuration as { report?: string; params?: Record<string, unknown> }
  if (!configuration.report || !configuration.params) throw new Error(`Semrush job #${jobId} has no valid request configuration.`)
  console.log(JSON.stringify({ jobId: job.id, runId: job.runId, domain: domain?.rootDomain, report: configuration.report, params: configuration.params }, null, 2))
}

async function importSemrush(): Promise<void> {
  const runId = await latestRunId()
  const file = opt('file')
  if (!file) throw new Error('--file is required.')
  const rawPayload = JSON.parse(await readFile(resolve(file), 'utf8')) as unknown
  const payload = Array.isArray(rawPayload) ? rawPayload : [rawPayload]
  let imported = 0
  let knownUnits = 0
  for (const item of payload) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each import entry must be an object.')
    const entry = item as Record<string, unknown>
    const jobId = Number(entry['jobId'])
    if (!Number.isInteger(jobId)) throw new Error('Each import entry needs an integer jobId.')
    const envelope = parseHhtSemrushEnvelope(entry['envelope'])
    const [job] = await db().select().from(hotelBlJobs).where(and(eq(hotelBlJobs.id, jobId), eq(hotelBlJobs.runId, runId))).limit(1)
    if (!job || job.stage !== 'semrush_enrichment' || !job.domainId) throw new Error(`Job #${jobId} is not a Semrush job for run #${runId}.`)
    const configuration = job.configuration as { report?: string; params?: Record<string, unknown> }
    if (configuration.report !== envelope.report) throw new Error(`Job #${jobId} expected ${configuration.report}, received ${envelope.report}.`)
    const [domain] = await db().select().from(hotelBlDomains).where(eq(hotelBlDomains.id, job.domainId)).limit(1)
    if (!domain) throw new Error(`Domain for job #${jobId} no longer exists.`)
    const rows = parseSemrushRows(envelope.body)
    const row = rows[0] ?? {}
    const authorityScore = envelope.report === 'backlinks_overview' ? semrushInteger(row['authority_score'] ?? row['ascore']) : undefined
    const referringDomains = envelope.report === 'backlinks_overview' ? semrushInteger(row['domains_num']) : undefined
    const organicTraffic = envelope.report === 'domain_rank' ? semrushInteger(row['organic_traffic']) : undefined
    await importHotelBlSemrushMetrics(db(), {
      runId,
      domain: domain.rootDomain,
      authorityScore,
      referringDomains,
      organicTraffic,
      raw: {
        [envelope.report]: {
          params: envelope.params,
          body: envelope.body,
          accountIdentifier: envelope.accountIdentifier ?? null,
          estimatedUnitsConsumed: envelope.estimatedUnitsConsumed ?? null,
          importedAt: new Date().toISOString(),
        },
      },
      deferRecalculation: true,
    })
    await db().update(hotelBlJobs).set({ status: 'complete', recordsProcessed: rows.length, lastSuccessAt: new Date(), finishedAt: new Date(), error: null, updatedAt: new Date() }).where(eq(hotelBlJobs.id, jobId))
    knownUnits += envelope.estimatedUnitsConsumed ?? 0
    imported += 1
  }
  const [run] = await db().select().from(hotelBlRuns).where(eq(hotelBlRuns.id, runId)).limit(1)
  const usage = run?.externalApiUsage ?? {}
  await recalculateHotelBlOpportunities(db(), runId)
  const [pending] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(hotelBlJobs)
    .where(and(eq(hotelBlJobs.runId, runId), eq(hotelBlJobs.stage, 'semrush_enrichment'), eq(hotelBlJobs.status, 'pending')))
  await db().update(hotelBlRuns).set({
    externalApiUsage: {
      ...usage,
      semrushCalls: (usage['semrushCalls'] ?? 0) + imported,
      semrushKnownUnits: (usage['semrushKnownUnits'] ?? 0) + knownUnits,
    },
    status: (pending?.count ?? 0) === 0 ? 'complete' : 'waiting_for_semrush',
    currentStage: (pending?.count ?? 0) === 0 ? 'calculate_priorities' : 'semrush_enrichment',
    finishedAt: (pending?.count ?? 0) === 0 ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(hotelBlRuns.id, runId))
  console.log(`Imported ${imported} Semrush response${imported === 1 ? '' : 's'}; recorded ${knownUnits} known units.`)
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function exportCsv(): Promise<void> {
  const file = resolve(opt('file') ?? `exports/hotel-backlink-scout/opportunities-${new Date().toISOString().slice(0, 10)}.csv`)
  const rows = await listHotelBlOpportunities(db(), {}, 20_000)
  const data = [
    ['priority', 'hotel', 'city', 'state', 'brand', 'target_entity', 'entity_scope', 'entity_type', 'relationship', 'url_validation', 'validation_confidence', 'validation_reason', 'domain', 'site_control', 'feasibility', 'link_value', 'content_fit', 'effort', 'press_page', 'press_links', 'followed_press_links', 'latest_press_date', 'pr_contact', 'contact_channel', 'pr_name', 'pr_title', 'pr_email', 'pr_phone', 'pr_contact_type', 'pr_source_url', 'contact_page_url', 'press_kit', 'recommended_content', 'pitch', 'reasoning', 'status'],
    ...rows.map((row) => [row.priorityScore, row.hotelName, row.city, row.state, row.brandName, row.targetEntity, row.entityScope, row.entityType, row.relationshipType, row.urlValidationStatus, row.urlValidationConfidence, row.urlValidationReason, row.domain, row.siteControlType, row.feasibilityScore, row.linkValueScore, row.contentFitScore, row.effortScore, row.hasPressPage, row.externalPressLinkCount, row.dofollowExternalPressLinkCount, row.latestPressDate?.toISOString() ?? null, row.hasPrContact, row.contactChannel, row.prName, row.prTitle, row.prEmail, row.prPhone, row.prContactType, row.prSourceUrl, row.contactPageUrl, row.hasPressKit, row.manualRecommendedContentType ?? row.recommendedContentType, row.recommendedPitchAngle, row.reasoningSummary, row.status]),
  ].map((row) => row.map(csvCell).join(',')).join('\r\n')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `\uFEFF${data}`, 'utf8')
  console.log(`Wrote ${rows.length} opportunities to ${file}`)
}

async function validationExportCsv(): Promise<void> {
  const file = resolve(opt('file') ?? `exports/hotel-backlink-scout/hotel-url-validation-${new Date().toISOString().slice(0, 10)}.csv`)
  const rows = await listHotelBlUrlValidations(db())
  const data = [
    ['Hotel', 'City', 'State', 'Country', 'HotelHotTubs listing', 'Current listing page', 'Listing matched', 'Listing address', 'Imported candidate URL', 'Resolved candidate URL', 'Entity scope', 'Entity type', 'Validation status', 'Validation confidence', 'Validation reason', 'Canonical hotel domain', 'Needs review', 'Validated at'],
    ...rows.map((row) => Object.values(row).map((value) => value instanceof Date ? value.toISOString() : value)),
  ].map((row) => row.map(csvCell).join(',')).join('\r\n')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `\uFEFF${data}`, 'utf8')
  console.log(`Wrote ${rows.length} URL validation rows to ${file}`)
}

async function main(): Promise<void> {
  if (command === 'migrate') { await applySchema(); return void console.log('Applied Hotel Backlink Scout migrations through 0031') }
  if (command === 'import') return importInventory()
  if (command === 'run') return runPipeline()
  if (command === 'validate-urls') return validateUrls()
  if (command === 'reclassify-urls') return reclassifyUrls()
  if (command === 'status') return status()
  if (command === 'validation-report') return validationReport()
  if (command === 'retry') return void console.log(`Re-queued ${await retryFailedHotelBlJobs(db(), await latestRunId())} failed jobs.`)
  if (command === 'semrush-request') return semrushRequest()
  if (command === 'semrush-import') return importSemrush()
  if (command === 'export') return exportCsv()
  if (command === 'validation-export') return validationExportCsv()
  console.log(`Hotel Backlink Scout

  pnpm hotel:bl migrate
  pnpm hotel:bl import --file=hotel-direct-links-2026-08-21.csv [--name="August inventory"]
  pnpm hotel:bl run --run-id=1 [--concurrency=5]
  pnpm hotel:bl validate-urls --run-id=1 [--concurrency=8] [--limit=20] [--force]
  pnpm hotel:bl reclassify-urls --run-id=1 [--status=non_hotel] [--hotel-id=123]
  pnpm hotel:bl status [--run-id=1]
  pnpm hotel:bl validation-report --run-id=1 [--limit=25] [--status=locality] [--hotel=name] [--hotel-id=123] [--classifier-version=5] [--listing-unmatched] [--compact]
  pnpm hotel:bl retry --run-id=1
  pnpm hotel:bl semrush-request --job-id=123
  pnpm hotel:bl semrush-import --run-id=1 --file=exports/hotel-backlink-scout/semrush-batch.json
  pnpm hotel:bl export [--file=exports/hotel-backlink-scout/opportunities.csv]
  pnpm hotel:bl validation-export [--file=exports/hotel-backlink-scout/hotel-url-validation.csv]`)
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1 }).finally(closeDb)
