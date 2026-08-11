import 'dotenv/config'

async function main() {
  const env = process.env
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env['GOOGLE_ADS_CLIENT_ID']!.trim(),
      client_secret: env['GOOGLE_ADS_CLIENT_SECRET']!.trim(),
      refresh_token: env['GOOGLE_ADS_REFRESH_TOKEN']!.trim(),
      grant_type: 'refresh_token',
    }),
  })
  const tokenJson = (await tokenRes.json()) as { access_token?: string }
  if (!tokenJson.access_token) throw new Error('oauth failed')

  const customerId = env['GOOGLE_ADS_CUSTOMER_ID']!.replace(/\D/g, '')
  const loginCustomerId = env['GOOGLE_ADS_LOGIN_CUSTOMER_ID']!.replace(/\D/g, '')
  const url = `https://googleads.googleapis.com/v21/customers/${customerId}:generateKeywordHistoricalMetrics`

  // geoTargetConstants/1014221 = Nashville city (TN) — verified earlier with 200
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']!.trim(),
      'login-customer-id': loginCustomerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      keywords: [
        'hvac',
        'hvac near me',
        'hvac repair',
        'hvac nashville',
        'ac repair',
        'furnace repair',
        'air conditioning repair',
      ],
      geoTargetConstants: ['geoTargetConstants/1014221'],
      language: 'languageConstants/1000',
      keywordPlanNetwork: 'GOOGLE_SEARCH',
    }),
  })
  const json = (await res.json()) as {
    results?: Array<{
      text?: string
      keywordMetrics?: {
        avgMonthlySearches?: string
        competitionIndex?: string
        lowTopOfPageBidMicros?: string
        highTopOfPageBidMicros?: string
        competition?: string
      }
    }>
    error?: unknown
  }
  console.log('Nashville city (geo 1014221) — status', res.status)
  console.log('keyword'.padEnd(28), 'volume'.padStart(8), 'comp'.padStart(5), 'low$'.padStart(8), 'high$'.padStart(8))
  console.log('-'.repeat(60))
  for (const r of json.results ?? []) {
    const m = r.keywordMetrics ?? {}
    const low = m.lowTopOfPageBidMicros
      ? `$${(Number(m.lowTopOfPageBidMicros) / 1e6).toFixed(2)}`
      : '—'
    const high = m.highTopOfPageBidMicros
      ? `$${(Number(m.highTopOfPageBidMicros) / 1e6).toFixed(2)}`
      : '—'
    console.log(
      (r.text ?? '').padEnd(28),
      String(m.avgMonthlySearches ?? '—').padStart(8),
      String(m.competitionIndex ?? '—').padStart(5),
      low.padStart(8),
      high.padStart(8),
    )
  }
  if (json.error) console.log(JSON.stringify(json.error, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
