/**
 * Re-probe rows whose verdict came from superseded triage code.
 *
 * Run #1 predates two fixes: timeouts were classified `dead`, and 5xx was
 * classified `dead`. Both produced PARKED_DEAD rows with a null http_status,
 * which is indistinguishable from a genuine connection refusal by stored data
 * alone -- so the only honest correction is to ask the network again.
 *
 * Free: DNS and HTTP only, no paid provider.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/retriage-stale-rows.mts
 */
import 'dotenv/config'
import postgres from 'postgres'
import { classifyDomain } from '@rnr/core'
import { dnsTriage } from '../domains/dns-triage.js'
import { httpTriage } from '../domains/http-triage.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const stale = await sql<Array<{ id: number; run_id: number; domain: string; status: string }>>`
  SELECT id, run_id, domain, status FROM domain_candidates
   WHERE status = 'PARKED_DEAD' AND http_outcome = 'dead' AND http_status IS NULL
   ORDER BY run_id, domain`
console.log(`${stale.length} row(s) carry a verdict the current classifier would not repeat\n`)

let changed = 0
for (const row of stale) {
  const dns = await dnsTriage(row.domain)
  const http = await httpTriage(row.domain)
  // RDAP is not re-fetched: the stored age/expiry are still valid and the
  // status transitions at issue are all decided by the HTTP outcome.
  const c = classifyDomain({ dns, http })

  if (c.status !== row.status) {
    changed += 1
    await sql`
      UPDATE domain_candidates
         SET status = ${c.status}, reason = ${c.reason},
             http_outcome = ${http.outcome}, http_status = ${http.httpStatus}
       WHERE id = ${row.id}`
    console.log(
      `  run ${row.run_id}  ${row.domain.padEnd(38)} ${row.status} -> ${c.status}  (${http.outcome}/${http.httpStatus ?? '—'})`,
    )
  }
}

console.log(`\n${changed} row(s) corrected, ${stale.length - changed} confirmed`)
const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int AS n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('after:', after.map((r) => `${r.status}=${r.n}`).join('  '))
await sql.end()
