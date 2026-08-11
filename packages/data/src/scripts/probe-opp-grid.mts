import 'dotenv/config'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })
const geos = await s`
  select id, market, state_abbr, locality_id, dataforseo_location_code
  from research_geos
  where market ilike '%phoenix%'
  limit 5
`
console.log('phoenix geos', geos)

const metrics = await s`
  select id, keyword, location_code, avg_monthly_searches, volume_source, volume_geo_target,
         research_keyword_id, research_geo_id, locality_id, niche_id
  from discovery_serp_metrics
  where keyword ilike '%ac repair%' or keyword ilike '%junk%'
  order by id desc
  limit 10
`
console.log('metrics', metrics)

const locs = await s`
  select id, slug, name, state_code, provider_location_code
  from localities
  where name ilike 'phoenix%'
  limit 5
`
console.log('locs', locs)

const niches = await s`
  select id, slug, keyword_noun from niches
  where active = true
    and (
      keyword_noun ilike ${'%ac%'}
      or keyword_noun ilike ${'%hvac%'}
      or keyword_noun ilike ${'%air%'}
      or slug ilike ${'%hvac%'}
    )
  limit 30
`
console.log('niches', niches)

const kw = await s`
  select id, keyword, niche_id, avg_monthly_searches from research_keywords
  where keyword ilike ${'%ac repair%'}
  limit 5
`
console.log('research kw', kw)

await s.end()
