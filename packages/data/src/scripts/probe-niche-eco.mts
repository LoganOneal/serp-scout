import 'dotenv/config'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })
const n = await s`
  select
    count(*)::int as niches,
    count(*) filter (where avg_ticket_micros is not null)::int as with_ticket,
    count(*) filter (where lead_value_micros is not null)::int as with_lead,
    count(*) filter (where gads_avg_monthly_searches is not null)::int as with_gads_vol,
    count(*) filter (where gads_competition_index is not null)::int as with_comp
  from niches where active
`
const top = await s`
  select slug, gads_avg_monthly_searches as vol,
         (avg_ticket_micros/1000000)::int as ticket_usd,
         (lead_value_micros/1000000)::int as lead_usd,
         gads_competition_index as comp
  from niches where active
  order by gads_avg_monthly_searches desc nulls last
  limit 6
`
const kw = await s`
  select count(*)::int as primaries,
    count(*) filter (where avg_monthly_searches is not null)::int as with_vol
  from research_keywords where active and variant = 'primary'
`
const geo = await s`
  select count(*)::int as n from research_geos
  where active and dataforseo_location_code is not null
`
console.log('=== niches ===', n[0])
console.log('=== top by GAds vol ===')
for (const r of top) console.log(r)
console.log('=== catalog ===', { keywords: kw[0], geos: geo[0] })
await s.end()
