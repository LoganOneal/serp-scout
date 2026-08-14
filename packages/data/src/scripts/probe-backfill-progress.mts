import 'dotenv/config'
import postgres from 'postgres'

/**
 * Progress of the map-pack backfill, read from the database rather than the log.
 *
 * The script's stdout is block-buffered when redirected to a file, so the log
 * stays empty for long stretches while work is very much happening. The
 * candidate rows are committed in batches of 50, so counting them is the honest
 * progress signal.
 */
const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

const [run] = await s`
  select id, status, max_results, created_at, completed_at
    from domain_enrich_runs
   where niche = '(map-pack backfill)'
   order by id desc
   limit 1
`

if (!run) {
  console.log('No backfill run found.')
} else {
  const [progress] = await s`
    select count(*)::int as inserted
      from domain_candidates where run_id = ${run['id'] as number}
  `
  const target = Number(run['max_results'])
  const done = Number(progress!['inserted'])
  const startedAt = new Date(run['created_at'] as string).getTime()
  const mins = (Date.now() - startedAt) / 60000
  const rate = done / Math.max(mins, 0.1)

  console.log(`run #${run['id']}  status=${run['status']}`)
  console.log(`  ${done} / ${target}  (${((done / target) * 100).toFixed(1)}%)`)
  console.log(`  elapsed ${mins.toFixed(0)} min · ${rate.toFixed(0)}/min · ETA ${Math.max(0, Math.round((target - done) / Math.max(rate, 1)))} min`)

  const mix = await s`
    select status, count(*)::int as n
      from domain_candidates where run_id = ${run['id'] as number}
     group by status order by n desc
  `
  console.log(`\n  status mix so far:`)
  for (const m of mix) {
    console.log(
      `    ${String(m['status']).padEnd(16)} ${String(m['n']).padStart(5)}  ${((Number(m['n']) / Math.max(done, 1)) * 100).toFixed(1)}%`,
    )
  }

  // The reason the backfill exists: dead sites still sitting in a map pack.
  const [orphans] = await s`
    select count(*)::int as n
      from domain_candidates
     where run_id = ${run['id'] as number}
       and status in ('AVAILABLE','PARKED_DEAD','EXPIRING_SOON','REDEMPTION','PENDING_DELETE','BROKEN')
  `
  console.log(`\n  orphaned-GBP candidates so far: ${orphans!['n']}`)
}

await s.end()
