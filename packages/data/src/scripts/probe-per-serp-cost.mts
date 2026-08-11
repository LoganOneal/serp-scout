import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const runId = process.argv[2] ? Number(process.argv[2]) : null
const dist = await sql<Array<any>>`
  SELECT run_id, status, cost_micros, count(*)::int n
    FROM discovery_jobs
   WHERE run_id IN (SELECT id FROM discovery_runs WHERE created_at > now() - interval '24 hours')
     ${runId ? sql`AND run_id = ${runId}` : sql``}
   GROUP BY 1,2,3 ORDER BY run_id DESC, n DESC`
console.log('run  status    per-job cost   jobs      subtotal')
console.log('-'.repeat(58))
for (const d of dist) {
  const usd = Number(d.cost_micros) / 1e6
  console.log(
    `${String(d.run_id).padStart(3)}  ${String(d.status).padEnd(9)} $${usd.toFixed(5).padStart(8)}  ${String(d.n).padStart(5)}   $${(usd * d.n).toFixed(4).padStart(8)}`,
  )
}
const [tot] = await sql<Array<any>>`
  SELECT count(*)::int jobs, sum(cost_micros)::text total
    FROM discovery_jobs WHERE run_id = 26`
console.log(`\nrun 26: ${tot.jobs} jobs · $${(Number(tot.total)/1e6).toFixed(4)} · $${(Number(tot.total)/1e6/tot.jobs).toFixed(5)} per SERP`)
await sql.end()
