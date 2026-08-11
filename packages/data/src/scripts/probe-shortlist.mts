import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<any>>`
  SELECT DISTINCT ON (domain) domain, status, reason, score, age_years, days_to_expiry,
         years_of_content, http_status
    FROM domain_candidates
   WHERE status NOT IN ('LIVE','BROKEN','UNKNOWN')
   ORDER BY domain, score DESC`
const rows = r.sort((a, b) => b.score - a.score)
console.log(`${rows.length} genuine candidate(s) across all runs\n`)
console.log('score  domain                                   status         age    exp   arch  reason')
console.log('-'.repeat(118))
for (const x of rows.slice(0, 18)) {
  console.log(
    String(x.score).padStart(5),
    String(x.domain).padEnd(40),
    String(x.status).padEnd(14),
    (x.age_years == null ? '—' : Number(x.age_years).toFixed(1) + 'y').padStart(6),
    String(x.days_to_expiry ?? '—').padStart(5),
    String(x.years_of_content ?? '—').padStart(5),
    ' ' + x.reason,
  )
}
await sql.end()
