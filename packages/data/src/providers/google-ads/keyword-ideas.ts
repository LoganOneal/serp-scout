import 'server-only'
import { googleAdsConfigured, type GoogleAdsEnv } from './keyword-volume.js'

/**
 * What people ACTUALLY search for a service in a market.
 *
 * ==================== WHY DISCOVERY, NOT A TEMPLATE ====================
 * Keywords used to be a cross product: {niche} x {intent modifier} x {city}.
 * That invents phrases nobody types. Measured across runs 37+:
 *
 *   primary       128 SERPs   101 with volume   79%
 *   geo_explicit  128 SERPs    40 with volume   31%
 *
 * -- 115 of 256 SERPs bought for queries with no measured demand, and the
 * template could not have known, because it never asked.
 *
 * Asking is free. `:generateKeywordIdeas` takes a seed and a geo target and
 * returns real keywords with their volume for that market. For "bathroom
 * remodeling" in Chicago it returns "bathroom remodel contractors" (1,300),
 * "bathroom remodel near me" (480) and "tub to shower conversion" (90) -- the
 * template said "bathroom remodeling installation", which has no volume at all,
 * and could never have produced "tub to shower conversion" from any rule.
 *
 * Same credentials and same cost as the volume lookup: none.
 * =======================================================================
 */

export interface KeywordIdea {
  keyword: string
  /** Google Ads avg monthly searches for the geo asked about. Null = no figure. */
  avgMonthlySearches: number | null
  competitionIndex: number | null
  lowTopOfPageBidMicros: bigint | null
  highTopOfPageBidMicros: bigint | null
}

export interface KeywordIdeasResult {
  ideas: KeywordIdea[]
  /** 'google_ads' when the API answered; 'skipped' when it could not be asked. */
  source: 'google_ads' | 'skipped'
  error: string | null
  geoTargetCriteriaIds: number[]
}

/**
 * The ideas endpoint caps a response; asking for more than this returns the
 * same page. Volume-ranked, so the tail is the part worth dropping anyway.
 */
export const KEYWORD_IDEAS_PAGE_SIZE = 100

const digitsOnly = (v: string | undefined): string => (v ?? '').replace(/[^0-9]/g, '')

const numOrNull = (v: string | number | undefined): number | null => {
  if (v === undefined || v === null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

const microsOrNull = (v: string | number | undefined): bigint | null => {
  const n = numOrNull(v)
  return n === null ? null : BigInt(n)
}

async function fetchAccessToken(env: GoogleAdsEnv, fetchImpl: typeof fetch): Promise<string> {
  const body = new URLSearchParams({
    client_id: env['GOOGLE_ADS_CLIENT_ID']!.trim(),
    client_secret: env['GOOGLE_ADS_CLIENT_SECRET']!.trim(),
    refresh_token: env['GOOGLE_ADS_REFRESH_TOKEN']!.trim(),
    grant_type: 'refresh_token',
  })
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as { access_token?: string; error_description?: string }
  if (!res.ok || !json.access_token) {
    throw new Error(`Google Ads token exchange failed: ${json.error_description ?? res.status}`)
  }
  return json.access_token
}

/**
 * Keyword ideas for one or more seeds, scoped to a market.
 *
 * Never throws: a failure returns `source: 'skipped'` with the reason, and the
 * caller keeps its template keywords. Discovery going down must degrade the
 * keyword list, not stop a sweep.
 */
export async function fetchKeywordIdeas(
  seeds: string[],
  opts: {
    geoTargetCriteriaIds: number[]
    env?: GoogleAdsEnv
    fetchImpl?: typeof fetch
    pageSize?: number
  },
): Promise<KeywordIdeasResult> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const geoTargetCriteriaIds = opts.geoTargetCriteriaIds.filter((n) => Number.isFinite(n))
  const cleanSeeds = [...new Set(seeds.map((s) => s.trim()).filter(Boolean))].slice(0, 20)

  if (!googleAdsConfigured(env)) {
    return { ideas: [], source: 'skipped', error: 'google ads not configured', geoTargetCriteriaIds }
  }
  if (cleanSeeds.length === 0) {
    return { ideas: [], source: 'skipped', error: 'no seeds', geoTargetCriteriaIds }
  }

  try {
    const accessToken = await fetchAccessToken(env, fetchImpl)
    const customerId = digitsOnly(env['GOOGLE_ADS_CUSTOMER_ID'])
    const loginCustomerId = digitsOnly(env['GOOGLE_ADS_LOGIN_CUSTOMER_ID']) || customerId
    // Ideas needs v22; v21 answers 400 UNSUPPORTED_VERSION. See keyword-volume.ts.
    const apiVersion = env['GOOGLE_ADS_API_VERSION']?.trim() || 'v22'

    const res = await fetchImpl(
      `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}:generateKeywordIdeas`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']!.trim(),
          'login-customer-id': loginCustomerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          keywordSeed: { keywords: cleanSeeds },
          geoTargetConstants: geoTargetCriteriaIds.map((id) => `geoTargetConstants/${id}`),
          language: 'languageConstants/1000',
          keywordPlanNetwork: 'GOOGLE_SEARCH',
          pageSize: opts.pageSize ?? KEYWORD_IDEAS_PAGE_SIZE,
        }),
      },
    )

    const text = await res.text()
    if (!res.ok) {
      // Loud, for the same reason the volume path is: nulls downstream look
      // identical to "this market has no demand".
      const detail = text.replace(/\s+/g, ' ').slice(0, 200)
      console.error(`[google-ads] keyword ideas FAILED (${res.status}): ${detail}`)
      return { ideas: [], source: 'skipped', error: `${res.status}: ${detail}`, geoTargetCriteriaIds }
    }

    const json = JSON.parse(text) as {
      results?: Array<{
        text?: string
        keywordIdeaMetrics?: {
          avgMonthlySearches?: string | number
          competitionIndex?: string | number
          lowTopOfPageBidMicros?: string | number
          highTopOfPageBidMicros?: string | number
        }
      }>
    }

    const ideas: KeywordIdea[] = []
    for (const r of json.results ?? []) {
      const keyword = (r.text ?? '').trim()
      if (!keyword) continue
      const m = r.keywordIdeaMetrics
      ideas.push({
        keyword,
        avgMonthlySearches: numOrNull(m?.avgMonthlySearches),
        competitionIndex: numOrNull(m?.competitionIndex),
        lowTopOfPageBidMicros: microsOrNull(m?.lowTopOfPageBidMicros),
        highTopOfPageBidMicros: microsOrNull(m?.highTopOfPageBidMicros),
      })
    }

    ideas.sort((a, b) => (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1))
    return { ideas, source: 'google_ads', error: null, geoTargetCriteriaIds }
  } catch (e) {
    const message = (e as Error).message ?? String(e)
    console.error(`[google-ads] keyword ideas threw: ${message}`)
    return { ideas: [], source: 'skipped', error: message, geoTargetCriteriaIds }
  }
}
