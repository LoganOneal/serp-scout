/**
 * Reddit reachable audience per niche x market, from the real grid path.
 * Free -- reads what the sweep already measured.
 */
import 'dotenv/config'
import { groupByNicheMarket } from '@rnr/core'
import { db } from '../db.js'
import { listOpportunityGrid } from '../serp/opportunity-screen.js'

const rows = await listOpportunityGrid(db(), { limit: 2000 })
const groups = groupByNicheMarket(rows)
const withReddit = groups.filter((g) => g.redditVisits != null && g.redditVisits > 0)

console.log(`${groups.length} niche x market group(s) · ${withReddit.length} with a reachable Reddit audience\n`)
console.log('redditVol  best#   vol     niche / market')
console.log('-'.repeat(76))
for (const g of withReddit.sort((a, b) => (b.redditVisits ?? 0) - (a.redditVisits ?? 0)).slice(0, 15)) {
  console.log(
    `${String(g.redditVisits).padStart(9)}  ${String(g.redditBestPosition ?? '—').padStart(4)}  ` +
      `${String(g.volume ?? '—').padStart(6)}  ${g.label} — ${g.market}${g.stateAbbr ? ', ' + g.stateAbbr : ''}`,
  )
}
const scifi = groups.filter((g) => /foundation/i.test(g.label))
console.log(`\nfoundation groups (the deactivated bare-stem keyword must NOT appear):`)
for (const g of scifi)
  console.log(`  ${g.label} — ${g.market}: ${g.variationCount} keywords, vol ${g.volume}, redditVol ${g.redditVisits}`)
process.exit(0)
