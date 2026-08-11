/**
 * Fill registry data for rows that never got it.
 *
 * LIVE rows returned before RDAP ran, so 155 live business domains carry no
 * expiry at all. That is the blind spot that matters most for "buy a domain
 * that is about to lapse": a working business whose registration quietly runs
 * out is the single best acquisition signal there is, and we could not see it.
 *
 * The status is NOT changed here -- a live site with a renewal due is still
 * live. Only the expiry becomes visible, so it can be watched.
 *
 * Free: RDAP only.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/backfill-live-expiry.mts
 */
import 'dotenv/config'
import postgres from 'postgres'
import { fetchRdapRecord } from '../domains/rdap-record.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const rows = await sql<Array<{ id: number; domain: string }>>`
  SELECT id, domain FROM domain_candidates
   WHERE days_to_expiry IS NULL AND status <> 'AVAILABLE' ORDER BY domain`
console.log(`${rows.length} row(s) missing registry data\n`)

const DAY = 86_400_000
let cursor = 0
let filled = 0
const soon: string[] = []

async function worker(): Promise<void> {
  for (;;) {
    const row = rows[cursor++]
    if (!row) return
    try {
      const r = await fetchRdapRecord(row.domain)
      if (r.registered !== true || !r.expiresAt) continue
      const days = Math.round((r.expiresAt.getTime() - Date.now()) / DAY)
      const age = r.createdAt
        ? (Date.now() - r.createdAt.getTime()) / (DAY * 365.25)
        : null
      filled += 1
      if (days <= 90) soon.push(`  ${String(days).padStart(4)}d  ${row.domain}`)
      await sql`
        UPDATE domain_candidates
           SET days_to_expiry = ${days}, expires_at = ${r.expiresAt},
               registrar = COALESCE(registrar, ${r.registrar}),
               age_years = COALESCE(age_years, ${age})
         WHERE id = ${row.id}`
    } catch {
      /* leave the row as it was */
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker))

console.log(`filled expiry on ${filled} row(s)`)
console.log(`\n${soon.length} of them expire within 90 days:`)
for (const s of soon.sort()) console.log(s)
await sql.end()
