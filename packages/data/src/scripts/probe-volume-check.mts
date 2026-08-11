import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const like = process.argv[2] ?? 'foundation'
const rows = await sql<Array<any>>`
  SELECT m.keyword, m.location_code, m.device, m.avg_monthly_searches AS vol,
         m.volume_source, m.volume_geo_target, l.name AS locality
    FROM discovery_serp_metrics m
    LEFT JOIN localities l ON l.id = m.locality_id
   WHERE m.keyword ILIKE ${'%' + like + '%'}
   ORDER BY m.location_code, m.keyword, m.device`
console.log('keyword                              loc      device   vol    source                geo_target')
console.log('-'.repeat(104))
for (const r of rows)
  console.log(
    `${String(r.keyword).slice(0,36).padEnd(37)} ${String(r.location_code).padEnd(8)} ${String(r.device).padEnd(8)} ` +
    `${String(r.vol ?? '—').padStart(5)}  ${String(r.volume_source ?? '—').padEnd(22)} ${r.volume_geo_target ?? '—'}`)
const sums = await sql<Array<any>>`
  SELECT m.location_code, l.name AS locality, count(DISTINCT m.keyword)::int kws,
         sum(DISTINCT m.avg_monthly_searches) AS naive_sum
    FROM discovery_serp_metrics m LEFT JOIN localities l ON l.id = m.locality_id
   WHERE m.keyword ILIKE ${'%' + like + '%'} AND m.avg_monthly_searches IS NOT NULL
   GROUP BY 1,2`
console.log('\nwhat the grid would SUM per market:')
for (const s2 of sums) console.log(`  ${s2.locality ?? s2.location_code}: ${s2.kws} keywords -> ${s2.naive_sum}`)
await sql.end()
