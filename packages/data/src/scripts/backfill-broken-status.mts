/**
 * Reclassify 5xx rows out of PARKED_DEAD.
 *
 * A server returning 500 is a server that is running, executing code and being
 * paid for. It was being counted as "nothing is served" alongside domains with
 * no host at all -- opposite conclusions for an acquisition decision.
 *
 *   pnpm exec tsx packages/data/src/scripts/backfill-broken-status.mts
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const updated = await sql<Array<{ domain: string; http_status: number }>>`
  UPDATE domain_candidates
     SET status = 'BROKEN',
         reason = 'Server responding but erroring (5xx) — hosting is active'
   WHERE status = 'PARKED_DEAD'
     AND http_outcome = 'dead'
     AND http_status >= 500
  RETURNING domain, http_status`
console.log(`reclassified ${updated.length} row(s) to BROKEN`)
for (const r of updated) console.log(`  ${r.domain}  (HTTP ${r.http_status})`)

const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int AS n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('\nafter:', after.map((r) => `${r.status}=${r.n}`).join('  '))
await sql.end()
