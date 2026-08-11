/**
 * What Google Ads Keyword Planner returns per keyword, for one market.
 *
 * Used to establish which of DataForSEO's paid volume fields we can get for
 * free from an API we already hold credentials for.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-gads-fields.mts [locationCode] [keyword...]
 */
import 'dotenv/config'
import { fetchKeywordVolumes } from '../providers/google-ads/keyword-volume.js'

const args = process.argv.slice(2)
const locationCode = Number(args[0] ?? 1023191)
const keywords = args.length > 1 ? args.slice(1) : ['roofing', 'emergency roof repair']

const r = await fetchKeywordVolumes(keywords, {
  live: true,
  geoTargetCriteriaIds: [locationCode],
})

console.log(`source: ${r.source}${r.error ? ` · error: ${r.error}` : ''}`)
console.log(`geo   : ${locationCode}\n`)

for (const row of r.rows) {
  console.log(row.keyword)
  console.log(`  avgMonthlySearches   ${row.avgMonthlySearches}`)
  console.log(`  competitionIndex     ${row.competitionIndex}`)
  console.log(`  lowTopOfPageBid      ${row.lowTopOfPageBidMicros}`)
  console.log(`  highTopOfPageBid     ${row.highTopOfPageBidMicros}`)
  console.log(`  monthlySearches      ${row.monthlySearches.length} points`)
  if (row.monthlySearches.length > 0) {
    console.log(`    ${JSON.stringify(row.monthlySearches.slice(0, 3))}`)
  }
}
