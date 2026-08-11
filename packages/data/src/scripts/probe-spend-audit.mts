/**
 * Every catalog run and the whole spend ledger, to answer "where did $X go".
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-spend-audit.mts
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const runs = await sql<
  Array<{
    id: number
    label: string | null
    job_count: number
    jobs_done: number
    devices: string | null
    spend_usd: string
    created_at: Date
  }>
>`
  SELECT id, label, job_count, jobs_done, devices,
         (spend_micros / 1000000.0)::numeric(12, 4)::text AS spend_usd, created_at
    FROM discovery_runs
   WHERE source = 'catalog'
   ORDER BY id DESC
   LIMIT 15
`
console.log('=== recent catalog runs ===')
for (const r of runs) {
  console.log(
    `#${String(r.id).padStart(3)}  $${r.spend_usd.padStart(8)}  ${String(r.jobs_done).padStart(4)}/${String(r.job_count).padEnd(5)} jobs  ` +
      `${(r.devices ?? 'desktop').padEnd(15)} ${r.created_at.toISOString().slice(0, 16)}  ${r.label ?? ''}`,
  )
}

const byEp = await sql<Array<{ endpoint: string; n: number; t: string }>>`
  SELECT endpoint, count(*)::int AS n, (SUM(cost_micros) / 1000000.0)::numeric(12, 4)::text AS t
    FROM spend_ledger
   GROUP BY endpoint
   ORDER BY 3 DESC
`
console.log('\n=== spend_ledger by endpoint, all time ===')
for (const e of byEp) console.log(`  ${e.endpoint.padEnd(46)} ${String(e.n).padStart(5)}  $${e.t}`)

const [tot] = await sql<Array<{ t: string; n: number }>>`
  SELECT (COALESCE(SUM(cost_micros), 0) / 1000000.0)::numeric(12, 4)::text AS t, count(*)::int AS n
    FROM spend_ledger
`
console.log(`  ${'TOTAL'.padEnd(46)} ${String(tot?.n).padStart(5)}  $${tot?.t}`)

const [cache] = await sql<Array<{ n: number; locs: number }>>`
  SELECT count(*)::int AS n, count(DISTINCT location_code)::int AS locs FROM keyword_volume_cache
`
console.log(`\nvolume cache: ${cache?.n} keyword rows across ${cache?.locs} location(s)`)

await sql.end()
