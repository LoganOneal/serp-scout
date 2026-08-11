/**
 * Does ensureKeywordVolumesFromEnv reach Google Ads (free) rather than
 * DataForSEO ($0.09/request)? Uses cold keywords so the cache cannot mask it,
 * and checks the null-locationCode path the three fixed call sites rely on.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-volume-env-path.mts
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { ensureKeywordVolumesFromEnv } from '../serp/keyword-volume-cache.js'

const database = db()
const keywords = ['gutter guard installation', 'chimney sweep service', 'crawl space encapsulation']

for (const [label, locationCode] of [
  ['null locationCode (national US)', null],
  ['Phoenix, AZ', 1023191],
] as const) {
  const r = await ensureKeywordVolumesFromEnv(database, { keywords, locationCode })
  console.log(
    `${label}: ${r.requests} billable request(s) · ${formatMicrosUsd(r.costMicros, { precision: 2 })}`,
  )
  for (const k of keywords) {
    const v = r.volumes.get(k)
    console.log(
      `   ${k.padEnd(30)} vol ${String(v?.avgMonthlySearches ?? '—').padStart(7)}  src ${v?.source ?? '—'}`,
    )
  }
}
process.exit(0)
