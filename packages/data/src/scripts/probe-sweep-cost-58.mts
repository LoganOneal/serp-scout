/**
 * What does a full-catalog market sweep cost?
 *
 * Uses the app's own estimator so this matches what the funnel will quote.
 * Volume is priced at ZERO because it now comes from Google Ads; the constant
 * still exists for the DataForSEO fallback when a geo will not resolve.
 */
import { estimateDiscoveryCostMicros, formatMicrosUsd, PRICE } from '@rnr/core'

const NICHES = 58
const MARKETS = 50

console.log(`${NICHES} niches x ${MARKETS} markets\n`)
console.log('kw/niche  devices     SERPs      live SERP   + maps on   queued SERP')
console.log('-'.repeat(74))

for (const kw of [1, 3, 8]) {
  for (const devices of [1, 2]) {
    const jobCount = NICHES * MARKETS * kw * devices
    // Maps is one call per (niche, market), not per keyword or device.
    const mapsRequests = NICHES * MARKETS
    const live = estimateDiscoveryCostMicros({ jobCount, volumeRequests: 0 })
    const withMaps = estimateDiscoveryCostMicros({ jobCount, volumeRequests: 0, mapsRequests })
    const queued = BigInt(jobCount) * PRICE.serpOrganicTask
    console.log(
      `${String(kw).padStart(8)}  ${String(devices).padStart(7)}  ${String(jobCount).padStart(8)}  ` +
        `${formatMicrosUsd(live.totalMicros, { precision: 2 }).padStart(11)}  ` +
        `${formatMicrosUsd(withMaps.totalMicros, { precision: 2 }).padStart(11)}  ` +
        `${formatMicrosUsd(queued, { precision: 2 }).padStart(11)}`,
    )
  }
}

console.log('\nper-unit prices actually used:')
console.log(`  organic SERP (live)   ${formatMicrosUsd(PRICE.serpOrganicLive, { precision: 4 })}`)
console.log(`  organic SERP (queued) ${formatMicrosUsd(PRICE.serpOrganicTask, { precision: 4 })}`)
console.log(`  map pack              ${formatMicrosUsd(PRICE.serpMapsLive, { precision: 4 })}`)
console.log(`  keyword volume        $0.0000  (Google Ads; DataForSEO fallback would be ${formatMicrosUsd(PRICE.keywordsGoogleAdsSearchVolume, { precision: 2 })}/request)`)
