import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const msg =
  'DataForSEO account issue (40201): account temporarily paused by DataForSEO. Contact support@dataforseo.com.'

const u = await sql`
  UPDATE discovery_jobs
  SET status = 'failed',
      finished_at = now(),
      error = COALESCE(NULLIF(error, ''), ${msg}),
      measured_via = COALESCE(measured_via, 'dataforseo'),
      claimed_at = null,
      claimed_by = null
  WHERE status = 'claimed'
  RETURNING id, run_id
`
console.log('failed claimed jobs', u)

const runIds = [...new Set(u.map((x) => x.run_id as number))]
for (const runId of runIds) {
  const [stats] = await sql`
    select
      count(*) filter (where status = 'done')::int as done,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'claimed')::int as claimed
    from discovery_jobs where run_id = ${runId}
  `
  const terminal = (stats?.pending ?? 0) === 0 && (stats?.claimed ?? 0) === 0
  if (terminal) {
    await sql`
      UPDATE discovery_runs SET
        status = 'failed',
        phase = 'complete',
        finished_at = now(),
        jobs_done = ${stats!.done},
        jobs_failed = ${stats!.failed},
        error = ${msg}
      WHERE id = ${runId}
        AND status IN ('pending', 'running')
    `
    console.log('closed run', runId, stats)
  } else {
    console.log('run still has open jobs', runId, stats)
  }
}

const runs = await sql`
  select id, status, jobs_done, jobs_failed, job_count, left(error, 120) as error
  from discovery_runs order by id desc limit 3
`
console.log('runs', runs)
await sql.end()
