/**
 * End-to-end smoke test for the Trigger.dev discovery consumer, sized to the
 * SMALLEST possible unit of real work: 1 keyword × 1 geo × desktop = 1 job,
 * ~$0.002 of DataForSEO. Enqueue and trigger happen back to back because the
 * Vercel cron drains this same queue every 60s -- Trigger has to claim the job
 * before the next tick or the run reports processed: 0.
 *
 * Needs TRIGGER_SECRET_KEY in the root .env. Use the DEV key (tr_dev_...) so
 * the run executes on the local `pnpm trigger:dev` worker.
 *
 *   pnpm exec tsx --conditions=react-server apps/web/scripts/trigger-smoke.mts
 *   pnpm exec tsx --conditions=react-server apps/web/scripts/trigger-smoke.mts --dry
 *
 * `--prove-scope` additionally checks that a run-scoped dispatch REFUSES to touch
 * another run's pending work: it first drains with a runId that has nothing
 * pending and asserts processed: 0 while the new job is sitting there unclaimed.
 * Same 1 job, same ~$0.002.
 */
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

const { db, enqueueCatalogBulkResearch, liveCallsEnabled } = await import('@rnr/data')
const { runs, tasks } = await import('@trigger.dev/sdk/v3')

const dryRun = process.argv.includes('--dry')
const database = db()

console.log('live calls :', liveCallsEnabled())

// No explicit ids: maxJobs 1 + autoTruncate cuts the catalog down to a single
// keyword × geo cell on its own, so this cannot accidentally queue a deep dive.
const { preview, run } = await enqueueCatalogBulkResearch(database, {
  devices: ['desktop'],
  includeNearMe: false,
  maxJobs: 1,
  autoTruncate: true,
  dryRun,
  label: 'Trigger.dev smoke · 1 job',
})

console.log('jobs       :', preview.jobCount)
console.log('est cost   :', `$${Number(preview.estimatedCostMicros) / 1_000_000}`)
console.log('fixtures   :', preview.usedFixtures)
console.log('selection  :', preview.filtersSummary)

if (dryRun || !run) {
  console.log('run        : (dry run — nothing queued, nothing triggered)')
  process.exit(0)
}
console.log('run        :', `#${run.id}`)

if (!process.env['TRIGGER_SECRET_KEY']?.trim()) {
  console.error('\nTRIGGER_SECRET_KEY is not set — job is queued but Trigger was NOT called.')
  console.error('Vercel cron will drain it within a minute. Add the DEV key and re-run.')
  process.exit(1)
}

/** Trigger discovery-drain for one runId and wait for its output. */
async function drainVia(runId: number, label: string): Promise<{ processed: number } | null> {
  const handle = await tasks.trigger('discovery-drain', {
    runId,
    // Short budget: one job, and we do not want the task idling for 12 minutes.
    budgetMs: 90_000,
    maxJobs: 5,
  })
  console.log(`${label} :`, handle.id)

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const state = await runs.retrieve(handle.id)
    if (state.isCompleted) {
      console.log(`${label} : ${state.status} ${JSON.stringify(state.output)}`)
      if (state.error) console.log(`${label} : error ${JSON.stringify(state.error)}`)
      return (state.output as { processed: number } | undefined) ?? null
    }
    await new Promise((r) => setTimeout(r, 3_000))
  }
  console.log(`${label} : timed out waiting for the run`)
  return null
}

if (process.argv.includes('--prove-scope')) {
  // A finished run has nothing pending, so a correctly scoped claim finds
  // nothing -- even though run.id's job is pending RIGHT NOW. Before the runId
  // filter existed this returned processed: 1 and stole the other run's job.
  const decoy = run.id - 1
  console.log(`\nscope test : draining runId=${decoy} while run #${run.id} has 1 pending job`)
  const wrong = await drainVia(decoy, 'decoy      ')
  console.log(
    wrong?.processed === 0
      ? '✓ scoped   : refused to claim another run\'s job'
      : `✗ SCOPE LEAK: processed ${wrong?.processed} job(s) from outside runId=${decoy}`,
  )
}

const result = await drainVia(run.id, 'trigger    ')
console.log(
  result?.processed === 1
    ? '✓ drained  : Trigger processed this run\'s job'
    : `note       : processed ${result?.processed ?? '?'} — cron likely won the race; re-run`,
)

process.exit(0)
