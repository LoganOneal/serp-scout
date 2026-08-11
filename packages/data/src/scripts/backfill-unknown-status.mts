/**
 * Reclassify rows that were bucketed PARKED_DEAD when triage never concluded.
 *
 * Those rows already carried the honest reason ("No conclusive signal") and the
 * `triage` entry in score_missing -- only the STATUS was wrong, and the status
 * is what every list and count reads. quixservice.com is the worked example: a
 * live business with 3 A records, presented as an acquisition candidate.
 *
 *   pnpm exec tsx packages/data/src/scripts/backfill-unknown-status.mts
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const before = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int AS n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('before:', before.map((r) => `${r.status}=${r.n}`).join('  '))

// Match on http_outcome, not on the reason text: the outcome is the fact, the
// wording is presentation and has already changed once.
const updated = await sql`
  UPDATE domain_candidates
     SET status = 'UNKNOWN',
         reason = 'No conclusive signal; triage did not complete'
   WHERE status = 'PARKED_DEAD'
     AND http_outcome = 'unknown'
  RETURNING domain`
console.log(`\nreclassified ${updated.length} row(s) to UNKNOWN`)
for (const r of updated.slice(0, 20)) console.log(`  ${r['domain']}`)

const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int AS n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('\nafter:', after.map((r) => `${r.status}=${r.n}`).join('  '))
await sql.end()
