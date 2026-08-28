import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '../db.js'

async function main() {
  const d = db()

  const supplyTub = await d.execute(sql`
    SELECT attributes->>'tub_type' AS tub_type, count(*)::int AS n
    FROM supply_items WHERE gone_at IS NULL
    GROUP BY 1 ORDER BY n DESC`)
  console.log('=== supply tub_type ===')
  console.log(JSON.stringify(supplyTub, null, 2))

  const guests = await d.execute(sql`
    SELECT attributes->>'guests' AS guests, count(*)::int AS n
    FROM supply_items WHERE gone_at IS NULL
    GROUP BY 1 ORDER BY n DESC`)
  console.log('\n=== guests values ===')
  console.log(JSON.stringify(guests, null, 2))

  const guestsByTub = await d.execute(sql`
    SELECT
      attributes->>'tub_type' AS tub_type,
      count(*)::int AS n,
      count(*) FILTER (WHERE attributes ? 'guests')::int AS with_guests,
      round(avg((attributes->>'guests')::numeric) FILTER (WHERE attributes ? 'guests'), 2) AS avg_guests
    FROM supply_items WHERE gone_at IS NULL
    GROUP BY 1 ORDER BY n DESC`)
  console.log('\n=== guests coverage by tub_type ===')
  console.log(JSON.stringify(guestsByTub, null, 2))

  const badges = await d.execute(sql`
    SELECT attributes->>'badge' AS badge, count(*)::int AS n
    FROM supply_items WHERE gone_at IS NULL
    GROUP BY 1 ORDER BY n DESC`)
  console.log('\n=== badges ===')
  console.log(JSON.stringify(badges, null, 2))

  const occupancyAttr = await d.execute(sql`
    SELECT
      count(*) FILTER (WHERE attributes ? 'occupancy')::int AS occupancy,
      count(*) FILTER (WHERE attributes ? 'capacity')::int AS capacity,
      count(*) FILTER (WHERE attributes ? 'tub_capacity')::int AS tub_capacity,
      count(*) FILTER (WHERE attributes ? 'max_occupancy')::int AS max_occupancy,
      count(*) FILTER (WHERE attributes::text ~* 'couple|two.person|2.person')::int AS couple_in_attrs
    FROM supply_items WHERE gone_at IS NULL`)
  console.log('\n=== occupancy-like attributes ===')
  console.log(JSON.stringify(occupancyAttr, null, 2))

  const guestSamples = await d.execute(sql`
    SELECT title, attributes->>'tub_type' AS tub_type, attributes->>'guests' AS guests,
           attributes->>'beds' AS beds, attributes->>'badge' AS badge
    FROM supply_items
    WHERE gone_at IS NULL AND attributes ? 'guests'
    ORDER BY (attributes->>'guests')::int DESC NULLS LAST
    LIMIT 8`)
  console.log('\n=== highest guest samples ===')
  console.log(JSON.stringify(guestSamples, null, 2))

  const guest1 = await d.execute(sql`
    SELECT title, attributes->>'tub_type' AS tub_type, attributes->>'guests' AS guests, attributes->>'beds' AS beds
    FROM supply_items
    WHERE gone_at IS NULL AND attributes->>'guests' = '1'
    LIMIT 8`)
  console.log('\n=== guests=1 samples ===')
  console.log(JSON.stringify(guest1, null, 2))

  const guest2 = await d.execute(sql`
    SELECT title, attributes->>'tub_type' AS tub_type, attributes->>'guests' AS guests, attributes->>'beds' AS beds
    FROM supply_items
    WHERE gone_at IS NULL AND attributes->>'guests' = '2'
    LIMIT 8`)
  console.log('\n=== guests=2 samples ===')
  console.log(JSON.stringify(guest2, null, 2))

  const sources = await d.execute(sql`
    SELECT id, base_url, last_pulled_at, last_manifest
    FROM supply_sources`)
  console.log('\n=== supply sources ===')
  console.log(JSON.stringify(sources, null, 2))

}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
