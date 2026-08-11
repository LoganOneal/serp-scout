import 'dotenv/config'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })
const primaries = await s`
  select count(*)::int as n from research_keywords where active and variant = 'primary'
`
const withVol = await s`
  select count(*)::int as n from research_keywords where active and avg_monthly_searches is not null
`
const geos = await s`
  select count(*)::int as n from research_geos where active and dataforseo_location_code is not null
`
const sample = await s`
  select keyword, avg_monthly_searches from research_keywords
  where active and variant = 'primary' order by keyword limit 8
`
console.log({
  primaryKeywords: primaries[0]?.n,
  keywordsWithVolume: withVol[0]?.n,
  purchasableGeos: geos[0]?.n,
  sample,
})
await s.end()
