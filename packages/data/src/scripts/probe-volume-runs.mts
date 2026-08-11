import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<any>>`SELECT fetch_volume, count(*)::int n FROM discovery_runs GROUP BY 1 ORDER BY n DESC`
for (const x of r) console.log(`  fetch_volume=${x.fetch_volume}: ${x.n} run(s)`)
const m = await sql<Array<any>>`
  SELECT count(*)::int total, count(avg_monthly_searches)::int with_vol FROM discovery_serp_metrics`
console.log(`\nmetric rows: ${m[0].total} · with volume: ${m[0].with_vol} (${Math.round(m[0].with_vol/m[0].total*100)}%)`)
await sql.end()
