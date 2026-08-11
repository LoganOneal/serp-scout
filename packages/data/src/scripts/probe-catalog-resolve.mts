import 'dotenv/config'
import postgres from 'postgres'
import { db } from '../db.js'
import { resolveDiscoveryGeos } from '../serp/resolve-discovery-geos.js'
import { researchGeos } from '../schema.js'
import { eq } from 'drizzle-orm'
import { liveCallsEnabled } from '../providers/index.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const counts = await sql`
  select count(*)::int as n,
         count(dataforseo_location_code)::int as with_code,
         count(locality_id)::int as with_loc
  from research_geos where active
`
console.log('counts', counts)
const geos = await sql`
  select id, market, state_abbr, dataforseo_location_code, locality_id, location_source, resolve_status
  from research_geos where active
  order by selected_rank nulls last
  limit 5
`
console.log('sample geos', geos)
console.log('LIVE_CALLS_ENABLED', process.env['LIVE_CALLS_ENABLED'], 'liveCallsEnabled()', liveCallsEnabled())

if (geos.length > 0) {
  const g = geos[0]!
  const database = db()
  const resolved = await resolveDiscoveryGeos(
    database,
    [
      {
        name: g.market as string,
        state: (g.state_abbr as string) ?? '',
        providerLocationCode: g.dataforseo_location_code as number | null,
        localityId: g.locality_id as number | null,
        locationSource: (g.location_source as string) ?? 'csv_preresolved',
        researchGeoId: g.id as number,
      },
    ],
    { usedFixtures: !liveCallsEnabled() },
  )
  console.log('resolved', JSON.stringify(resolved, null, 2))

  // Also simulate if location_source on locality poisons the gate
  if (g.locality_id) {
    const loc = await sql`
      select id, name, location_source, provider_location_code
      from localities where id = ${g.locality_id as number}
    `
    console.log('linked locality', loc)
  }
}

await sql.end()
process.exit(0)
