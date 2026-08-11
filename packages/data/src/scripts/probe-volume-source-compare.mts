/**
 * Google Ads (free) vs DataForSEO ($0.09/request) for the SAME keywords and the
 * SAME market, so the two can be compared rather than assumed equivalent.
 *
 * DataForSEO figures come from keyword_volume_cache — already bought, so this
 * script costs nothing on the DFS side. Google Ads Keyword Planner metrics have
 * no per-call charge at all.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-volume-source-compare.mts [locationCode]
 */
import 'dotenv/config'
import postgres from 'postgres'
import { fetchKeywordVolumes } from '../providers/google-ads/keyword-volume.js'

const locationCode = Number(process.argv[2] ?? 1023191) // New York, NY

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const cached = await sql<Array<{ keyword: string; avg_monthly_searches: number | null }>>`
  SELECT keyword, avg_monthly_searches
    FROM keyword_volume_cache
   WHERE location_code = ${locationCode}
   ORDER BY keyword
   LIMIT 12
`
if (cached.length === 0) {
  console.log(`No cached DataForSEO volume for location ${locationCode}. Try another code.`)
  await sql.end()
  process.exit(0)
}

const keywords = cached.map((c) => c.keyword)

// Same market, via Google Ads geo criteria. US city criteria IDs are the same
// ID family DataForSEO uses for US locations, so the code passes straight through.
const local = await fetchKeywordVolumes(keywords, {
  live: true,
  geoTargetCriteriaIds: [locationCode],
})
const national = await fetchKeywordVolumes(keywords, { live: true })

const byKw = new Map(local.rows.map((r) => [r.keyword.toLowerCase(), r]))
const natByKw = new Map(national.rows.map((r) => [r.keyword.toLowerCase(), r]))

console.log(`location ${locationCode} · google ads source: ${local.source}`)
if (local.error) console.log(`google ads error: ${local.error}`)
console.log('')
console.log('keyword                      DFS(paid)   GAds(local)   GAds(national)   delta')
console.log('-'.repeat(84))

let compared = 0
let withinHalf = 0
for (const c of cached) {
  const k = c.keyword.toLowerCase()
  const dfs = c.avg_monthly_searches
  const gLocal = byKw.get(k)?.avgMonthlySearches ?? null
  const gNat = natByKw.get(k)?.avgMonthlySearches ?? null
  let delta = '—'
  if (dfs != null && gLocal != null && dfs > 0) {
    const ratio = gLocal / dfs
    delta = `${ratio.toFixed(2)}x`
    compared += 1
    if (ratio >= 0.5 && ratio <= 2) withinHalf += 1
  }
  console.log(
    `${c.keyword.slice(0, 26).padEnd(26)} ${String(dfs ?? '—').padStart(9)} ${String(
      gLocal ?? '—',
    ).padStart(13)} ${String(gNat ?? '—').padStart(16)} ${delta.padStart(8)}`,
  )
}

console.log('')
console.log(
  compared === 0
    ? 'No overlapping rows to compare.'
    : `${withinHalf}/${compared} within 2x of the paid figure.`,
)

await sql.end()
