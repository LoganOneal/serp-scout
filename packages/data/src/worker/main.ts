/**
 * The worker. Polls `scan_runs` for pending rows and runs them.
 *
 * There is exactly one consumer of the queue and it is this loop. The previous
 * build's silent-dead-button bug came from having an enqueue path and a consumer
 * path that were never connected; with Postgres as the only queue, the INSERT is
 * the enqueue and this is the only thing that reads it.
 *
 *   pnpm worker
 */
import 'dotenv/config'
import { hostname } from 'node:os'
import { centsToMicros, formatMicrosUsd } from '@rnr/core'
import { closeDb, db } from '../db.js'
import { claimNextRun, markRunStatus, redriveStuckRuns } from '../queue.js'
import { runScan } from '../pipeline/run-scan.js'
import { createProviders, liveCallsEnabled } from '../providers/index.js'
import { redriveStuckVoiceJobs } from '../voice/jobs.js'
import {
  discoveryHandledByTrigger,
  drainDiscoveryOnce,
  drainSerpOnce,
  drainVoiceOnce,
} from './drain.js'
import { redriveStuckDiscoveryJobs } from '../serp/run-discovery.js'
import { purgeExpired } from '../cache.js'

const POLL_INTERVAL_MS = 2_000
const workerId = `${hostname()}:${process.pid}`

let shuttingDown = false

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}
function log(msg: string): void {
  console.log(`[${stamp()}] ${msg}`)
}

async function tick(): Promise<boolean> {
  const database = db()

  // Reclaim anything a died instance left `claimed`, every tick rather than only at
  // startup: this process may be the long-lived one and the crashed one may be a
  // cron invocation that was killed at its deadline.
  const redrivenJobs = await redriveStuckVoiceJobs(database)
  if (redrivenJobs > 0) log(`Re-drove ${redrivenJobs} stuck voice job(s) back to pending.`)

  // Voice first, and return immediately so the queue drains before any scan is
  // claimed. runVoiceJob never throws -- it fails the row instead -- so a bad job
  // cannot stall the scan queue behind it.
  if (await drainVoiceOnce(database, { workerId, log })) return true

  // Then SERP monitoring: cheap, daily, and it must not sit behind a multi-minute scan.
  if (await drainSerpOnce(database, { workerId, log })) return true

  /**
   * Discovery research grid: after monitor, before locality scans.
   *
   * ==================== SAME HAND-OFF AS THE CRON ====================
   * Redrive always runs -- it is what rescues a Trigger run that died mid-job --
   * but the CLAIM is skipped when Trigger owns discovery. This worker calls
   * drainDiscoveryOnce directly rather than going through drainQueues, so it
   * does not inherit that gate for free, and without this line a laptop worker
   * races Trigger for the same jobs. That race is not just wasted work: two
   * consumers on different code versions is exactly how a run ends up billed at
   * one volume request per keyword instead of one per market.
   * ================================================================
   */
  const redrivenDiscovery = await redriveStuckDiscoveryJobs(database)
  if (redrivenDiscovery > 0) log(`Re-drove ${redrivenDiscovery} stuck discovery job(s).`)
  if (!discoveryHandledByTrigger()) {
    if (await drainDiscoveryOnce(database, { workerId, log })) return true
  }

  const redriven = await redriveStuckRuns(database)
  if (redriven > 0) log(`Re-drove ${redriven} stuck run(s) back to pending.`)

  const run = await claimNextRun(database, workerId)
  if (!run) return false

  const providers = createProviders()
  log(
    `Claimed run #${run.id} (locality ${run.localityId}), cap ${formatMicrosUsd(run.budgetCapMicros)}, ` +
      `${providers.live ? 'LIVE' : 'FIXTURES'}.`,
  )

  try {
    const result = await runScan({
      db: database,
      providers,
      runId: run.id,
      localityId: run.localityId,
      budgetCapMicros: run.budgetCapMicros,
      startingSpendMicros: run.spendMicros,
      log: (m) => log(`  #${run.id} ${m}`),
    })
    log(
      `Run #${run.id} ${result.status}: ${result.scored}/${result.nicheCount} scored, ` +
        `spend ${formatMicrosUsd(result.spendMicros)}.`,
    )
  } catch (e) {
    // Any escape here marks the run failed rather than leaving it claimed --
    // a run stuck in `claimed` shows the operator a spinner that never resolves.
    const message = (e as Error).message ?? String(e)
    log(`Run #${run.id} FAILED: ${message}`)
    await markRunStatus(database, run.id, 'failed', { error: message })
  }
  return true
}

async function main(): Promise<void> {
  log(`Worker ${workerId} starting.`)
  log(
    liveCallsEnabled()
      ? 'LIVE_CALLS_ENABLED=true -- real money will be spent, capped per run.'
      : 'Fixture mode (LIVE_CALLS_ENABLED is not the string "true"). Every scan costs $0.',
  )

  // On startup, reclaim anything a previous instance died holding.
  const redriven = await redriveStuckRuns(db())
  if (redriven > 0) log(`Startup: re-drove ${redriven} stuck run(s).`)
  const redrivenJobs = await redriveStuckVoiceJobs(db())
  if (redrivenJobs > 0) log(`Startup: re-drove ${redrivenJobs} stuck voice job(s).`)
  await purgeExpired(db()).catch((e) => log(`Cache purge skipped: ${(e as Error).message}`))

  let idleLogged = false
  while (!shuttingDown) {
    try {
      const didWork = await tick()
      if (didWork) {
        idleLogged = false
        continue // Drain the queue before sleeping again.
      }
      if (!idleLogged) {
        log('Idle, waiting for scans, voice jobs, SERP checks and discovery.')
        idleLogged = true
      }
    } catch (e) {
      log(`Tick error: ${(e as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  log('Shutting down.')
  await closeDb()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    log(`${signal} received, finishing current work.`)
  })
}

export { centsToMicros }

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
