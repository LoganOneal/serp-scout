/**
 * How many domains are already sitting in data we have paid for?
 *
 * The sweep buys an organic SERP and (optionally) a map pack for every
 * niche x market cell, and stores the domains it saw. The domain search
 * currently ignores all of it and re-enumerates from Maps.
 */
import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const cols = await sql<Array<{ column_name: string }>>`
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'discovery_serp_metrics'
     AND column_name IN ('top_organic_domains','maps_domains','maps_entry_count','gbp_leaders')`
console.log('stored SERP columns:', cols.map((c) => c.column_name).join(', ') || 'none')

const stats = await sql<Array<any>>`
  SELECT count(*)::int rows,
         count(top_organic_domains)::int with_organic,
         count(maps_domains)::int with_maps
    FROM discovery_serp_metrics`
console.log(`\nmetric rows: ${stats[0].rows}  with organic domains: ${stats[0].with_organic}  with maps domains: ${stats[0].with_maps}`)

const organic = await sql<Array<{ d: string }>>`
  SELECT DISTINCT jsonb_array_elements(top_organic_domains)->>'domain' AS d
    FROM discovery_serp_metrics WHERE top_organic_domains IS NOT NULL`
const maps = await sql<Array<{ d: string }>>`
  SELECT DISTINCT jsonb_array_elements_text(maps_domains) AS d
    FROM discovery_serp_metrics WHERE maps_domains IS NOT NULL`
const known = await sql<Array<{ d: string }>>`SELECT DISTINCT domain AS d FROM domain_candidates`

const o = new Set(organic.map((x) => x.d).filter(Boolean))
const m = new Set(maps.map((x) => x.d).filter(Boolean))
const k = new Set(known.map((x) => x.d))
const all = new Set([...o, ...m])
const untested = [...all].filter((d) => !k.has(d))

console.log(`\ndistinct organic domains stored : ${o.size}`)
console.log(`distinct map-pack domains stored: ${m.size}`)
console.log(`union                           : ${all.size}`)
console.log(`already triaged by domain search: ${k.size}`)
console.log(`NEVER TRIAGED                   : ${untested.length}`)
console.log('\nsample never-triaged:')
for (const d of untested.slice(0, 12)) console.log(`  ${d}`)
await sql.end()
