import 'dotenv/config'
import postgres from 'postgres'

/**
 * The orphaned-GBP candidates the backfill has found so far.
 *
 * Every row here is a business that was in a Google map pack while its website
 * is not a live business -- the profile outlived the site. Listed live, because
 * the run takes over an hour and the interesting rows are worth seeing before
 * it finishes.
 *
 * Free. Reads committed rows.
 */
const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

const DEAD = ['AVAILABLE', 'PENDING_DELETE', 'REDEMPTION', 'EXPIRING_SOON', 'PARKED_DEAD', 'BROKEN']

const [run] = await s`
  select id from domain_enrich_runs
   where niche = '(map-pack backfill)' order by id desc limit 1
`
const runId = run!['id'] as number

/**
 * The map-pack keyword that surfaced each domain, so a row can be read in
 * context: "in the AC repair pack" is the difference between a lead asset and
 * a domain that happened to be dead.
 */
const rows = await s`
  with map_entries as (
    select distinct lower(trim(both '"' from d::text)) as domain, m.keyword
      from discovery_serp_metrics m, jsonb_array_elements(m.maps_domains) as d
     where m.maps_domains is not null
  )
  select c.domain,
         c.status,
         c.age_years,
         c.years_of_content,
         c.total_snapshots,
         c.reason,
         min(e.keyword) as seen_keyword
    from domain_candidates c
    left join map_entries e on e.domain = c.domain
   where c.run_id = ${runId}
     and c.status = any(${DEAD})
   group by c.domain, c.status, c.age_years, c.years_of_content, c.total_snapshots, c.reason
   order by
     case c.status
       when 'PENDING_DELETE' then 1 when 'REDEMPTION' then 2 when 'AVAILABLE' then 3
       when 'EXPIRING_SOON' then 4 when 'PARKED_DEAD' then 5 else 6 end,
     c.years_of_content desc nulls last,
     c.age_years desc nulls last
`

console.log(`ORPHANED-GBP CANDIDATES SO FAR (run #${runId}): ${rows.length}\n`)
console.log(
  'domain'.padEnd(40) + 'status'.padEnd(16) + 'age'.padStart(6) + 'arch'.padStart(6) +
    'snaps'.padStart(7) + '  map-pack keyword',
)
console.log('-'.repeat(110))

for (const r of rows) {
  console.log(
    String(r['domain']).slice(0, 38).padEnd(40) +
      String(r['status']).padEnd(16) +
      (r['age_years'] == null ? '—' : Number(r['age_years']).toFixed(1)).padStart(6) +
      String(r['years_of_content'] ?? '—').padStart(6) +
      String(r['total_snapshots'] ?? '—').padStart(7) +
      '  ' +
      String(r['seen_keyword'] ?? '—').slice(0, 34),
  )
}

/**
 * Archive depth separates a business that traded for years from a churn domain
 * that never had a site. It is the only quality signal available for free.
 */
const withHistory = rows.filter((r) => Number(r['years_of_content'] ?? 0) >= 3)
console.log(
  `\n${withHistory.length} of ${rows.length} have 3+ years of archived content ` +
    `— the ones where a real business actually traded.`,
)
console.log(
  `Link metrics are NOT bought yet; that pass runs on the survivors once the\n` +
    `sweep finishes, at roughly $0.00029 per domain.`,
)

await s.end()
