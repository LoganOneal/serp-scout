/**
 * Were any "LIVE" domains actually expired?
 *
 * Rows classified LIVE were returned BEFORE RDAP ever ran, so the registry was
 * never consulted for them. A domain parked on a seller whose page cleared the
 * text floor would land here and be dropped silently. This asks the registry
 * about every one of them.
 *
 * Free: DNS, HTTP and RDAP only.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/audit-live-false-negatives.mts [apply]
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
  SELECT id, domain, status FROM domain_candidates WHERE status = 'LIVE' ORDER BY domain`
console.log(`re-checking ${rows.length} LIVE row(s) against the registry\n`)

let cursor = 0
const changed: string[] = []

async function worker(): Promise<void> {
  for (;;) {
    const row = rows[cursor++]
    if (!row) return
    try {
      const [dns, http] = [await dnsTriage(row.domain), await httpTriage(row.domain)]
      const rdap = await fetchRdapRecord(row.domain)
      const c = classifyDomain({ dns, http, rdap })
      if (c.status !== 'LIVE') {
        changed.push(`  ${row.domain.padEnd(40)} LIVE -> ${c.status.padEnd(14)} ${c.reason}`)
        if (apply) {
          await sql`
            UPDATE domain_candidates
               SET status = ${c.status}, reason = ${c.reason},
                   http_outcome = ${http.outcome}, http_status = ${http.httpStatus},
                   age_years = ${c.ageYears}, days_to_expiry = ${c.daysToExpiry},
                   registrar = ${rdap.registrar}
             WHERE id = ${row.id}`
        }
      }
    } catch {
      /* a failed re-check leaves the row as it was */
    }
  }
}

await Promise.all(Array.from({ length: 8 }, worker))

console.log(`${changed.length} of ${rows.length} were NOT live:`)
for (const c of changed) console.log(c)
if (changed.length > 0 && !apply) console.log('\n(dry run — re-run with `apply` to persist)')
await sql.end()
