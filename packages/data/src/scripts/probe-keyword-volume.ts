/**
 * One-off live probe: Google Ads keyword historical metrics.
 *
 *   pnpm exec tsx --conditions=react-server packages/data/src/scripts/probe-keyword-volume.ts
 *
 * Optional args: keywords as extra CLI args.
 * Optional env: GOOGLE_ADS_GEO_TARGET_CONSTANTS=geoTargetConstants/1014221 (Nashville city example)
 */
import 'dotenv/config'
import {
  fetchKeywordVolumes,
  googleAdsConfigured,
  type GoogleAdsEnv,
} from '../providers/google-ads/keyword-volume.js'

function maskId(raw: string | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (d.length < 4) return '(unset)'
  return `***${d.slice(-4)}`
}

async function main(): Promise<void> {
  const env = process.env as GoogleAdsEnv
  const keywords =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : ['hvac', 'hvac near me', 'hvac nashville', 'nashville hvac', 'hvac repair nashville']

  console.log('--- Google Ads volume probe ---')
  console.log('configured:', googleAdsConfigured(env))
  console.log('LIVE_CALLS_ENABLED:', env['LIVE_CALLS_ENABLED'])
  console.log('customer_id:', maskId(env['GOOGLE_ADS_CUSTOMER_ID']))
  console.log('login_customer_id:', maskId(env['GOOGLE_ADS_LOGIN_CUSTOMER_ID']))
  console.log('keywords:', keywords.join(', '))

  const result = await fetchKeywordVolumes(keywords, { live: true, env })

  console.log('source:', result.source)
  if (result.error) console.log('error:', result.error)
  console.log('')
  console.log(
    'keyword'.padEnd(32),
    'volume'.padStart(10),
    'comp'.padStart(6),
    'low$'.padStart(10),
    'high$'.padStart(10),
  )
  console.log('-'.repeat(70))
  for (const row of result.rows) {
    const vol = row.avgMonthlySearches === null ? '—' : String(row.avgMonthlySearches)
    const comp = row.competitionIndex === null ? '—' : String(row.competitionIndex)
    const low =
      row.lowTopOfPageBidMicros === null
        ? '—'
        : (Number(row.lowTopOfPageBidMicros) / 1_000_000).toFixed(2)
    const high =
      row.highTopOfPageBidMicros === null
        ? '—'
        : (Number(row.highTopOfPageBidMicros) / 1_000_000).toFixed(2)
    console.log(row.keyword.padEnd(32), vol.padStart(10), comp.padStart(6), low.padStart(10), high.padStart(10))
  }

  if (result.source !== 'google_ads') {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
