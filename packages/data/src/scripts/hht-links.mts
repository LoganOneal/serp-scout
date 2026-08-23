/**
 * HotelHotTubs backlink research CLI.
 *
 * Semrush itself is invoked by Codex through MCP. This CLI owns the durable side:
 * job planning, request payloads, lossless imports, checkpoints, local analysis,
 * scoring, clustering, and exports.
 */
import 'dotenv/config'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  closeDb,
  clusterHhtBlStrategies,
  createHhtBlJob,
  createHhtBlRun,
  crawlHhtBlBacklinks,
  crawlHhtBlCandidateSites,
  db,
  expandHhtBlRunKeywords,
  exportHhtBlRun,
  getHhtBlDashboard,
  hhtBlJobs,
  hhtBlKeywords,
  hhtBlRuns,
  importHhtBlLinkAnalyses,
  importHhtBlSemrushResponse,
  importHhtBlSiteClassifications,
  markHhtBlJobError,
  parkHhtBlSerpJobs,
  parkHhtBlCoveredBacklinkJobs,
  parkHhtBlUnapprovedOrganicMetricJobs,
  parseHhtSemrushEnvelope,
  hhtSemrushRequestParams,
  queueHhtBlBacklinkCollectionJobs,
  queueHhtBlBacklinkMetricJobs,
  queueHhtBlDomainValidationJobs,
  queueHhtBlSiteExpansionJobs,
  rankHhtBlCandidateSites,
  rawSql,
  resumeHhtBlJob,
  scoreHhtBlOpportunities,
  selectHhtBlResearchSites,
  seedHhtBlCandidateSites,
  workspaceRoot,
  writeHhtBlSiteClassificationQueue,
  writeHhtBlLinkAnalysisQueue,
} from '../index.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((arg) => !arg.startsWith('--'))
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
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`)
  return value
}

const requireRunId = (): number => integerOpt('run-id')
const requireJobId = (): number => integerOpt('job-id')

async function applySchema(): Promise<void> {
  const path = resolve(workspaceRoot(), 'packages', 'data', 'drizzle', '0027_hht_bl_analysis.sql')
  await rawSql().unsafe(await readFile(path, 'utf8'))
}

async function init(): Promise<void> {
  await applySchema()
  const result = await createHhtBlRun(db(), {
    profile: opt('profile'),
    name: opt('name'),
  })
  console.log(`Created HHT backlink run #${result.runId} (${result.profile}) with ${result.keywords} keywords.`)
}

