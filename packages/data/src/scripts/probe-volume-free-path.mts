/**
 * End-to-end check that keyword volume now comes from Google Ads for free.
 *
 * Uses a market with no cached rows so the cold path is genuinely exercised,
 * then repeats to confirm the cache still serves the second call.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-volume-free-path.mts [locationCode]
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { ensureKeywordVolumes } from '../serp/keyword-volume-cache.js'

const locationCode = Number(process.argv[2] ?? 1013962) // Los Angeles
const keywords = ['hvac repair', 'ac repair', 'furnace repair', 'duct cleaning', 'heat pump repair']

const database = db()

const cold = await ensureKeywordVolumes(database, { keywords, locationCode, live: true })
console.log(
  `cold: ${cold.requests} billable request(s) · ${formatMicrosUsd(cold.costMicros, { precision: 2 })} · ` +
    `${cold.fetched} keyword(s) fetched`,
)
for (const k of keywords) {
  const v = cold.volumes.get(k)
  console.log(
    `  ${k.padEnd(20)} vol ${String(v?.avgMonthlySearches ?? '—').padStart(7)} · ` +
      `comp ${String(v?.competitionIndex ?? '—').padStart(3)} ${(v?.competition ?? '').padEnd(6)} · ` +
      `months ${String(v?.monthlySearches.length ?? 0).padStart(2)} · src ${v?.source ?? '—'}`,
  )
}

const warm = await ensureKeywordVolumes(database, { keywords, locationCode, live: true })
console.log(
  `\nwarm: ${warm.requests} request(s) · ${formatMicrosUsd(warm.costMicros, { precision: 2 })} · ` +
    `${warm.volumes.size} keyword(s) served from cache`,
)

process.exit(0)
