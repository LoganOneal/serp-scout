import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const locs = await sql`
  select id, name, state_code, provider_location_code, location_source, slug
  from localities
  where state_code = 'TX' and lower(name) like '%houston%'
  order by population desc nulls last
  limit 8
`
console.log('localities', locs)

const geos = await sql`
  select id, market, state_abbr, dataforseo_location_code, locality_id, location_source
  from research_geos
  where lower(market) like '%houston%' or locality_id = any(${locs.map((l) => l.id as number)})
  limit 10
`
console.log('research_geos', geos)

const bySrc = await sql`
  select location_source, count(*)::int as n,
         count(provider_location_code)::int as with_code
  from localities group by 1 order by 2 desc
`
console.log('locality sources', bySrc)

await sql.end()