async function queueSerps(): Promise<void> {
  const runId = requireRunId()
  const [run] = await db().select().from(hhtBlRuns).where(eq(hhtBlRuns.id, runId)).limit(1)
  if (!run) throw new Error(`Run ${runId} does not exist`)
  const profile = run.configuration as { discovery?: { serp_result_limit?: number } }
  const limit = profile.discovery?.serp_result_limit ?? 10
  const keywords = await db().select().from(hhtBlKeywords).where(eq(hhtBlKeywords.runId, runId))
  let created = 0
  for (const keyword of keywords.filter((row) => row.selected)) {
    const job = await createHhtBlJob(db(), {
      runId,
      stage: 'serp_discovery',
      reportType: 'phrase_organic',
      target: keyword.keyword,
      parameters: {
        database: 'us',
        phrase: keyword.keyword,
        positions_type: 'organic',
        display_limit: limit,
        export_columns: ['position', 'domain', 'url'],
      },
      limit,
    })
    if (job.created) created += 1
  }
  await db().update(hhtBlRuns).set({ status: 'RUNNING', currentStage: 'serp_discovery', startedAt: run.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(hhtBlRuns.id, runId))
  console.log(`${created} new SERP jobs queued; ${keywords.length - created} already existed.`)
}

async function requestPayload(): Promise<void> {
  const jobId = requireJobId()
  const [job] = await db().select().from(hhtBlJobs).where(eq(hhtBlJobs.id, jobId)).limit(1)
  if (!job) throw new Error(`Job ${jobId} does not exist`)
  const remaining = Math.max(0, job.rowsRequested - job.rowsReceived)
  console.log(
    JSON.stringify(
      {
        report: job.reportType,
        params: hhtSemrushRequestParams(
          job.reportType,
          job.parameters as Record<string, unknown>,
          {
            offset: job.offset,
            limit: Math.min(job.limit, remaining || job.limit),
          },
        ),
        checkpoint: { runId: job.runId, jobId: job.id, recordsCompleted: job.recordsCompleted },
      },
      null,
      2,
    ),
  )
}

async function importResponse(): Promise<void> {
  const runId = requireRunId()
  const jobId = opt('job-id') === undefined ? null : requireJobId()
  const file = opt('file')
  if (!file) throw new Error('--file is required')
  const payload = JSON.parse(await readFile(resolve(file), 'utf8')) as unknown
  if (!Array.isArray(payload)) {
    const envelope = parseHhtSemrushEnvelope(payload)
    const result = await importHhtBlSemrushResponse(db(), runId, jobId, envelope)
    return void console.log(JSON.stringify(result, null, 2))
  }

  const results = []
  for (const item of payload) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('batch import entries must be objects')
    }
    const row = item as Record<string, unknown>
    if (!Number.isInteger(row['jobId'])) throw new Error('batch import entries need an integer jobId')
    const envelope = parseHhtSemrushEnvelope(row['envelope'])
    results.push(await importHhtBlSemrushResponse(db(), runId, Number(row['jobId']), envelope))
  }
  console.log(JSON.stringify(results, null, 2))
}

async function seedSites(): Promise<void> {
  const file = opt('file')
  if (!file) throw new Error('--file is required')
  const payload = JSON.parse(await readFile(resolve(file), 'utf8')) as unknown
  if (!Array.isArray(payload)) throw new Error('site seed file must contain an array')
  const seeds = payload.map((row) => {
    if (typeof row === 'string') return { domain: row }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('site seeds must be domain strings or objects')
    }
    const seed = row as Record<string, unknown>
    if (typeof seed['domain'] !== 'string') throw new Error('site seed objects need a domain')
    return {
      domain: seed['domain'],
      ...(typeof seed['cohort'] === 'string' ? { cohort: seed['cohort'] } : {}),
      ...(typeof seed['source'] === 'string' ? { source: seed['source'] } : {}),
    }
  })
  console.log(await seedHhtBlCandidateSites(db(), requireRunId(), seeds))
}

async function status(): Promise<void> {
  const dashboard = await getHhtBlDashboard(db())
  if (!dashboard.run) return void console.log('No HHT backlink run. Start with: pnpm hht:bl init')
  console.log(`Run #${dashboard.run.id} ${dashboard.run.status} at ${dashboard.run.currentStage}`)
  if (dashboard.run.waitingReason) console.log(`ALERT: ${dashboard.run.waitingReason}`)
  for (const stage of dashboard.stages) {
    console.log(`${stage.stage.padEnd(24)} ${stage.status.padEnd(12)} jobs ${String(stage.jobs).padStart(3)} records ${String(stage.records).padStart(6)}`)
  }
  console.log(`Candidates ${dashboard.counts?.candidates ?? 0}; research sites ${dashboard.counts?.researchSites ?? 0}; backlinks ${dashboard.counts?.backlinks ?? 0}; opportunities ${dashboard.counts?.opportunities ?? 0}`)
}

async function cost(): Promise<void> {
  const dashboard = await getHhtBlDashboard(db())
  if (!dashboard.run || !dashboard.cost) return void console.log('No HHT backlink run.')
  console.log(`Semrush calls ${dashboard.cost.calls}; rows ${dashboard.cost.rows}`)
  console.log(
    dashboard.cost.unknownCalls > 0
      ? `${dashboard.cost.unknownCalls} call(s) have unknown credit consumption because the MCP exposes no unit count.`
      : `Known units consumed: ${dashboard.cost.knownUnits ?? 0}`,
  )
}

