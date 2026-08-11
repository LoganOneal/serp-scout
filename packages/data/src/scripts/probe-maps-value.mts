/**
 * What the separate $0.002 Maps call adds over the local pack that already
 * arrives free inside the organic SERP we bought anyway.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-maps-value.mts
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const rows = await sql<
  Array<{
    keyword: string
    maps_entry_count: number | null
    maps_domains: string[] | null
    map_present: boolean | null
    local_business_count: number | null
    gbp_leaders: unknown[] | null
  }>
>`
  SELECT keyword, maps_entry_count, maps_domains, map_present, local_business_count, gbp_leaders
    FROM discovery_serp_metrics
   WHERE maps_entry_count IS NOT NULL
   ORDER BY id DESC
   LIMIT 8
`

console.log('keyword                    | MAPS call        | free from the organic SERP')
console.log('                           | entries domains  | pack? local gbp')
for (const r of rows) {
  console.log(
    `${r.keyword.slice(0, 26).padEnd(26)} | ${String(r.maps_entry_count).padStart(7)} ${String(
      r.maps_domains?.length ?? 0,
    ).padStart(7)}  | ${String(r.map_present).padStart(5)} ${String(
      r.local_business_count ?? 0,
    ).padStart(5)} ${String(r.gbp_leaders?.length ?? 0).padStart(3)}`,
  )
}

await sql.end()
