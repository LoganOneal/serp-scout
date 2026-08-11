/**
 * Print the Live SERP links we now generate, from real market coordinates.
 *
 * Compare against a known-good URL from valentin.app: the uule must be the
 * coordinate form (a+...), not the place-name form (w+...), or Google ignores it
 * and shows the operator their own city.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-serp-links.mts [query]
 */
import 'dotenv/config'
import postgres from 'postgres'
import { buildLocalSerpLinks } from '../../../core/src/serp/local-serp-url.js'

const query = process.argv[2] ?? 'ac repair'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const rows = await sql<
  Array<{
    market: string
    state_abbr: string | null
    dataforseo_location_name: string | null
    lat: number | null
    lon: number | null
  }>
>`
  SELECT g.market, g.state_abbr, g.dataforseo_location_name, l.lat, l.lon
    FROM research_geos g
    LEFT JOIN localities l ON l.id = g.locality_id
   WHERE g.active = true
   ORDER BY g.selected_rank
   LIMIT 8
`

let missing = 0
for (const r of rows) {
  const links = buildLocalSerpLinks({
    query,
    city: r.market,
    state: r.state_abbr,
    canonicalName: r.dataforseo_location_name,
    lat: r.lat,
    lon: r.lon,
  })
  const kind = links.uule?.startsWith('a+') ? 'GPS ' : links.uule?.startsWith('w+') ? 'NAME' : 'NONE'
  if (kind !== 'GPS ') missing += 1
  console.log(`${kind} ${r.market}, ${r.state_abbr ?? '??'}  lat=${r.lat ?? '—'} lon=${r.lon ?? '—'}`)
  console.log(`     ${links.desktopUrl}\n`)
}

console.log(
  missing === 0
    ? '✓ every market resolved to a coordinate UULE'
    : `⚠ ${missing}/${rows.length} markets have no coordinates — those fall back to the weaker name UULE`,
)

await sql.end()
