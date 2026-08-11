/** Queue state at a glance. `pnpm queue` */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { formatMicrosUsd } from '@rnr/core'
import { closeDb, db } from '../db.js'
import { STUCK_RUN_MINUTES } from '../queue.js'

async function main(): Promise<void> {
  const d = db()

  const rows = (await d.execute(sql`
    SELECT r.id, r.status, l.name, l.state_code, l.location_source,
           r.claimed_by, r.claimed_at, r.created_at, r.spend_micros, r.used_fixtures,
           r.error,
           EXTRACT(EPOCH FROM (now() - COALESCE(r.claimed_at, r.created_at)))::int AS age_seconds,
           (SELECT COUNT(*)::int FROM scan_targets st WHERE st.scan_run_id = r.id) AS scored
      FROM scan_runs r
      JOIN localities l ON l.id = r.locality_id
     ORDER BY r.created_at DESC
     LIMIT 15`)) as unknown as Array<Record<string, unknown>>

  if (rows.length === 0) {
    console.log('\nNo scan runs at all.\n')
    await closeDb()
    return
  }

  console.log('\n id  status           locality              scored  spend      age    data')
  for (const r of rows) {
    const age = Number(r['age_seconds'] ?? 0)
    const ageStr = age > 3600 ? `${Math.floor(age / 3600)}h` : age > 60 ? `${Math.floor(age / 60)}m` : `${age}s`
    console.log(
      ` ${String(r['id']).padStart(3)}  ${String(r['status']).padEnd(16)} ` +
        `${`${r['name']}, ${r['state_code']}`.padEnd(21)} ` +
        `${String(r['scored']).padStart(5)}  ` +
        `${formatMicrosUsd(BigInt(String(r['spend_micros'])), { precision: 4 }).padEnd(9)} ` +
        `${ageStr.padStart(5)}  ${r['used_fixtures'] ? 'fixture' : 'live'}`,
    )
    if (r['claimed_by']) console.log(`      claimed by ${r['claimed_by']}`)
    if (r['error']) console.log(`      error: ${String(r['error']).slice(0, 150)}`)
  }

  const pending = rows.filter((r) => r['status'] === 'pending').length
  const inFlight = rows.filter((r) => r['status'] === 'claimed' || r['status'] === 'running').length
  const stuck = rows.filter(
    (r) =>
      (r['status'] === 'claimed' || r['status'] === 'running') &&
      Number(r['age_seconds'] ?? 0) > STUCK_RUN_MINUTES * 60,
  ).length

  console.log(`\n${pending} pending, ${inFlight} in flight, ${stuck} stuck past ${STUCK_RUN_MINUTES}min.`)
  if (pending > 0) {
    console.log(
      '\nPending runs only start when the worker is running -- it is the ONLY consumer\n' +
        'of this table. Start it with:  pnpm worker\n',
    )
  }
  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
