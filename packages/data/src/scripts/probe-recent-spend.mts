import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const hours = Number(process.argv[2] ?? 24)
const byEndpoint = await sql<Array<any>>`
  SELECT endpoint, count(*)::int n, sum(cost_micros)::text total,
         min(created_at) first_at, max(created_at) last_at
    FROM spend_ledger
   WHERE created_at > now() - (${hours} || ' hours')::interval
   GROUP BY 1 ORDER BY sum(cost_micros) DESC`
console.log(`spend in the last ${hours}h, by endpoint:\n`)
console.log('endpoint                                       n        usd')
console.log('-'.repeat(70))
let total = 0
for (const r of byEndpoint) {
  const usd = Number(r.total) / 1e6
  total += usd
  console.log(`${String(r.endpoint).slice(0,44).padEnd(45)} ${String(r.n).padStart(5)}  ${usd.toFixed(4).padStart(9)}`)
}
console.log(`${''.padEnd(45)} ${''.padStart(5)}  ${total.toFixed(4).padStart(9)}  TOTAL`)

const byRun = await sql<Array<any>>`
  SELECT discovery_run_id, note, count(*)::int n, sum(cost_micros)::text total
    FROM spend_ledger
   WHERE created_at > now() - (${hours} || ' hours')::interval
   GROUP BY 1,2 ORDER BY sum(cost_micros) DESC LIMIT 10`
console.log('\nlargest single note groups:')
for (const r of byRun)
  console.log(`  run ${String(r.discovery_run_id ?? '—').padStart(4)} · ${String(r.n).padStart(4)}x · $${(Number(r.total)/1e6).toFixed(4)} · ${String(r.note ?? '').slice(0,54)}`)
await sql.end()