async function main(): Promise<void> {
  if (command === 'init') return init()
  if (command === 'queue-serps' || (command === 'discover' && positional[0] === 'serps')) return queueSerps()
  if (command === 'expand-keywords') {
    const result = await expandHhtBlRunKeywords(db(), requireRunId(), integerOpt('total'))
    return void console.log(`Added ${result.added} keywords; run now has ${result.total}.`)
  }
  if (command === 'park-serps') {
    return void console.log(`Parked ${await parkHhtBlSerpJobs(db(), requireRunId())} SERP jobs.`)
  }
  if (command === 'park-unapproved-organic-metrics') {
    return void console.log(
      await parkHhtBlUnapprovedOrganicMetricJobs(db(), requireRunId()),
    )
  }
  if (command === 'park-covered-backlinks') {
    return void console.log(
      `Parked ${await parkHhtBlCoveredBacklinkJobs(db(), requireRunId())} covered backlink jobs.`,
    )
  }
  if (command === 'seed-sites') return seedSites()
  if (command === 'queue-organic-metrics' || command === 'queue-domain-validation') {
    const result = await queueHhtBlDomainValidationJobs(
      db(),
      requireRunId(),
      integerOpt('limit', 1000),
    )
    return void console.log({
      ...result,
      provider: 'semrush_mcp',
      report: 'domain_rank',
      paid: true,
      estimatedMaximumUnitsPerJob: 10,
    })
  }
  if (command === 'queue-backlink-metrics') {
    const result = await queueHhtBlBacklinkMetricJobs(db(), requireRunId(), {
      limit: integerOpt('limit', 1000),
      batchSize: integerOpt('batch-size', 40),
    })
    return void console.log({
      ...result,
      provider: 'semrush_mcp',
      report: 'backlinks_comparison',
      paid: true,
      observedUnitsPerReturnedSite: 40,
      estimatedUnitsAtObservedRate: result.selected * 40,
    })
  }
  if (command === 'queue-site-expansion') {
    return void console.log(
      await queueHhtBlSiteExpansionJobs(db(), requireRunId(), {
        seedLimit: integerOpt('seed-limit', 20),
        organicLimit: integerOpt('organic-limit', 10),
        backlinkLimit: integerOpt('backlink-limit', 10),
      }),
    )
  }
  if (command === 'queue-backlinks') {
    return void console.log(
      await queueHhtBlBacklinkCollectionJobs(db(), requireRunId(), {
        siteLimit: integerOpt('site-limit', 20),
        referringDomainLimit: integerOpt('refdomain-limit', 10),
        backlinkLimit: integerOpt('backlink-limit', 50),
      }),
    )
  }
  if (command === 'request') return requestPayload()
  if (command === 'import') return importResponse()
  if (command === 'status') return status()
  if (command === 'cost') return cost()
  if (command === 'resume') {
    await resumeHhtBlJob(db(), requireJobId())
    return void console.log(`Job ${requireJobId()} is ready at its saved offset.`)
  }
  if (command === 'mark-error') {
    const message = opt('message')
    if (!message) throw new Error('--message is required')
    const result = await markHhtBlJobError(db(), requireJobId(), new Error(message))
    return void console.log(result)
  }
  if (command === 'rank-sites') {
    return void console.log(await rankHhtBlCandidateSites(db(), requireRunId()))
  }
  if (command === 'select-sites') {
    const selected = await selectHhtBlResearchSites(db(), requireRunId(), integerOpt('limit', 8))
    return void console.log(`Selected ${selected} research sites.`)
  }
  if (command === 'crawl') {
    return void console.log(
      await crawlHhtBlBacklinks(db(), requireRunId(), {
        limit: integerOpt('limit', 75),
        concurrency: integerOpt('concurrency', 5),
      }),
    )
  }
  if (command === 'analysis-queue') {
    const output = opt('file') ?? resolve(workspaceRoot(), 'exports', 'hht-bl', `analysis-queue-run-${requireRunId()}.jsonl`)
    await mkdir(dirname(output), { recursive: true })
    const rows = await writeHhtBlLinkAnalysisQueue(db(), requireRunId(), output, integerOpt('limit', 100))
    return void console.log(`Wrote ${rows} rows to ${output}`)
  }
  if (command === 'classification-queue') {
    const output =
      opt('file') ??
      resolve(
        workspaceRoot(),
        'exports',
        'hht-bl',
        `classification-queue-run-${requireRunId()}.jsonl`,
      )
    await mkdir(dirname(output), { recursive: true })
    const rows = await writeHhtBlSiteClassificationQueue(
      db(),
      requireRunId(),
      output,
      integerOpt('limit', 1000),
    )
    return void console.log(`Wrote ${rows} rows to ${output}`)
  }
  if (command === 'crawl-classification-sites') {
    return void console.log(
      await crawlHhtBlCandidateSites(db(), requireRunId(), {
        limit: integerOpt('limit', 60),
        concurrency: integerOpt('concurrency', 8),
        timeoutMs: integerOpt('timeout-ms', 12_000),
        maxAttempts: integerOpt('max-attempts', 2),
      }),
    )
  }
  if (command === 'import-analyses') {
    const file = opt('file')
    if (!file) throw new Error('--file is required')
    return void console.log(`Imported ${await importHhtBlLinkAnalyses(db(), resolve(file))} analyses.`)
  }
  if (command === 'import-site-classifications') {
    const file = opt('file')
    if (!file) throw new Error('--file is required')
    return void console.log(`Imported ${await importHhtBlSiteClassifications(db(), resolve(file))} classifications.`)
  }
  if (command === 'score-opportunities') {
    return void console.log(`Scored ${await scoreHhtBlOpportunities(db(), requireRunId())} opportunities.`)
  }
  if (command === 'cluster-strategies') {
    return void console.log(`Built ${await clusterHhtBlStrategies(db(), requireRunId())} strategy clusters.`)
  }
  if (command === 'export') {
    const files = await exportHhtBlRun(db(), requireRunId())
    return void files.forEach((file) => console.log(file))
  }

  console.log(`Usage: pnpm hht:bl <command>

  init [--profile=pilot|scale]
  expand-keywords --run-id=N --total=N
  park-serps --run-id=N            Park unfinished template-keyword jobs
  park-unapproved-organic-metrics --run-id=N
                                      Park paid domain metrics lacking relevance approval
  park-covered-backlinks --run-id=N   Park jobs already covered by completed target reports
  seed-sites --run-id=N --file=seeds.json
  queue-organic-metrics --run-id=N [--limit=1000]
                                      Queue paid one-row Semrush domain_rank metrics
  queue-domain-validation --run-id=N [--limit=1000]
                                      Legacy alias for queue-organic-metrics
  queue-backlink-metrics --run-id=N [--limit=1000 --batch-size=40]
                                      Queue paid summary metrics only for relevant classified sites
  queue-site-expansion --run-id=N [--seed-limit=20 --organic-limit=10 --backlink-limit=10]
  queue-backlinks --run-id=N [--site-limit=20 --refdomain-limit=10 --backlink-limit=50]
  discover serps --run-id=N       Queue one resumable MCP job per keyword
  request --job-id=N              Print the exact next MCP request
  import --run-id=N --job-id=N --file=envelope.json
  mark-error --job-id=N --message="Insufficient credits"
  resume --job-id=N
  status | cost
  rank-sites --run-id=N
  select-sites --run-id=N --limit=8
  crawl --run-id=N --limit=75
  analysis-queue --run-id=N [--file=queue.jsonl]
  classification-queue --run-id=N [--limit=1000 --file=queue.jsonl]
  crawl-classification-sites --run-id=N [--limit=60 --concurrency=8]
  import-analyses --file=results.jsonl
  import-site-classifications --file=results.jsonl
  score-opportunities --run-id=N
  cluster-strategies --run-id=N
  export --run-id=N`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(closeDb)
