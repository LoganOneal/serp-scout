import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<{ endpoint: string; n: number; total: string }>>`
  SELECT endpoint, count(*)::int AS n, sum(cost_micros)::text AS total
    FROM spend_ledger GROUP BY endpoint ORDER BY n DESC LIMIT 10`
console.log('  n        usd  endpoint')
for (const x of r) console.log(String(x.n).padStart(4), (Number(x.total) / 1e6).toFixed(4).padStart(10), x.endpoint)
const m = await sql<Array<{ volume_source: string | null; n: number }>>`
  SELECT volume_source, count(*)::int AS n FROM discovery_serp_metrics GROUP BY volume_source ORDER BY n DESC LIMIT 8`
console.log('\nvolume_source on measured metrics:')
for (const x of m) console.log(`  ${String(x.volume_source ?? 'NULL').padEnd(24)} ${x.n}`)
await sql.end()
