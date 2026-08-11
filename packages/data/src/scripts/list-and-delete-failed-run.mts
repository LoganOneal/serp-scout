import 'dotenv/config'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })

const runs = await s`
  select id, status, source, label, job_count, jobs_done, jobs_failed, jobs_skipped,
         hit_count, left(coalesce(error, ''), 160) as err, created_at
  from discovery_runs
  where source = 'catalog'
  order by id desc
  limit 15
`
console.log('=== recent catalog runs ===')
for (const r of runs) {
  console.log(
    `#${r.id}`,
    r.status,
    `jobs=${r.job_count} done=${r.jobs_done} fail=${r.jobs_failed} skip=${r.jobs_skipped ?? 0}`,
    `hits=${r.hit_count}`,
    r.label ?? '',
    r.err ?? '',
  )
}

// Prefer explicit id: pnpm exec tsx ... <runId>
// Else delete the most recent run with high failures or error message about SERP/auth.
const argId = process.argv[2] ? Number(process.argv[2]) : null
const deleteFlag = process.argv.includes('--delete')

let targetId = argId && Number.isFinite(argId) ? argId : null
if (!targetId) {
  const failed = runs.find(
    (r) =>
      Number(r.jobs_failed) >= 50 ||
      String(r.err ?? '').toLowerCase().includes('serp') ||
      String(r.err ?? '').toLowerCase().includes('dataforseo') ||
      (r.status === 'failed' && Number(r.jobs_failed) > 0),
  )
  targetId = failed ? Number(failed.id) : null
}

if (!targetId) {
  console.log('No failed run matched auto-select. Pass run id: script.mts <id> --delete')
  await s.end()
  process.exit(0)
}

console.log(`\n=== target run #${targetId} ===`)
const [detail] = await s`select * from discovery_runs where id = ${targetId}`
console.log(JSON.stringify(detail, null, 2))

const jobStats = await s`
  select status, count(*)::int as n
  from discovery_jobs
  where run_id = ${targetId}
  group by status
  order by status
`
console.log('job status', jobStats)

const metricCount = await s`
  select count(*)::int as n from discovery_serp_metrics where run_id = ${targetId}
`
console.log('metrics rows', metricCount[0]?.n)

if (!deleteFlag) {
  console.log('\nDry-run only. Re-run with --delete to cascade-delete this run.')
  await s.end()
  process.exit(0)
}

// Cascade: discovery_runs → jobs/hits/metrics (FK onDelete cascade)
await s`delete from discovery_runs where id = ${targetId}`
console.log(`\nDeleted discovery_runs #${targetId} (cascade jobs/hits/metrics).`)

const remaining = await s`
  select id, status, jobs_done, jobs_failed, job_count
  from discovery_runs
  where source = 'catalog'
  order by id desc
  limit 5
`
console.log('remaining catalog runs:', remaining)
await s.end()
