/**
 * Prove the volume fix: many keywords, ONE $0.09 request, then free re-reads.
 *
 * Before batching, N keywords cost N x $0.09. This asks for several at once and
 * prints the request count, then asks again to show the cache serving it for $0.
 *
 *   pnpm exec tsx --conditions=react-server packages/data/src/scripts/probe-volume-batch.mts
 */
import 'dotenv/config'
import { db } from '../db.js'
import { liveCallsEnabled } from '../providers/index.js'
import { ensureKeywordVolumes } from '../serp/keyword-volume-cache.js'
import { formatMicrosUsd, PRICE } from '@rnr/core'

const database = db()
const KEYWORDS = [
  'roofing',
  'roof repair',
  'metal roofing',
  'roof replacement',
  'emergency roof repair',
  'flat roof repair',
]
const LOCATION = 1023191 // New York, New York, United States

console.log(`live calls : ${liveCallsEnabled()}`)
console.log(`keywords   : ${KEYWORDS.length} @ location ${LOCATION}`)
console.log(
  `unbatched  : ${KEYWORDS.length} requests = ${formatMicrosUsd(
    BigInt(KEYWORDS.length) * PRICE.keywordsGoogleAdsSearchVolume,
    { precision: 2 },
  )}`,
)

const first = await ensureKeywordVolumes(database, {
  keywords: KEYWORDS,
  locationCode: LOCATION,
  live: liveCallsEnabled(),
})
console.log(
  `\ncold cache : ${first.requests} request(s), ${first.fetched} keyword(s) fetched, ` +
    `cost ${formatMicrosUsd(first.costMicros, { precision: 2 })}`,
)
for (const kw of KEYWORDS) {
  const v = first.volumes.get(kw)
  console.log(`  ${kw.padEnd(24)} vol=${v?.avgMonthlySearches ?? '—'} src=${v?.source ?? '—'}`)
}

const second = await ensureKeywordVolumes(database, {
  keywords: KEYWORDS,
  locationCode: LOCATION,
  live: liveCallsEnabled(),
})
console.log(
  `\nwarm cache : ${second.requests} request(s), cost ${formatMicrosUsd(second.costMicros, {
    precision: 2,
  })} — ${second.volumes.size} keyword(s) served`,
)

const verdict =
  first.requests === 1 && second.requests === 0
    ? '✓ batched into one request, re-reads are free'
    : `✗ expected 1 then 0 requests, got ${first.requests} then ${second.requests}`
console.log(`\n${verdict}`)
process.exit(0)
