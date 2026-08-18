/**
 * WHY is Google Ads returning 429, and what actually fixes it?
 *
 * ==================== THE ANSWER IS IN error.details, NOT error.message ====
 * `fetchKeywordVolumes` surfaces `error.message`, which for a quota failure is
 * the generic "Resource has been exhausted (e.g. check quota)". That sentence is
 * consistent with three completely different situations:
 *
 *   1. The developer token is on TEST ACCOUNT access, which cannot query a
 *      production account at all. Nothing you wait for will fix it.
 *   2. Basic Access daily operation limit reached. Resets at midnight Pacific.
 *   3. A short-term rate limit. Retry in seconds, with backoff.
 *
 * Google distinguishes them in `error.details[]` — `quotaError`,
 * `errorCode.quotaError`, and a `retryDelay` — which the caller throws away. So
 * this makes ONE request with ONE keyword and prints the whole body.
 *
 * One keyword is one operation, so this costs a single unit of a quota that is
 * already exhausted; it cannot make the situation worse.
 * =========================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-google-ads-quota.mts
 */
import 'dotenv/config'

const env = process.env
const digitsOnly = (v: string | undefined): string => (v ?? '').replace(/[^0-9]/g, '')

const developerToken = env['GOOGLE_ADS_DEVELOPER_TOKEN']?.trim()
const customerId = digitsOnly(env['GOOGLE_ADS_CUSTOMER_ID'])
const loginCustomerId = digitsOnly(env['GOOGLE_ADS_LOGIN_CUSTOMER_ID']) || customerId
const apiVersion = env['GOOGLE_ADS_API_VERSION']?.trim() || 'v18'
const clientId = env['GOOGLE_ADS_CLIENT_ID']?.trim()
const clientSecret = env['GOOGLE_ADS_CLIENT_SECRET']?.trim()
const refreshToken = env['GOOGLE_ADS_REFRESH_TOKEN']?.trim()

for (const [k, v] of Object.entries({
  GOOGLE_ADS_DEVELOPER_TOKEN: developerToken,
  GOOGLE_ADS_CUSTOMER_ID: customerId,
  GOOGLE_ADS_CLIENT_ID: clientId,
  GOOGLE_ADS_CLIENT_SECRET: clientSecret,
  GOOGLE_ADS_REFRESH_TOKEN: refreshToken,
})) {
  if (!v) {
    console.error(`${k} is not set.`)
    process.exit(1)
  }
}

console.log(`customer      : ${customerId}`)
console.log(`login-customer: ${loginCustomerId}${loginCustomerId !== customerId ? ' (manager)' : ''}`)
console.log(`api version   : ${apiVersion}\n`)

// --- Token ------------------------------------------------------------------
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId!,
    client_secret: clientSecret!,
    refresh_token: refreshToken!,
    grant_type: 'refresh_token',
  }),
})
const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string }
if (!tokenJson.access_token) {
  console.error(`OAuth refresh FAILED: ${tokenJson.error_description ?? tokenRes.status}`)
  console.error('That is an auth problem, not a quota problem — re-mint the refresh token.')
  process.exit(1)
}
console.log('OAuth refresh : ok\n')

