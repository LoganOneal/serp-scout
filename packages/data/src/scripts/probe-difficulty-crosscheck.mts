/**
 * Do the sweep-computed difficulty and the scan pipeline's agree?
 *
 * They score the SAME model from DIFFERENT SERP fetches (sweep depth 10 via
 * raw_items; scan depth 100 via fetchOrganicSerp), so exact equality is not
 * expected. A large divergence means the raw_items extraction differs from the
 * scan's normalisation and neither number should be trusted until it is
 * explained.
 */
import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const rows = await sql<Array<any>>`
  SELECT l.name AS locality, n.slug AS niche,
         st.difficulty AS scan_difficulty, st.slots_open AS scan_slots,
         round(avg(m.difficulty)::numeric, 1) AS sweep_difficulty,
         round(avg(m.slots_open)::numeric, 1) AS sweep_slots,
         count(*)::int AS sweep_rows
    FROM scan_targets st
    JOIN localities l ON l.id = st.locality_id
    JOIN niches n ON n.id = st.niche_id
    JOIN discovery_serp_metrics m
      ON m.locality_id = st.locality_id AND m.niche_id = st.niche_id
   WHERE st.difficulty IS NOT NULL AND m.difficulty IS NOT NULL
   GROUP BY 1,2,3,4
   ORDER BY abs(st.difficulty - avg(m.difficulty)) DESC
   LIMIT 20`

if (rows.length === 0) {
  console.log('No locality+niche appears in BOTH scan_targets and discovery_serp_metrics.')
  console.log('Cross-check not possible on current data.')
} else {
  console.log('locality              niche                 scan  sweep  delta  slots(scan/sweep)')
  console.log('-'.repeat(88))
  let worst = 0
  for (const r of rows) {
    const d = Math.abs(Number(r.scan_difficulty) - Number(r.sweep_difficulty))
    worst = Math.max(worst, d)
    console.log(
      `${String(r.locality).slice(0,20).padEnd(21)} ${String(r.niche).slice(0,20).padEnd(21)} ` +
        `${String(r.scan_difficulty).padStart(4)} ${String(r.sweep_difficulty).padStart(6)} ` +
        `${d.toFixed(1).padStart(6)}   ${r.scan_slots}/${r.sweep_slots}`,
    )
  }
  console.log(`\nworst divergence: ${worst.toFixed(1)} points across ${rows.length} cell(s)`)
}
await sql.end()
