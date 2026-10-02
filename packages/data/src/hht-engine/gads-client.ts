import { classifyGadsFailure } from '@rnr/core'

export class GadsError extends Error {
  readonly kind: 'auth' | 'rate_limit' | 'retry'
  constructor(message: string, kind?: 'auth' | 'rate_limit' | 'retry') {
    super(message)
    this.name = 'GadsError'
    this.kind = kind ?? classifyGadsFailure(message)
  }
}

export interface GadsIdea {
  keyword: string
  avgMonthlySearches: number | null
  volumeLow: number | null
  volumeHigh: number | null
  volumeIsRange: boolean
}

export async function generateIdeas(input: {
  seedType: 'keyword' | 'url' | 'site'
  seed: string
  geoTargetId?: number
  languageId?: number
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}): Promise<GadsIdea[]> {
  const env = input.env ?? process.env
  const fetchImpl = input.fetchImpl ?? fetch
  const clientId = env['GOOGLE_ADS_CLIENT_ID']?.trim()
  const clientSecret = env['GOOGLE_ADS_CLIENT_SECRET']?.trim()
  const refreshToken = env['GOOGLE_ADS_REFRESH_TOKEN']?.trim()
  const developerToken = env['GOOGLE_ADS_DEVELOPER_TOKEN']?.trim()
  const customerId = (env['GOOGLE_ADS_CUSTOMER_ID'] ?? '').replace(/\D/g, '')
  if (!clientId || !clientSecret || !refreshToken || !developerToken || !customerId) {
    throw new GadsError('Google Ads credentials are missing', 'auth')
  }
  const accessToken = await googleAdsAccessToken({ clientId, clientSecret, refreshToken, fetchImpl })
  const version = env['GOOGLE_ADS_API_VERSION']?.trim() || 'v22'
  const login = (env['GOOGLE_ADS_LOGIN_CUSTOMER_ID'] ?? '').replace(/\D/g, '') || customerId
  const seed = input.seedType === 'keyword'
    ? { keywordSeed: { keywords: [input.seed] } }
    : input.seedType === 'url'
      ? { urlSeed: { url: input.seed } }
      : { siteSeed: { site: input.seed } }
  const res = await fetchImpl(`https://googleads.googleapis.com/${version}/customers/${customerId}:generateKeywordIdeas`, {
    method: 'POST',
    headers: {
          Authorization: `Bearer ${accessToken}`,
      'developer-token': developerToken,
      'login-customer-id': login,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...seed,
      geoTargetConstants: [`geoTargetConstants/${input.geoTargetId ?? 2840}`],
      language: `languageConstants/${input.languageId ?? 1000}`,
      keywordPlanNetwork: 'GOOGLE_SEARCH',
      pageSize: 50,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new GadsError(`Google Ads ideas HTTP ${res.status}: ${text.slice(0, 240)}`)
  const json = JSON.parse(text) as {
    results?: Array<{ text?: string; keywordIdeaMetrics?: Record<string, unknown> }>
  }
  return (json.results ?? []).flatMap((row) => {
    const keyword = row.text?.trim()
    if (!keyword) return []
    const metrics = row.keywordIdeaMetrics ?? {}
    const avg = num(metrics['avgMonthlySearches'])
    const range = rangeOf(metrics['avgMonthlySearches'])
    const low = num(metrics['lowAvgMonthlySearches'] ?? metrics['monthlySearchVolumeMin']) ?? range?.low ?? null
    const high = num(metrics['highAvgMonthlySearches'] ?? metrics['monthlySearchVolumeMax']) ?? range?.high ?? null
    const volumeIsRange = low !== null || high !== null
    return [{
      keyword,
      avgMonthlySearches: avg,
      volumeLow: low,
      volumeHigh: high ?? avg,
      volumeIsRange,
    }]
  })
}

export async function pingGoogleAds(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  const clientId = env['GOOGLE_ADS_CLIENT_ID']?.trim()
  const clientSecret = env['GOOGLE_ADS_CLIENT_SECRET']?.trim()
  const refreshToken = env['GOOGLE_ADS_REFRESH_TOKEN']?.trim()
  if (!clientId || !clientSecret || !refreshToken || !env['GOOGLE_ADS_DEVELOPER_TOKEN']?.trim() || !(env['GOOGLE_ADS_CUSTOMER_ID'] ?? '').replace(/\D/g, '')) {
    throw new GadsError('Google Ads credentials are missing', 'auth')
  }
  await googleAdsAccessToken({ clientId, clientSecret, refreshToken, fetchImpl })
}

async function googleAdsAccessToken(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  fetchImpl: typeof fetch
}): Promise<string> {
  const tokenRes = await input.fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string }
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new GadsError(tokenJson.error_description ?? `Google Ads token HTTP ${tokenRes.status}`)
  }
  return tokenJson.access_token
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function rangeOf(value: unknown): { low: number; high: number } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (!match?.[1] || !match[2]) return null
  return { low: Number(match[1]), high: Number(match[2]) }
}
