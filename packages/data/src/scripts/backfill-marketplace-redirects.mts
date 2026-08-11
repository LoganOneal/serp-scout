/**
 * Rows redirecting to a domain broker were labelled ACQUIRED_301 -- "someone
 * already bought this" -- when a broker redirect means the opposite: it is for
 * sale and inviting offers. That label moved live leads into a dead-end bucket.
 */
import 'dotenv/config'
import postgres from 'postgres'
import { isDomainMarketplace } from '@rnr/core'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})
const rows = await sql<Array<{ id: number; domain: string; redirected_to: string }>>`
  SELECT id, domain, redirected_to FROM domain_candidates
   WHERE status = 'ACQUIRED_301' AND redirected_to IS NOT NULL`

let n = 0
for (const r of rows) {
  if (!isDomainMarketplace(r.redirected_to)) continue
  n += 1
  await sql`
    UPDATE domain_candidates
       SET status = 'PARKED_DEAD', reason = ${`Listed for sale via ${r.redirected_to}`}
     WHERE id = ${r.id}`
  console.log(`  ${r.domain} -> ${r.redirected_to}  ACQUIRED_301 -> PARKED_DEAD (for sale)`)
}
console.log(`\n${n} row(s) reclassified as for-sale`)
await sql.end()
