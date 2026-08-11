/**
 * Does the UULE canonical name we build from market+state actually match the
 * Google geotarget DataForSEO measured? A mismatch means Google silently drops
 * the uule and geo-locates the operator's "verify" link by their own IP.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-geo-uule.mts
 */
import 'dotenv/config'
import postgres from 'postgres'
import { buildGeotargetCanonicalName, buildLocalSerpLinks } from '../../../core/src/serp/local-serp-url.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const rows = await sql<
  Array<{
    market: string
    state_abbr: string | null
    dataforseo_location_name: string | null
    dataforseo_location_type: string | null
  }>
>`
  SELECT market, state_abbr, dataforseo_location_name, dataforseo_location_type
    FROM research_geos
   WHERE active = true AND dataforseo_location_name IS NOT NULL
   ORDER BY selected_rank
   LIMIT 60
`

let diff = 0
for (const r of rows) {
  const built = buildGeotargetCanonicalName({ city: r.market, state: r.state_abbr })
  const ok = built === r.dataforseo_location_name
  if (!ok) diff += 1
  console.log(
    `${ok ? 'OK  ' : 'DIFF'} built=${JSON.stringify(built)} dfs=${JSON.stringify(r.dataforseo_location_name)} (${r.dataforseo_location_type})`,
  )
}
console.log(`\n${diff}/${rows.length} mismatched — those UULEs are ignored by Google.`)

// Show the before/after link for a mismatched market so it can be clicked.
const broken = rows.find(
  (r) => buildGeotargetCanonicalName({ city: r.market, state: r.state_abbr }) !== r.dataforseo_location_name,
)
if (broken) {
  const query = 'roofing'
  const before = buildLocalSerpLinks({ query, city: broken.market, state: broken.state_abbr })
  const after = buildLocalSerpLinks({
    query,
    city: broken.market,
    state: broken.state_abbr,
    canonicalName: broken.dataforseo_location_name,
  })
  console.log(`\n--- ${broken.market} · "${query}" ---`)
  console.log(`BEFORE (${before.canonicalLocation}):\n  ${before.desktopUrl}`)
  console.log(`AFTER  (${after.canonicalLocation}):\n  ${after.desktopUrl}`)
}

await sql.end()
