import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const runs = await sql`
  select id, status, phase, source, label, job_count, jobs_done, jobs_failed, jobs_skipped, hit_count,
         used_fixtures, error, created_at, started_at, finished_at, devices
  from discovery_runs
  order by id desc
  limit 10
`
console.log('=== recent discovery_runs ===')
for (const r of runs) {
  console.log(JSON.stringify(r))
}

const totals = await sql`
  select status, count(*)::int as n from discovery_jobs group by status order by 1
`
console.log('=== job status totals ===', totals)

for (const r of runs.slice(0, 3)) {
  const jobs = await sql`
    select id, status, keyword, device, keyword_variant, error, cost_micros::text,
           claimed_at, finished_at, measured_via
    from discovery_jobs where run_id = ${r.id as number} order by id
  `
  console.log(`=== jobs for run #${r.id} ===`)
  for (const j of jobs) console.log(JSON.stringify(j))
}

await sql.end()
