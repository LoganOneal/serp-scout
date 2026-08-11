/**
 * Backfill serp_rank onto candidate rows created before the SERP harvest.
 *
 * The rank is sitting in discovery_serp_metrics for the same market; older runs
 * simply never looked. Free, and it lets the ranking signal settle rows those
 * runs left as UNKNOWN.
 */
import 'dotenv/config'
import postgres from 'postgres'

const apply = process.argv[2] === 'apply'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

// Best organic rank per (location, domain) from everything already purchased.
const ranks = await sql<Array<{ location_code: number; domain: string; rank: number }>>`
  SELECT m.location_code,
         lower(e->>'domain') AS domain,
         min((e->>'rankAbsolute')::int) AS rank
    FROM discovery_serp_metrics m,
         jsonb_array_elements(m.top_organic_domains) e
   WHERE m.top_organic_domains IS NOT NULL
     AND e->>'domain' IS NOT NULL
     AND e->>'rankAbsolute' IS NOT NULL
   GROUP BY 1, 2`
const byKey = new Map(ranks.map((r) => [`${r.location_code}|${r.domain}`, r.rank]))
console.log(`${byKey.size} (market, domain) rank(s) available`)

const rows = await sql<Array<{ id: number; domain: string; status: string; location_code: number }>>`
  SELECT c.id, c.domain, c.status, r.location_code
    FROM domain_candidates c
    JOIN domain_enrich_runs r ON r.id = c.run_id
   WHERE c.serp_rank IS NULL`
let filled = 0
let settled = 0
for (const row of rows) {
  const rank = byKey.get(`${row.location_code}|${row.domain}`)
  if (rank == null) continue
  filled += 1
  const settle = row.status === 'UNKNOWN'
  if (settle) settled += 1
  if (apply) {
    await sql`
      UPDATE domain_candidates
         SET serp_rank = ${rank},
             status = ${settle ? 'LIVE' : row.status},
             reason = ${settle ? `Ranked #${rank} organically — the probe was blocked, not the site` : sql`reason`}
       WHERE id = ${row.id}`
  }
}
console.log(`ranks filled: ${filled} · UNKNOWN rows settled: ${settled}${apply ? '' : ' (dry run)'}`)
const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('all rows:', after.map((x) => `${x.status}=${x.n}`).join('  '))
await sql.end()
