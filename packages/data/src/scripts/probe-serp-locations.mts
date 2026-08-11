import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<any>>`
  SELECT location_code, count(*)::int rows,
         count(top_organic_domains)::int organic,
         count(maps_domains)::int maps
    FROM discovery_serp_metrics GROUP BY location_code ORDER BY rows DESC LIMIT 10`
console.log('location   rows  organic  maps')
for (const x of r) console.log(`${String(x.location_code).padStart(8)} ${String(x.rows).padStart(6)} ${String(x.organic).padStart(8)} ${String(x.maps).padStart(5)}`)
await sql.end()
