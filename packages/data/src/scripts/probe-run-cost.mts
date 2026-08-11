/**
 * What a niches x markets deep dive costs, using the real cost model.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-run-cost.mts [niches] [markets] [kwPerNiche]
 *
 * Prints every endpoint line so the expensive one is never a surprise again.
 */
import { estimateDiscoveryCostMicros, formatMicrosUsd } from '@rnr/core'

/**
 * Keywords bought per niche — now an operator choice in the Screen UI
 * (1 / 3 / 8), not a constant. It multiplies the SERP line directly.
 */
const DEFAULT_KW_PER_NICHE = 8
/** Hard cap in enqueueCatalogBulkResearch — selections above it get truncated. */
const HARD_CAP_JOBS = 5000

const niches = Number(process.argv[2] ?? 50)
const markets = Number(process.argv[3] ?? 50)
const KW_PER_NICHE = Number(process.argv[4] ?? DEFAULT_KW_PER_NICHE)

const usd = (m: bigint) => formatMicrosUsd(m, { precision: 2 })

for (const devices of [1, 2] as const) {
  const keywords = niches * KW_PER_NICHE
  const cells = keywords * markets
  const jobCount = cells * devices

  const cold = estimateDiscoveryCostMicros({
    jobCount,
    volumeRequests: markets, // batched: one request per market
    mapsRequests: niches * markets,
  })
  const warm = estimateDiscoveryCostMicros({
    jobCount,
    volumeRequests: 0, // volume cache hit
    mapsRequests: niches * markets,
  })

  console.log(`\n=== ${niches} niches x ${markets} markets · ${devices === 1 ? 'desktop only' : 'desktop + mobile'} ===`)
  console.log(`keywords     ${keywords}  (${niches} niches x ${KW_PER_NICHE})`)
  console.log(`SERP jobs    ${jobCount.toLocaleString()}`)
  console.log(`  SERP       ${usd(cold.serpMicros).padStart(9)}   ${jobCount.toLocaleString()} x $0.002`)
  console.log(`  volume     ${usd(cold.volumeMicros).padStart(9)}   ${markets} x $0.09 (batched per market)`)
  console.log(`  maps       ${usd(cold.mapsMicros).padStart(9)}   ${(niches * markets).toLocaleString()} x $0.002`)
  console.log(`  TOTAL      ${usd(cold.totalMicros).padStart(9)}   (warm cache: ${usd(warm.totalMicros)})`)
  if (jobCount > HARD_CAP_JOBS) {
    console.log(
      `  ⚠ ${jobCount.toLocaleString()} jobs exceeds the ${HARD_CAP_JOBS.toLocaleString()} hard cap — ` +
        `enqueue truncates the selection to fit.`,
    )
  }
}
