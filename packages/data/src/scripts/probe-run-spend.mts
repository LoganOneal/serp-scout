/**
 * Where a run's money actually went.
 *
 * Reconstructs the API calls a run made from what it stored, then compares that
 * against the spend ledger. A gap between the two is untracked spend — the exact
 * failure that made a $3.76 run report $0.16.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-run-spend.mts [runId]
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const SERP = 0.002
const MAPS = 0.002
const VOLUME = 0.09

const arg = Number(process.argv[2])
const [run] = await sql<
  Array<{
    id: number
    label: string | null
    status: string
    job_count: number
    jobs_done: number
    jobs_failed: number
    devices: string | null
    used_fixtures: boolean
    spend_micros: string | null
    estimated_cost_micros: string | null
    created_at: Date
  }>
>`
  SELECT id, label, status, job_count, jobs_done, jobs_failed, devices, used_fixtures,
         spend_micros::text, estimated_cost_micros::text, created_at
    FROM discovery_runs
   ${Number.isInteger(arg) && arg > 0 ? sql`WHERE id = ${arg}` : sql`WHERE source = 'catalog'`}
   ORDER BY id DESC
   LIMIT 1
`
if (!run) {
  console.log('No run found.')
  await sql.end()
  process.exit(0)
}

console.log(`Run #${run.id} — ${run.label ?? '(no label)'}`)
console.log(`  status ${run.status} · devices ${run.devices ?? 'desktop'} · ${run.created_at.toISOString()}`)
console.log(`  jobs   ${run.jobs_done} done / ${run.jobs_failed} failed of ${run.job_count}`)
console.log(`  fixtures ${run.used_fixtures}`)

// What the run stored — this is the evidence of which calls were made.
const [m] = await sql<
  Array<{
    metrics: number
    cells: number
    kw_loc_pairs: number
    with_volume: number
    with_maps: number
    locations: number
  }>
>`
  SELECT count(*)::int                                                        AS metrics,
         count(DISTINCT (research_keyword_id, research_geo_id))::int          AS cells,
         count(DISTINCT (keyword, location_code))::int                        AS kw_loc_pairs,
         count(*) FILTER (WHERE volume_source IS NOT NULL
                            AND volume_source NOT IN ('skipped','fixture'))::int AS with_volume,
         count(*) FILTER (WHERE maps_entry_count IS NOT NULL)::int            AS with_maps,
         count(DISTINCT location_code)::int                                   AS locations
    FROM discovery_serp_metrics
   WHERE run_id = ${run.id}
`

const serpCalls = run.jobs_done + run.jobs_failed
const volUnbatched = m?.kw_loc_pairs ?? 0
const volBatched = m?.locations ?? 0
const mapsCalls = m?.with_maps ?? 0

const row = (name: string, calls: number, unit: number) =>
  `  ${name.padEnd(34)} ${String(calls).padStart(6)}  x $${unit.toFixed(3)}  = $${(calls * unit).toFixed(4)}`

/**
 * Billed call counts come from the ledger, not from stored metrics.
 * A metric row can carry maps data it read from another job's result — 80 rows
 * with a maps figure is 4 maps PURCHASES plus 76 cache hits.
 */
const billed = await sql<Array<{ endpoint: string; n: number }>>`
  SELECT endpoint, count(*)::int AS n
    FROM spend_ledger
   WHERE discovery_run_id = ${run.id}
   GROUP BY endpoint
`
const billedBy = new Map(billed.map((b) => [b.endpoint, b.n]))
const volActual = billedBy.get('keywords_data/google_ads/search_volume/live') ?? 0
const mapsBilled = billedBy.get('serp/google/maps/live/advanced') ?? 0

console.log(`\n=== calls this run made ===`)
console.log(row('serp/google/organic/live/advanced', serpCalls, SERP))
console.log(row('keywords_data/.../search_volume  ', volActual, VOLUME))
console.log(row('serp/google/maps/live/advanced   ', mapsBilled, MAPS))
console.log(`  ${'  (maps cache hits, free)'.padEnd(34)} ${String(Math.max(0, mapsCalls - mapsBilled)).padStart(6)}`)
const modelled = serpCalls * SERP + volActual * VOLUME + mapsBilled * MAPS
console.log(`  ${'TOTAL'.padEnd(34)} ${' '.repeat(6)}            = $${modelled.toFixed(4)}`)
console.log(
  `\n  counterfactual — one volume request per keyword (the old bug):\n` +
    `  ${'  volume unbatched'.padEnd(34)} ${String(volUnbatched).padStart(6)}  x $${VOLUME.toFixed(3)}  = $${(
      volUnbatched * VOLUME
    ).toFixed(4)}   → run total $${(serpCalls * SERP + volUnbatched * VOLUME + mapsBilled * MAPS).toFixed(4)}`,
)
console.log(`  ${'  distinct locations in run'.padEnd(34)} ${String(volBatched).padStart(6)}`)

// What we actually wrote down.
const ledger = await sql<Array<{ endpoint: string; n: number; total: string }>>`
  SELECT endpoint, count(*)::int AS n, COALESCE(SUM(cost_micros), 0)::text AS total
    FROM spend_ledger
   WHERE discovery_run_id = ${run.id}
   GROUP BY endpoint
   ORDER BY 3 DESC
`
console.log(`\n=== what the ledger recorded ===`)
if (ledger.length === 0) console.log('  (nothing)')
for (const l of ledger) {
  console.log(`  ${l.endpoint.padEnd(40)} ${String(l.n).padStart(5)} lines  $${(Number(l.total) / 1e6).toFixed(4)}`)
}
const ledgerTotal = ledger.reduce((a, l) => a + Number(l.total), 0) / 1e6
const runSpend = Number(run.spend_micros ?? 0) / 1e6
console.log(`  ${'run.spend_micros'.padEnd(40)} ${' '.repeat(11)}  $${runSpend.toFixed(4)}`)

console.log(`\n=== reconciliation ===`)
console.log(`  modelled actual cost   $${modelled.toFixed(4)}`)
console.log(`  ledger says            $${ledgerTotal.toFixed(4)}`)
console.log(`  UNTRACKED              $${(modelled - ledgerTotal).toFixed(4)}`)

await sql.end()
