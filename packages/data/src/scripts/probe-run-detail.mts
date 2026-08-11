import 'dotenv/config'
import postgres from 'postgres'

const runId = Number(process.argv[2] || 11)
const s = postgres(process.env.DATABASE_URL!, { max: 1 })

const [run] = await s`
  select * from discovery_runs where id = ${runId}
`
console.log('=== run ===')
console.log(JSON.stringify(run, null, 2))

const status = await s`
  select status, count(*)::int as n
  from discovery_jobs
  where run_id = ${runId}
  group by status
  order by status
`
console.log('=== job status ===', status)

const errors = await s`
  select error, count(*)::int as n
  from discovery_jobs
  where run_id = ${runId} and status = 'failed'
  group by error
  order by n desc
  limit 15
`
console.log('=== fail reasons ===')
for (const e of errors) {
  console.log(e.n, String(e.error ?? 'null').slice(0, 200))
}

const sample = await s`
  select id, status, keyword, device, error, measured_via, cost_micros,
         finished_at, claimed_at
  from discovery_jobs
  where run_id = ${runId}
  order by id
  limit 60
`
console.log('=== jobs ===')
for (const j of sample) {
  console.log(
    `#${j.id}`,
    j.status,
    j.keyword,
    j.device,
    j.measured_via ?? '',
    String(j.error ?? '').slice(0, 120),
  )
}

const done = await s`
  select keyword, device from discovery_jobs
  where run_id = ${runId} and status = 'done'
  order by keyword
`
console.log('=== done keywords ===', done)

await s.end()
