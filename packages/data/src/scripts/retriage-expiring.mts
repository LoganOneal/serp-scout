/**
 * Re-probe every EXPIRING_SOON and PARKED_DEAD row.
 *
 * EXPIRING_SOON was being claimed on nothing more than a date whenever triage
 * could not read the site -- tesla.com, behind a 403, at 88 days out. Free.
 */
import 'dotenv/config'
import postgres from 'postgres'
import { classifyDomain } from '@rnr/core'
import { dnsTriage } from '../domains/dns-triage.js'
import { httpTriage } from '../domains/http-triage.js'
import { fetchRdapRecord } from '../domains/rdap-record.js'

const apply = process.argv[2] === 'apply'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const rows = await sql<Array<{ id: number; domain: string; status: string }>>`
  SELECT id, domain, status FROM domain_candidates
   WHERE status IN ('EXPIRING_SOON','PARKED_DEAD','BROKEN') ORDER BY domain`
console.log(`re-probing ${rows.length} row(s)\n`)

let cursor = 0
const moves: string[] = []
async function worker(): Promise<void> {
  for (;;) {
    const row = rows[cursor++]
    if (!row) return
    try {
      const dns = await dnsTriage(row.domain)
      const http = await httpTriage(row.domain)
      const rdap = await fetchRdapRecord(row.domain)
      const c = classifyDomain({ dns, http, rdap })
      if (c.status !== row.status) {
        moves.push(`  ${row.domain.slice(0, 38).padEnd(40)} ${row.status} -> ${c.status}`)
        if (apply) {
          await sql`
            UPDATE domain_candidates
               SET status = ${c.status}, reason = ${c.reason},
                   http_outcome = ${http.outcome}, http_status = ${http.httpStatus},
                   days_to_expiry = ${c.daysToExpiry}
             WHERE id = ${row.id}`
        }
      }
    } catch { /* leave it */ }
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
console.log(`${moves.length} of ${rows.length} corrected:`)
for (const m of moves.sort()) console.log(m)
const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('\nall rows:', after.map((r) => `${r.status}=${r.n}`).join('  '))
if (!apply) console.log('(dry run)')
await sql.end()
