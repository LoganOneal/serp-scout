import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const runs = await sql<Array<any>>`
  SELECT id, niche, locality, location_code, created_at, unique_domains FROM domain_enrich_runs ORDER BY id`
for (const r of runs) console.log(`run #${r.id}  ${r.niche} @ ${r.locality} (${r.location_code})  domains=${r.unique_domains}  ${new Date(r.created_at).toISOString()}`)
const byRun = await sql<Array<any>>`
  SELECT run_id, status, count(*)::int n FROM domain_candidates GROUP BY run_id, status ORDER BY run_id, n DESC`
console.log('\nstatus by run:')
for (const r of byRun) console.log(`  run ${r.run_id}  ${String(r.status).padEnd(14)} ${r.n}`)
const k = await sql<Array<any>>`
  SELECT run_id, domain, status, http_outcome, http_status FROM domain_candidates
   WHERE domain IN ('kohler.com','quixservice.com') ORDER BY domain, run_id`
console.log('\nthe two disputed domains:')
for (const r of k) console.log(`  run ${r.run_id}  ${r.domain.padEnd(18)} ${String(r.status).padEnd(12)} outcome=${r.http_outcome} status=${r.http_status ?? '—'}`)
await sql.end()
