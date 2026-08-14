import 'dotenv/config'
import postgres from 'postgres'

/**
 * The GBP takeover shortlist: map-pack businesses whose website is dead AND
 * which demonstrably traded for years.
 *
 * ==================== WHY ARCHIVE DEPTH IS THE RANKING ====================
 * 237 orphaned candidates is too many to act on, and the wrong 200 of them are
 * churn domains someone spun up for a lead-gen play and abandoned -- zero
 * archived content, novelty TLD, no business ever there.
 *
 * Archive depth is the only quality signal available for free, and it separates
 * the two populations cleanly: a business with 5 years of continuous archived
 * content and 60 snapshots was real, had customers, and almost certainly has a
 * Google profile carrying their reviews.
 *
 * The DOMAIN is not the asset here. It is the evidence that the business is
 * gone, and therefore that its profile is unattended.
 * =========================================================================
 */
const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

const DEAD = ['AVAILABLE', 'PENDING_DELETE', 'REDEMPTION', 'EXPIRING_SOON', 'PARKED_DEAD', 'BROKEN']
const MIN_YEARS = Number(process.env['MIN_YEARS'] ?? 3)

const rows = await s`
  with map_entries as (
    select distinct lower(trim(both '"' from d::text)) as domain, m.keyword
      from discovery_serp_metrics m, jsonb_array_elements(m.maps_domains) as d
     where m.maps_domains is not null
  )
  select c.domain, c.status, c.age_years, c.years_of_content, c.total_snapshots,
         c.last_content_snapshot_at,
         array_agg(distinct e.keyword) as keywords
    from domain_candidates c
    join map_entries e on e.domain = c.domain
   where c.status = any(${DEAD})
     and coalesce(c.years_of_content, 0) >= ${MIN_YEARS}
   group by c.domain, c.status, c.age_years, c.years_of_content,
            c.total_snapshots, c.last_content_snapshot_at
   order by c.years_of_content desc nulls last, c.total_snapshots desc nulls last
`

console.log(`GBP TAKEOVER SHORTLIST — ${rows.length} businesses`)
console.log(`(in a Houston map pack · website dead · ${MIN_YEARS}+ years of archived content)\n`)
console.log(
  'domain'.padEnd(38) + 'status'.padEnd(15) + 'age'.padStart(6) + 'arch'.padStart(5) +
    'snaps'.padStart(6) + '  last live  niche',
)
console.log('-'.repeat(116))

for (const r of rows) {
  const last = r['last_content_snapshot_at']
    ? new Date(r['last_content_snapshot_at'] as string).toISOString().slice(0, 7)
    : '—'
  const kws = (r['keywords'] as string[]).filter(Boolean)
  console.log(
    String(r['domain']).slice(0, 36).padEnd(38) +
      String(r['status']).padEnd(15) +
      (r['age_years'] == null ? '—' : Number(r['age_years']).toFixed(1)).padStart(6) +
      String(r['years_of_content'] ?? '—').padStart(5) +
      String(r['total_snapshots'] ?? '—').padStart(6) +
      '  ' + last.padEnd(10) + ' ' +
      kws.slice(0, 2).join(', ').slice(0, 40),
  )
}

/**
 * Obtainable AND historic is the rarest combination: the domain can be
 * registered outright while the profile is separately claimable.
 */
const both = rows.filter((r) =>
  ['AVAILABLE', 'PENDING_DELETE', 'REDEMPTION'].includes(String(r['status'])),
)
console.log(
  `\n${both.length} of ${rows.length} are ALSO obtainable at a registrar ` +
    `(domain + profile both in play):`,
)
for (const r of both) console.log(`  ${r['domain']}  (${r['years_of_content']}y archived)`)

console.log(
  `\nNEXT: none of these has been checked for is_claimed. That needs one Maps\n` +
    `call per niche (~$0.002 each) against the keywords above.`,
)

await s.end()
