import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<any>>`
  SELECT id, niche, locality, location_code, created_at, completed_at, unique_domains, domains_from_serps
    FROM domain_enrich_runs ORDER BY id DESC LIMIT 5`
for (const x of r)
  console.log(`run #${x.id}  ${String(x.niche).padEnd(26)} domains=${String(x.unique_domains).padStart(4)} fromSerps=${String(x.domains_from_serps).padStart(4)}  created ${new Date(x.created_at).toISOString()}`)
const c = await sql<Array<any>>`
  SELECT run_id, status, count(*)::int n FROM domain_candidates WHERE run_id >= 5 GROUP BY run_id, status ORDER BY run_id, n DESC`
console.log('\nby run:')
for (const x of c) console.log(`  run ${x.run_id}  ${String(x.status).padEnd(14)} ${x.n}`)
await sql.end()
