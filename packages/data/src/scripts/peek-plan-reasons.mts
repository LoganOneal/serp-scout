/** Print a plan's verdict reasons in full, including resolution provenance. */
import 'dotenv/config'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db.js'
import { adsPlanKeywords } from '../schema.js'

const planId = Number(process.argv[2])
const verdict = process.argv[3]

const rows = await db()
  .select({
    keyword: adsPlanKeywords.keyword,
    verdict: adsPlanKeywords.verdict,
    reason: adsPlanKeywords.verdictReason,
  })
  .from(adsPlanKeywords)
  .where(
    verdict
      ? and(eq(adsPlanKeywords.planId, planId), eq(adsPlanKeywords.verdict, verdict as never))
      : eq(adsPlanKeywords.planId, planId),
  )
  .orderBy(desc(adsPlanKeywords.volume))
  .limit(Number(process.argv[4] ?? 3))

for (const r of rows) console.log(`${r.keyword}\n  ${r.reason}\n`)
await db().$client.end()
