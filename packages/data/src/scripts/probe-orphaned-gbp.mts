import 'dotenv/config'
import postgres from 'postgres'

/**
 * B0(a) — orphaned Google Business Profiles, from data already purchased.
 *
 * ==================== THE JOIN NOBODY HAS RUN ====================
 * A business that still appears in a map pack while its WEBSITE is dead is an
 * orphaned profile: the company stopped paying for hosting but the GBP -- with
 * its reviews, its photos and its ranking history -- is still standing.
 *
 * For local lead generation that profile is the asset. It ranks in the map pack
 * today, with no domain authority, no backlinks and no content runway.
 *
 * Both halves of the join already exist and have never been put together:
 *   discovery_serp_metrics.maps_domains  -- who was in the map pack (438 rows)
 *   domain_candidates.status             -- whether their site is dead (1,371)
 *
 * Free. No API calls.
 * ================================================================
 */

const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

/** Statuses meaning "the website is not a live business". */
const DEAD = ['AVAILABLE', 'PARKED_DEAD', 'EXPIRING_SOON', 'REDEMPTION', 'PENDING_DELETE', 'BROKEN']

const [coverage] = await s`
  select
    count(*) filter (where maps_domains is not null)::int                        as rows_with_maps,
    count(distinct location_code) filter (where maps_domains is not null)::int   as markets,
    sum(jsonb_array_length(coalesce(maps_domains, '[]'::jsonb)))::int            as total_map_entries
  from discovery_serp_metrics
`
console.log('MAP-PACK COVERAGE ALREADY PURCHASED:', coverage)

/**
 * Every distinct domain seen in a map pack, with the market and query that saw
 * it. `maps_domains` is a jsonb array of bare domain strings.
 */
const orphans = await s`
  with map_entries as (
    select distinct
           lower(trim(both '"' from d::text)) as domain,
           m.location_code,
           m.keyword
      from discovery_serp_metrics m,
           jsonb_array_elements(m.maps_domains) as d
     where m.maps_domains is not null
  )
  select e.domain,
         e.location_code,
         min(e.keyword)                    as seen_keyword,
         max(c.status)                     as status,
         max(c.age_years)                  as age_years,
         max(c.referring_domains)          as refdom,
         max(c.domain_rank)                as domain_rank,
         max(c.spam_score)                 as spam
    from map_entries e
    join domain_candidates c on c.domain = e.domain
   where c.status = any(${DEAD})
   group by e.domain, e.location_code
   order by max(c.domain_rank) desc nulls last, max(c.referring_domains) desc nulls last
`

console.log(`\nORPHANED GBP CANDIDATES: ${orphans.length}`)
console.log('(in a map pack, website is not a live business)\n')

if (orphans.length === 0) {
  console.log('  None. Either map-pack coverage and triage coverage do not overlap,')
  console.log('  or every mapped business still has a working site.')
} else {
  console.log(
    'domain'.padEnd(40) + 'status'.padEnd(15) + 'rank'.padStart(6) + 'refdom'.padStart(8) +
      'spam'.padStart(6) + '  keyword',
  )
  for (const o of orphans) {
    console.log(
      String(o['domain']).padEnd(40) +
        String(o['status']).padEnd(15) +
        String(o['domain_rank'] ?? '—').padStart(6) +
        String(o['refdom'] ?? '—').padStart(8) +
        String(o['spam'] ?? '—').padStart(6) +
        '  ' +
        String(o['seen_keyword'] ?? '').slice(0, 40),
    )
  }
}

/**
 * The overlap ceiling: how much of the map-pack population has been triaged at
 * all. A small orphan count means little when most mapped domains were never
 * checked -- that is a coverage gap, not an absence of orphans.
 */
const [overlap] = await s`
  with map_entries as (
    select distinct lower(trim(both '"' from d::text)) as domain
      from discovery_serp_metrics m, jsonb_array_elements(m.maps_domains) as d
     where m.maps_domains is not null
  )
  select count(*)::int                                                   as distinct_map_domains,
         count(*) filter (where exists (
           select 1 from domain_candidates c where c.domain = e.domain
         ))::int                                                          as triaged
    from map_entries e
`
console.log(`\nCOVERAGE CEILING:`)
console.log(`  distinct domains seen in map packs : ${overlap!['distinct_map_domains']}`)
console.log(`  of those, ever triaged             : ${overlap!['triaged']}`)
console.log(
  `  never checked                      : ${
    Number(overlap!['distinct_map_domains']) - Number(overlap!['triaged'])
  }  <- the real ceiling on this count`,
)

await s.end()
