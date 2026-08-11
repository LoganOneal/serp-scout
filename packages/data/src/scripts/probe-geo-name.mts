import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const codes = process.argv.slice(2).map(Number)
const r = await sql<Array<any>>`
  SELECT DISTINCT dataforseo_location_code AS code, dataforseo_location_name AS name,
         dataforseo_location_type AS type, market, state_abbr, population_2025
    FROM research_geos WHERE dataforseo_location_code = ANY(${codes})`
for (const x of r)
  console.log(`${x.code}  ${String(x.type).padEnd(12)} "${x.name}"  (market: ${x.market}, ${x.state_abbr}, pop ${x.population_2025?.toLocaleString() ?? '—'})`)
await sql.end()
