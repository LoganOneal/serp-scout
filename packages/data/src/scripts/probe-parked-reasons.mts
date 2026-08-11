import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<any>>`
  SELECT reason, count(*)::int n FROM domain_candidates
   WHERE status = 'PARKED_DEAD' GROUP BY reason ORDER BY n DESC`
console.log('PARKED_DEAD, by why:')
for (const x of r) console.log(`  ${String(x.n).padStart(3)}  ${x.reason}`)
const ex = await sql<Array<any>>`
  SELECT DISTINCT ON (domain) domain, reason, age_years, days_to_expiry
    FROM domain_candidates WHERE status = 'PARKED_DEAD' ORDER BY domain, age_years DESC NULLS LAST`
console.log('\nexamples:')
for (const x of ex.slice(0, 6))
  console.log(`  ${x.domain.padEnd(34)} ${(x.age_years ? Number(x.age_years).toFixed(1) + 'y' : '—').padStart(6)}  exp ${String(x.days_to_expiry ?? '—').padStart(4)}d  ${x.reason}`)
await sql.end()
