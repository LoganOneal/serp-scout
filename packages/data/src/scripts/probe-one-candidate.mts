import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<Record<string, unknown>>>`
  SELECT run_id, domain, status, reason, score, http_outcome, http_status, redirected_to,
         parking_nameserver, age_years, days_to_expiry, registrar, years_of_content, score_missing
    FROM domain_candidates WHERE domain = ${process.argv[2] ?? 'quixservice.com'}`
for (const x of r) console.log(JSON.stringify(x, null, 1))
await sql.end()
