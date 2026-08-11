import 'dotenv/config'
import { db } from '../db.js'
import { niches } from '../schema.js'
const rows = await db().select({ slug: niches.slug, stems: niches.domainStems, cat: niches.category,
  ticket: niches.avgTicketMicros, bps: niches.leadCommissionRateBps, lead: niches.leadValueMicros,
  dpc: niches.demandPerCapitaPer1k, vps: niches.valuePerSearchMicros,
  floor: niches.rentFloorMicros, ceil: niches.rentCeilingMicros }).from(niches).limit(4)
for (const r of rows) console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
process.exit(0)