const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}:generateKeywordHistoricalMetrics`

// --- Bisect the batch size --------------------------------------------------
/**
 * One keyword succeeding while a batch 429s is the signature of a REMAINING
 * daily budget, not a broken token: the account has quota left, just not enough
 * for a 100-keyword request. Bisecting says how much is left, which is the
 * difference between "wait until midnight Pacific" and "lower the chunk size".
 */
const sizes = [1, 5, 20, 50, 100]
const word = (i: number): string => `hot tub hotel test ${i}`

for (const size of sizes) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      'developer-token': developerToken!,
      'login-customer-id': loginCustomerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      keywords: Array.from({ length: size }, (_, i) => (size === 1 ? 'hotels with hot tubs' : word(i))),
      geoTargetConstants: ['geoTargetConstants/2840'],
      language: 'languageConstants/1000',
      keywordPlanNetwork: 'GOOGLE_SEARCH',
    }),
  })
  const body = await r.text()
  let detail = ''
  try {
    const j = JSON.parse(body) as { error?: { details?: unknown[] } }
    const b = JSON.stringify(j.error?.details ?? []).toLowerCase()
    if (b.includes('resource_temporarily_exhausted')) detail = ' (short-term rate limit)'
    else if (b.includes('resource_exhausted')) detail = ' (daily budget)'
  } catch {
    /* body already logged below when it matters */
  }
  console.log(`  ${String(size).padStart(4)} keyword(s) -> HTTP ${r.status}${detail}`)
  if (!r.ok && size === sizes[0]) {
    console.log(`
  ${body.slice(0, 400)}`)
  }
  await new Promise((res2) => setTimeout(res2, 1200))
}
console.log('')

// --- One keyword, one operation --------------------------------------------
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokenJson.access_token}`,
    'developer-token': developerToken!,
    'login-customer-id': loginCustomerId,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    keywords: ['hotels with hot tubs'],
    geoTargetConstants: ['geoTargetConstants/2840'],
    language: 'languageConstants/1000',
    keywordPlanNetwork: 'GOOGLE_SEARCH',
  }),
})

const text = await res.text()
console.log(`HTTP ${res.status}\n`)

let json: Record<string, unknown>
try {
  json = JSON.parse(text) as Record<string, unknown>
} catch {
  console.log(text.slice(0, 800))
  process.exit(1)
}

if (res.ok) {
  const results = (json['results'] as unknown[]) ?? []
  console.log(`SUCCESS — ${results.length} result(s). The quota has recovered; re-run \`volume --live\`.`)
  process.exit(0)
}

// --- The part the caller throws away ----------------------------------------
const error = (json['error'] ?? {}) as {
  message?: string
  status?: string
  details?: Array<Record<string, unknown>>
}

console.log(`status  : ${error.status ?? '(none)'}`)
console.log(`message : ${error.message ?? '(none)'}\n`)
console.log('--- error.details -----------------------------------------------')
console.log(JSON.stringify(error.details ?? [], null, 2).slice(0, 2500))
console.log('-----------------------------------------------------------------\n')

/**
 * Turn the detail into the one instruction that actually applies. Each branch is
 * a different fix and only one of them is "wait".
 */
const blob = JSON.stringify(error.details ?? []).toLowerCase()
const msg = (error.message ?? '').toLowerCase()

if (blob.includes('developer_token_not_approved') || blob.includes('test account')) {
  console.log(
    'DIAGNOSIS: the developer token is on TEST ACCOUNT access and cannot query a production\n' +
      'account. Waiting changes nothing. Apply for Basic Access in the Google Ads UI under\n' +
      'Tools > API Center; approval is usually a day or two.',
  )
} else if (blob.includes('resource_temporarily_exhausted') || blob.includes('retrydelay')) {
  const m = /"retrydelay":\s*{[^}]*"seconds":\s*"?(\d+)/i.exec(blob)
  console.log(
    'DIAGNOSIS: a SHORT-TERM rate limit, not the daily cap.\n' +
      (m ? `Google asks for a ${m[1]}s delay. ` : '') +
      'Re-run shortly; if it recurs, the volume pass needs backoff between chunks.',
  )
} else if (blob.includes('resource_exhausted') || msg.includes('quota')) {
  console.log(
    'DIAGNOSIS: the DAILY operation limit for this access level is spent.\n' +
      'Basic Access allows 15,000 operations/day and resets at midnight America/Los_Angeles.\n' +
      'One keyword is one operation, so a 975-keyword pass is 975 of them.\n' +
      'Either wait for the reset, or apply for Standard Access in Tools > API Center.',
  )
} else {
  console.log('DIAGNOSIS: not a quota error. Read error.details above.')
}
