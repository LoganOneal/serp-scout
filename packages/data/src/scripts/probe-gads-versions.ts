import 'dotenv/config'

async function main() {
  const env = process.env
  const clientId = env['GOOGLE_ADS_CLIENT_ID']?.trim()
  const clientSecret = env['GOOGLE_ADS_CLIENT_SECRET']?.trim()
  const refreshToken = env['GOOGLE_ADS_REFRESH_TOKEN']?.trim()
  const developerToken = env['GOOGLE_ADS_DEVELOPER_TOKEN']?.trim()
  const customerId = (env['GOOGLE_ADS_CUSTOMER_ID'] ?? '').replace(/\D/g, '')
  const loginCustomerId = (env['GOOGLE_ADS_LOGIN_CUSTOMER_ID'] ?? customerId).replace(/\D/g, '')

  if (!clientId || !clientSecret || !refreshToken || !developerToken || !customerId) {
    console.error('Missing required env vars')
    process.exit(1)
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!tokenJson.access_token) {
    console.error('OAuth FAILED', tokenRes.status, tokenJson)
    process.exit(1)
  }
  console.log('OAuth OK')

  // Nashville-Davidson, TN city (Google Ads geo target constant — common ID)
  // US = 2840. We'll try both US and Nashville for hvac.
  const geos = [
    { name: 'US', id: 'geoTargetConstants/2840' },
    { name: 'Nashville city', id: 'geoTargetConstants/1014221' },
  ]

  const versions = ['v19', 'v20', 'v21', 'v22', 'v23', 'v24']
  for (const v of versions) {
    const url = `https://googleads.googleapis.com/${v}/customers/${customerId}:generateKeywordHistoricalMetrics`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'developer-token': developerToken,
        'login-customer-id': loginCustomerId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        keywords: ['hvac', 'hvac near me', 'hvac nashville'],
        geoTargetConstants: ['geoTargetConstants/2840'],
        language: 'languageConstants/1000',
        keywordPlanNetwork: 'GOOGLE_SEARCH',
      }),
    })
    const text = await res.text()
    console.log(`\n=== ${v} status=${res.status} ===`)
    console.log(text.slice(0, 500))
    if (res.ok) {
      console.log('\n--- full success body ---')
      console.log(text)
      // Nashville-scoped
      for (const g of geos) {
        const res2 = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenJson.access_token}`,
            'developer-token': developerToken,
            'login-customer-id': loginCustomerId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            keywords: ['hvac', 'hvac near me', 'hvac repair'],
            geoTargetConstants: [g.id],
            language: 'languageConstants/1000',
            keywordPlanNetwork: 'GOOGLE_SEARCH',
          }),
        })
        const t2 = await res2.text()
        console.log(`\n>>> geo ${g.name} (${g.id}) status=${res2.status}`)
        console.log(t2.slice(0, 800))
      }
      break
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
