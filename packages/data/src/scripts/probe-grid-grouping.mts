/**
 * Does the sweep grid actually collapse keyword variations into one
 * niche x market row, and do the aggregates add up?
 *
 * Reads real rows, groups them, and prints the groups that have more than one
 * variation alongside the arithmetic, so the sum/best/max rules can be checked
 * against the numbers they came from.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-grid-grouping.mts [runId]
 */
import 'dotenv/config'
import { groupByNicheMarket } from '@rnr/core'
import { db } from '../db.js'
import { listOpportunityGrid } from '../serp/opportunity-screen.js'

const runId = process.argv[2] ? Number(process.argv[2]) : undefined

const rows = await listOpportunityGrid(db(), {
  limit: 2000,
  ...(runId === undefined ? {} : { runId }),
})
const groups = groupByNicheMarket(rows)

console.log(
  `${rows.length} raw row(s) -> ${groups.length} niche x market group(s)` +
    (runId === undefined ? ' (all runs, desktop)' : ` (run #${runId})`),
)

const multi = groups.filter((g) => g.variationCount > 1)
console.log(`${multi.length} group(s) collapsed more than one variation\n`)

for (const g of multi.slice(0, 8)) {
  const market = `${g.market}${g.stateAbbr ? `, ${g.stateAbbr}` : ''}`
  console.log(`${g.label} — ${market} [${g.devices.join('+')}]`)
  console.log(
    `  HEAD  vol ${String(g.volume ?? '—').padStart(7)}${g.volumeComplete ? ' ' : '*'}` +
      `  1st org ${String(g.firstOrganicRankAbsolute ?? '—').padStart(4)}` +
      `  score ${String(g.opportunityScore ?? '—').padStart(4)}` +
      `  (${g.variationCount} keywords x ${g.devices.length} device(s) = ${g.variations.length} rows)`,
  )
  for (const v of g.variations) {
    console.log(
      `        ${`${v.keyword} [${v.device ?? '?'}]`.slice(0, 44).padEnd(46)}` +
        `vol ${String(v.volume ?? '—').padStart(7)} ` +
        ` org ${String(v.firstOrganicRankAbsolute ?? '—').padStart(4)}` +
        `  score ${String(v.opportunityScore ?? '—').padStart(4)}` +
        (v.variant === 'primary' ? '  <- primary' : ''),
    )
  }

  // Re-derive the aggregates independently of the implementation.
  const byKw = new Map<string, number | null>()
  for (const v of g.variations) {
    const k = v.keyword.trim().toLowerCase()
    if (byKw.get(k) == null) byKw.set(k, v.volume ?? null)
  }
  const vols = [...byKw.values()].filter((v): v is number => v != null)
  const expectedVol = vols.length === 0 ? null : vols.reduce((a, b) => a + b, 0)
  const orgs = g.variations
    .map((v) => v.firstOrganicRankAbsolute)
    .filter((v): v is number => v != null)
  const expectedOrg = orgs.length === 0 ? null : Math.min(...orgs)
  const ok = g.volume === expectedVol && g.firstOrganicRankAbsolute === expectedOrg
  console.log(
    `  check sum=${expectedVol ?? '—'} best=${expectedOrg ?? '—'} -> ${ok ? 'OK' : 'MISMATCH'}\n`,
  )
}

if (multi.length === 0) {
  console.log('No group had more than one variation — every niche was measured on a single query.')
}
console.log('* = at least one variation had no measured volume')
process.exit(0)
