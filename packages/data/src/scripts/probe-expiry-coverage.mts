import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const byStatus = await sql<Array<any>>`
  SELECT status, count(*)::int n,
         count(days_to_expiry)::int with_expiry,
         min(days_to_expiry) min_d, max(days_to_expiry) max_d
    FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('status         rows  w/expiry   min    max')
for (const r of byStatus)
  console.log(`${String(r.status).padEnd(14)} ${String(r.n).padStart(4)} ${String(r.with_expiry).padStart(9)} ${String(r.min_d ?? '—').padStart(5)} ${String(r.max_d ?? '—').padStart(6)}`)

console.log('\n=== domains expiring within 90d, by status (who is hidden?) ===')
const soon = await sql<Array<any>>`
  SELECT DISTINCT ON (domain) domain, status, days_to_expiry, reason
    FROM domain_candidates
   WHERE days_to_expiry IS NOT NULL AND days_to_expiry BETWEEN 0 AND 90
   ORDER BY domain, days_to_expiry ASC`
for (const r of soon.sort((a,b)=>a.days_to_expiry-b.days_to_expiry))
  console.log(`  ${String(r.days_to_expiry).padStart(3)}d  ${r.domain.padEnd(34)} ${String(r.status).padEnd(14)} ${r.reason}`)

console.log('\n=== how many would enter a 90d window within the next year? ===')
const buckets = await sql<Array<any>>`
  SELECT width_bucket(days_to_expiry, 0, 730, 8) b,
         min(days_to_expiry) lo, max(days_to_expiry) hi, count(*)::int n
    FROM domain_candidates WHERE days_to_expiry IS NOT NULL
   GROUP BY b ORDER BY b`
for (const r of buckets) console.log(`  ${String(r.lo).padStart(4)}-${String(r.hi).padStart(4)}d  ${r.n}`)
await sql.end()
