/**
 * Manually redrive stuck discovery jobs and drain a few so a pending catalog
 * run does not sit until the next cron redrive window.
 *
 *   pnpm exec tsx --conditions=react-server packages/data/src/scripts/probe-drain-discovery.mts
 */
import 'dotenv/config'
import { db } from '../db.js'
import { createProviders, liveCallsEnabled } from '../providers/index.js'
import {
  claimNextDiscoveryJob,
  redriveStuckDiscoveryJobs,
  runDiscoveryJob,
  STUCK_DISCOVERY_JOB_MINUTES,
} from '../serp/run-discovery.js'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

console.log('liveCallsEnabled', liveCallsEnabled())
console.log('STUCK_DISCOVERY_JOB_MINUTES', STUCK_DISCOVERY_JOB_MINUTES)

// Force-redrive anything claimed > 1 minute (ops unblock), then drain.
const forced = await sql`
  UPDATE discovery_jobs j
  SET status = 'pending', claimed_at = null, claimed_by = null
  WHERE j.status = 'claimed'
    AND j.claimed_at < now() - interval '1 minute'
  RETURNING id, run_id, keyword, device
`
console.log('force-redrove claimed>', forced)

const database = db()
const redriven = await redriveStuckDiscoveryJobs(database)
console.log('redriveStuckDiscoveryJobs', redriven)

const providers = createProviders()
const workerId = `probe-drain:${process.pid}`
const max = 8
for (let i = 0; i < max; i++) {
  const job = await claimNextDiscoveryJob(database, workerId)
  if (!job) {
    console.log('no more pending jobs')
    break
  }
  console.log(`running job #${job.id} "${job.keyword}" ${job.device}…`)
  try {
    const outcome = await runDiscoveryJob(database, { job, providers })
    console.log('  →', outcome)
  } catch (e) {
    console.error('  threw', (e as Error).message)
  }
}

const runs = await sql`
  select id, status, jobs_done, jobs_failed, job_count, hit_count, error, finished_at
  from discovery_runs order by id desc limit 3
`
console.log('runs after', runs)
const jobs = await sql`
  select id, status, keyword, device, error, cost_micros::text, measured_via
  from discovery_jobs where run_id = (select max(id) from discovery_runs) order by id
`
console.log('jobs after', jobs)
await sql.end()
