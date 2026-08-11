/**
 * With the paid fallback removed, what happens to a geo Google Ads cannot
 * resolve? It must return NULLS at $0.00 -- never a $0.09 charge, never a zero
 * that reads as "no demand".
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { ensureKeywordVolumes } from '../serp/keyword-volume-cache.js'

const database = db()
const keywords = ['gutter guard installation', 'chimney sweep service']

for (const [label, locationCode] of [
  ['Phoenix (resolvable)', 1023191],
  ['nonsense geo code', 999999999],
] as const) {
  const r = await ensureKeywordVolumes(database, { keywords, locationCode, live: true })
  console.log(
    `${label}: ${r.requests} billable request(s) · ${formatMicrosUsd(r.costMicros, { precision: 4 })}`,
  )
  for (const k of keywords) {
    const v = r.volumes.get(k)
    console.log(`   ${k.padEnd(28)} vol ${String(v?.avgMonthlySearches ?? 'null').padStart(6)}  src ${v?.source ?? '—'}`)
  }
}
process.exit(0)
