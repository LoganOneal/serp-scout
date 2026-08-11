/**
 * Would the cache have served the SERPs we re-bought?
 *
 * Replays the lookup for every measured cell and reports how many find an
 * earlier payload. Read-only, free.
 */
import 'dotenv/config'
import postgres from 'postgres'
import { db } from '../db.js'
import { findCachedRawSerp } from '../serp/raw-serp-cache.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const cells = await sql<Array<any>>`
  SELECT DISTINCT m.keyword, m.location_code, m.device, j.depth
    FROM discovery_serp_metrics m JOIN discovery_jobs j ON j.id = m.job_id
   LIMIT 200`
await sql.end()

let hits = 0
for (const c of cells) {
  const hit = await findCachedRawSerp(db(), {
    keyword: c.keyword,
    locationCode: c.location_code,
    device: c.device,
    depth: c.depth,
  })
  if (hit) hits += 1
}
console.log(`${cells.length} distinct cell(s) · ${hits} would be served from cache for $0.00`)
console.log(`a re-sweep of these markets today would cost $${((cells.length - hits) * 0.002).toFixed(3)} instead of $${(cells.length * 0.002).toFixed(3)}`)
process.exit(0)
