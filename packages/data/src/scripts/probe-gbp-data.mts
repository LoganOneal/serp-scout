import 'dotenv/config'
import postgres from 'postgres'

/**
 * What Google Business Profile data does this database already hold?
 *
 * `collect-businesses.ts` reads `is_claimed`, `rating`, `votes_count`,
 * `place_id` and `cid` off every map-pack listing and then throws all of it
 * away -- run-enrich persists only `{name, website}` per business. An unclaimed
 * profile with 40 reviews in a target market is a takeover candidate, and the
 * field that identifies one has been fetched and discarded on every run.
 *
 * This measures what survived, so the GBP plan is grounded rather than guessed.
 */
const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

const [gbp] = await s`
  select
    count(*)::int                                              as rows,
    count(*) filter (where gbp_leaders is not null)::int        as with_gbp_leaders,
    count(*) filter (where maps_domains is not null)::int       as with_maps_domains,
    count(*) filter (where jsonb_array_length(coalesce(gbp_leaders,'[]'::jsonb)) > 0)::int as gbp_nonempty
  from discovery_serp_metrics
`
console.log('discovery_serp_metrics:', gbp)

const sample = await s`
  select keyword, location_code, gbp_leaders
    from discovery_serp_metrics
   where gbp_leaders is not null
     and jsonb_array_length(gbp_leaders) > 0
   limit 3
`
console.log('\ngbp_leaders sample:')
for (const r of sample) {
  console.log(`  ${r['keyword']} @ ${r['location_code']}`)
  console.log(`    ${JSON.stringify(r['gbp_leaders']).slice(0, 600)}`)
}
if (sample.length === 0) {
  console.log('  EMPTY — the column has never been populated with a non-empty array.')
}

// What the candidate businesses jsonb actually retained.
const biz = await s`
  select businesses
    from domain_candidates
   where businesses is not null
     and jsonb_array_length(businesses) > 0
   limit 3
`
console.log('\ndomain_candidates.businesses sample (what survived collection):')
for (const r of biz) console.log(`  ${JSON.stringify(r['businesses']).slice(0, 300)}`)

await s.end()
