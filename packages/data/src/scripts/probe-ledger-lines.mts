/**
 * Every ledger line for a run, with its note — shows which consumer paid.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-ledger-lines.mts [runId]
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const arg = Number(process.argv[2])
const [run] = await sql<Array<{ id: number }>>`
  SELECT id FROM discovery_runs
   ${Number.isInteger(arg) && arg > 0 ? sql`WHERE id = ${arg}` : sql`WHERE source = 'catalog'`}
   ORDER BY id DESC LIMIT 1
`
if (!run) {
  console.log('no run found')
  await sql.end()
  process.exit(0)
}

const lines = await sql<Array<{ endpoint: string; note: string | null; usd: string }>>`
  SELECT endpoint, note, (cost_micros / 1000000.0)::numeric(10, 4)::text AS usd
    FROM spend_ledger
   WHERE discovery_run_id = ${run.id}
   ORDER BY id
`
console.log(`run #${run.id} — ${lines.length} ledger lines`)
for (const l of lines) {
  console.log(`${l.usd.padStart(9)}  ${l.endpoint.padEnd(44)}  ${(l.note ?? '').slice(0, 55)}`)
}

/** Jobs record who claimed them only while claimed; finished jobs clear it. */
const jobs = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int AS n FROM discovery_jobs WHERE run_id = ${run.id} GROUP BY status
`
console.log('\njobs:', jobs.map((j) => `${j.n} ${j.status}`).join(', '))

await sql.end()
