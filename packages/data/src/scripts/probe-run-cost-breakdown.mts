import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const runs = await sql<Array<any>>`
  SELECT r.id, r.label, r.status, r.use_queued_serp, r.fetch_volume, r.fetch_maps,
         r.devices, r.created_at,
         count(j.id)::int jobs,
         sum(j.cost_micros)::text job_cost
    FROM discovery_runs r LEFT JOIN discovery_jobs j ON j.run_id = r.id
   WHERE r.created_at > now() - interval '24 hours'
   GROUP BY r.id ORDER BY r.id DESC LIMIT 6`
console.log('run  jobs   jobCost   queued vol maps devices   label')
console.log('-'.repeat(86))
for (const r of runs)
  console.log(
    `${String(r.id).padStart(3)} ${String(r.jobs).padStart(5)}  $${(Number(r.job_cost||0)/1e6).toFixed(4).padStart(7)}   ` +
    `${String(r.use_queued_serp).padEnd(6)} ${String(r.fetch_volume).padEnd(5)} ${String(r.fetch_maps).padEnd(4)} ${String(r.devices).padEnd(9)} ${String(r.label ?? '').slice(0,28)}`)

const led = await sql<Array<any>>`
  SELECT discovery_run_id AS run, count(*)::int n, sum(cost_micros)::text total
    FROM spend_ledger WHERE created_at > now() - interval '24 hours' AND discovery_run_id IS NOT NULL
   GROUP BY 1 ORDER BY 1 DESC`
console.log('\nledger by run:')
for (const l of led) console.log(`  run ${String(l.run).padStart(3)}: ${String(l.n).padStart(4)} lines · $${(Number(l.total)/1e6).toFixed(4)}`)

const unattributed = await sql<Array<any>>`
  SELECT endpoint, count(*)::int n, sum(cost_micros)::text total FROM spend_ledger
   WHERE created_at > now() - interval '24 hours' AND discovery_run_id IS NULL
   GROUP BY 1 ORDER BY sum(cost_micros) DESC`
console.log('\nNOT attributed to a sweep run (my domain-search / render work):')
for (const u of unattributed) console.log(`  ${String(u.endpoint).slice(0,44).padEnd(45)} ${String(u.n).padStart(3)}x  $${(Number(u.total)/1e6).toFixed(4)}`)
await sql.end()
