/**
 * Settle UNKNOWN rows using signals we already hold. No fetch, no cost.
 *
 * A domain Google is ranking organically is being served -- so a blocked probe
 * says something about our network, not about the site.
 */
import 'dotenv/config'
import postgres from 'postgres'

const apply = process.argv[2] === 'apply'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const rows = await sql<Array<{ id: number; domain: string; serp_rank: number }>>`
  SELECT id, domain, serp_rank FROM domain_candidates
   WHERE status = 'UNKNOWN' AND serp_rank IS NOT NULL AND serp_rank > 0
   ORDER BY serp_rank`
console.log(`${rows.length} UNKNOWN row(s) carry an organic rank\n`)
for (const r of rows) console.log(`  #${String(r.serp_rank).padStart(3)}  ${r.domain}`)

if (apply && rows.length > 0) {
  for (const r of rows) {
    await sql`
      UPDATE domain_candidates
         SET status = 'LIVE',
             reason = ${`Ranked #${r.serp_rank} organically — the probe was blocked, not the site`}
       WHERE id = ${r.id}`
  }
  console.log(`\n${rows.length} row(s) reclassified LIVE for $0.00`)
}
const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('\nall rows:', after.map((x) => `${x.status}=${x.n}`).join('  '))
if (!apply) console.log('(dry run)')
await sql.end()
