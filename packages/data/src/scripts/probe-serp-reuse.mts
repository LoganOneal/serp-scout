/**
 * How much SERP spend went on keyword x location x device combinations we had
 * ALREADY bought? The discovery path does not read the serp_snapshots cache,
 * so a re-sweep of the same market re-buys every cell.
 */
import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const [tot] = await sql<Array<any>>`
  SELECT count(*)::int total,
         count(DISTINCT (keyword, location_code, device))::int distinct_cells
    FROM discovery_serp_metrics`
console.log(`SERPs measured: ${tot.total} · distinct keyword x location x device: ${tot.distinct_cells}`)
const dupes = tot.total - tot.distinct_cells
console.log(`re-bought: ${dupes} (${((dupes / tot.total) * 100).toFixed(1)}%) = $${(dupes * 0.002).toFixed(3)} wasted\n`)

const worst = await sql<Array<any>>`
  SELECT keyword, location_code, device, count(*)::int n,
         min(measured_at)::date first_at, max(measured_at)::date last_at
    FROM discovery_serp_metrics
   GROUP BY 1,2,3 HAVING count(*) > 1
   ORDER BY n DESC LIMIT 10`
if (worst.length === 0) console.log('No cell measured twice yet.')
else {
  console.log('most re-bought cells:')
  for (const w of worst)
    console.log(`  ${String(w.n).padStart(2)}x  ${String(w.keyword).slice(0,34).padEnd(36)} loc ${w.location_code} ${w.device.padEnd(7)} ${w.first_at} -> ${w.last_at}`)
}

const [agg] = await sql<Array<any>>`
  SELECT count(*)::int n, sum(cost_micros)::text total
    FROM spend_ledger WHERE endpoint LIKE '%serp%'`
console.log(`\nledger SERP lines: ${agg.n} · $${(Number(agg.total) / 1e6).toFixed(4)}`)
await sql.end()
