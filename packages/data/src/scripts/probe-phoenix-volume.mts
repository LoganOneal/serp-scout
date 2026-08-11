import 'dotenv/config'
import {
  fetchKeywordVolumes,
  googleAdsGeoIdsForLocation,
} from '../providers/google-ads/keyword-volume.js'

/** Phoenix, AZ — google geotargets / DataForSEO city code used in research_geos. */
const PHOENIX_AZ = 1013462

const keywords = ['hvac repair', 'ac repair', 'hvac repair near me']

const geoIds = googleAdsGeoIdsForLocation({
  locationCode: PHOENIX_AZ,
  locationSource: 'google_geotargets',
})
console.log('Resolved geo criteria for Phoenix:', geoIds)

const city = await fetchKeywordVolumes(keywords, {
  live: true,
  geoTargetCriteriaIds: geoIds,
})
console.log('\n=== CITY-SCOPED (Phoenix criteria) ===')
console.log('source:', city.source)
console.log('geo:', city.geoTargetLabel)
console.log('error:', city.error)
for (const r of city.rows) {
  console.log(`  ${r.keyword.padEnd(24)} ${String(r.avgMonthlySearches ?? '—').padStart(8)}`)
}

const us = await fetchKeywordVolumes(keywords, {
  live: true,
  geoTargetCriteriaIds: [2840],
})
console.log('\n=== US NATIONAL (2840) ===')
console.log('source:', us.source)
console.log('geo:', us.geoTargetLabel)
console.log('error:', us.error)
for (const r of us.rows) {
  console.log(`  ${r.keyword.padEnd(24)} ${String(r.avgMonthlySearches ?? '—').padStart(8)}`)
}

const cityMap = new Map(city.rows.map((r) => [r.keyword, r.avgMonthlySearches]))
const usMap = new Map(us.rows.map((r) => [r.keyword, r.avgMonthlySearches]))
console.log('\n=== DIFF (city should usually be << national) ===')
for (const k of keywords) {
  const c = cityMap.get(k)
  const u = usMap.get(k)
  console.log(
    `  ${k.padEnd(24)} city=${String(c ?? '—').padStart(8)}  us=${String(u ?? '—').padStart(8)}  ` +
      (c != null && u != null && c < u
        ? 'OK city < national'
        : c === u
          ? 'SAME (suspicious if national is large)'
          : 'check'),
  )
}
