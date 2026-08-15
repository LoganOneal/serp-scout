import 'dotenv/config'
import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db.js'
import { researchGeos } from '../schema.js'

const rows = await db()
  .select({ m: researchGeos.market, s: researchGeos.stateAbbr })
  .from(researchGeos)
  .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))

console.log(`${rows.length} active, resolved geos`)
console.log(rows.slice(0, 20).map((r) => `${r.m}/${r.s}`).join(' | '))
await db().$client.end()
