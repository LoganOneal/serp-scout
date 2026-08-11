/**
 * Repair rows the status backfills left half-updated.
 *
 * Two leftovers, both the kind of thing that bites later:
 *
 *  - `http_outcome` still says 'dead' on rows now marked BROKEN. That is the
 *    audit trail contradicting the verdict, and the re-triage script keys off
 *    http_outcome -- exactly how run #1's bad rows stayed hidden the first time.
 *
 *  - `score` still holds the value earned when the row counted as a candidate.
 *    borismechanical.com sits at 41.9, the score that made it the top find in
 *    two runs, while now being excluded from candidacy. Anything that sorts
 *    across all statuses would put it back on top.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/repair-reclassified-rows.mts
 */
import 'dotenv/config'
import postgres from 'postgres'
import { scoreDomain, type DomainStatus } from '@rnr/core'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const outcomeFixed = await sql`
  UPDATE domain_candidates SET http_outcome = 'broken'
   WHERE status = 'BROKEN' AND http_status >= 500 AND http_outcome <> 'broken'
  RETURNING domain`
console.log(`http_outcome corrected on ${outcomeFixed.length} BROKEN row(s)`)

const rows = await sql<Array<any>>`
  SELECT id, domain, status, score, age_years, trust_flow, citation_flow,
         referring_domains, referring_subnets, years_of_content, business_count
    FROM domain_candidates
   WHERE status IN ('BROKEN', 'UNKNOWN', 'LIVE')`

let rescored = 0
for (const r of rows) {
  const s = scoreDomain({
    status: r.status as DomainStatus,
    ageYears: r.age_years,
    trustFlow: r.trust_flow,
    citationFlow: r.citation_flow,
    referringDomains: r.referring_domains,
    referringSubnets: r.referring_subnets,
    topicalRelevancePct: null,
    yearsOfContent: r.years_of_content,
    businessCount: r.business_count ?? 1,
    // These statuses exist precisely because triage did not establish
    // candidacy, so none of them may claim a conclusive verdict.
    conclusiveTriage: false,
  })
  if (Math.abs(s.total - Number(r.score)) > 0.05) {
    rescored += 1
    await sql`
      UPDATE domain_candidates
         SET score = ${s.total}, score_components = ${sql.json(s.components)},
             score_missing = ${sql.json(s.missing)}
       WHERE id = ${r.id}`
  }
}
console.log(`rescored ${rescored} non-candidate row(s)`)

const check = await sql<Array<any>>`
  SELECT domain, status, score, http_outcome FROM domain_candidates
   WHERE domain IN ('borismechanical.com','quixservice.com','kohler.com') ORDER BY domain`
console.log('\nspot check:')
for (const c of check) {
  console.log(`  ${c.domain.padEnd(24)} ${String(c.status).padEnd(9)} score ${String(c.score).padStart(5)}  outcome=${c.http_outcome}`)
}
await sql.end()
