/**
 * Re-probe every PARKED_DEAD row with the corrected HTTP triage.
 *
 * The old probe called a page parked when its visible text fell under 600
 * characters. That assumes content lives in the HTML, which is false for any
 * JavaScript-rendered site -- and it sent a bot user-agent, which several sites
 * answer with a stripped page. Both produced "parked" for working businesses.
 *
 * Free: DNS, HTTP and RDAP.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/retriage-parked.mts [apply]
 */
import 'dotenv/config'
import postgres from 'postgres'
import { classifyDomain } from '@rnr/core'
import { dnsTriage } from '../domains/dns-triage.js'
import { httpTriage } from '../domains/http-triage.js'
import { fetchRdapRecord } from '../domains/rdap-record.js'

const apply = process.argv[2] === 'apply'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const rows = await sql<Array<{ id: number; domain: string; status: string }>>`
  SELECT id, domain, status FROM domain_candidates
   WHERE status IN ('PARKED_DEAD', 'BROKEN') ORDER BY domain`
console.log(`re-probing ${rows.length} row(s)\n`)

let cursor = 0
const moves: string[] = []
const counts = new Map<string, number>()

async function worker(): Promise<void> {
  for (;;) {
    const row = rows[cursor++]
    if (!row) return
    try {
      const dns = await dnsTriage(row.domain)
      const http = await httpTriage(row.domain)
      const rdap = await fetchRdapRecord(row.domain)
      const c = classifyDomain({ dns, http, rdap })
      counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
      if (c.status !== row.status) {
        moves.push(`  ${row.domain.slice(0, 38).padEnd(40)} ${row.status} -> ${c.status}`)
        if (apply) {
          await sql`
            UPDATE domain_candidates
               SET status = ${c.status}, reason = ${c.reason},
                   http_outcome = ${http.outcome}, http_status = ${http.httpStatus}
             WHERE id = ${row.id}`
        }
      }
    } catch { /* leave the row alone */ }
  }
}
await Promise.all(Array.from({ length: 8 }, worker))

console.log(`${moves.length} of ${rows.length} were misclassified:`)
for (const m of moves.sort()) console.log(m)
console.log('\nnew spread for these rows:', [...counts].map(([k, v]) => `${k}=${v}`).join('  '))
if (!apply) console.log('\n(dry run — re-run with `apply`)')
await sql.end()
