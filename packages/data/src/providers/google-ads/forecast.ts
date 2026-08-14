import 'server-only'
import type { Micros } from '@rnr/core'
import { googleAdsConfigured, type GoogleAdsEnv } from './keyword-volume.js'
import { googleAdsAccessToken, googleAdsApiVersion, googleAdsIds } from './client.js'

/**
 * Ask Google what a campaign would do — free, and better than our cost model.
 *
 * ==================== WHY THIS BEATS DERIVING A CPC ====================
 * `KeywordPlanIdeaService.GenerateKeywordForecastMetrics` returns Google's own
 * predicted impressions, clicks, cost, CTR and average CPC for a proposed
 * campaign at a stated bid, WITHOUT creating a keyword plan first. It runs on
 * the credentials already configured for keyword volume and it costs nothing.
 *
 * It prices the actual auction we would be entering, which nothing derived from
 * a published bid range can do.
 *
 * ==================== AND WHY IT DOES NOT SOLVE THE PROBLEM ==============
 * Google forecasts CLICKS AND COST. It has no idea what a click is worth to us,
 * and — the part that matters — no view on incrementality. Its forecast counts
 * a click cannibalised from our own #1 organic listing identically to a click
 * from someone who would never have found us.
 *
 * So the forecast is the cost side only. The value side comes from the
 * operator's economics, and the discount comes from @rnr/core
 * estimateIncrementality. Treating a Google forecast as a profit forecast is
 * exactly the error docs/plan-paid-search.md §0 is about.
 * ======================================================================
 */

export interface ForecastKeyword {
  text: string
  matchType: 'EXACT' | 'PHRASE' | 'BROAD'
  /** Max CPC bid for this keyword, in micros. */
  maxCpcMicros: Micros
}

export interface ForecastMetrics {
  impressions: number | null
  clicks: number | null
  costMicros: Micros | null
  ctr: number | null
  averageCpcMicros: Micros | null
}

export interface ForecastResult extends ForecastMetrics {
  source: 'google_ads' | 'skipped'
  error: string | null
  keywordCount: number
}

const EMPTY: ForecastMetrics = {
  impressions: null,
  clicks: null,
  costMicros: null,
  ctr: null,
  averageCpcMicros: null,
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function micros(v: unknown): Micros | null {
  const n = num(v)
  return n === null ? null : BigInt(Math.round(n))
}

/**
 * Forecast one proposed campaign.
 *
 * ==================== FAILS LOUD, UNLIKE THE IDEAS PATH ====================
 * `fetchKeywordIdeas` returns `source: 'skipped'` on failure and the caller
 * keeps its template keywords — correct for optional enrichment on a sweep that
 * must not stop.
 *
 * This is not optional enrichment. A null forecast that reads as "this campaign
 * will get no clicks" would kill a plan for a credentials problem. Callers must
 * branch on `source`, never on whether `clicks` is zero.
 * =========================================================================
 */
export async function fetchCampaignForecast(args: {
  keywords: ForecastKeyword[]
  locationCode: number
  languageCode?: string
  /** Days to forecast. Google requires a future range within one year. */
  days?: number
  env?: GoogleAdsEnv
  fetchImpl?: typeof fetch
  /** Today, injected so the request is reproducible in a test. */
  now?: Date
}): Promise<ForecastResult> {
  const env = args.env ?? process.env
  const fetchImpl = args.fetchImpl ?? fetch
  const days = args.days ?? 30

  if (!googleAdsConfigured(env)) {
    return { ...EMPTY, source: 'skipped', error: 'google ads not configured', keywordCount: 0 }
  }
  if (args.keywords.length === 0) {
    return { ...EMPTY, source: 'skipped', error: 'no keywords', keywordCount: 0 }
  }

  try {
    const token = await googleAdsAccessToken(env, fetchImpl)
    const { customerId, loginCustomerId } = googleAdsIds(env)
    const version = googleAdsApiVersion(env)

    /**
     * Start tomorrow, not today. Google rejects a start date that is not in the
     * future, and "today" is ambiguous across the account's timezone and ours.
     */
    const base = args.now ?? new Date()
    const start = new Date(base.getTime() + 86_400_000)
    const end = new Date(start.getTime() + days * 86_400_000)
    const iso = (d: Date): string => d.toISOString().slice(0, 10)

    const res = await fetchImpl(
      `https://googleads.googleapis.com/${version}/customers/${customerId}:generateKeywordForecastMetrics`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']!.trim(),
          'login-customer-id': loginCustomerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currencyCode: 'USD',
          forecastPeriod: { startDate: iso(start), endDate: iso(end) },
          campaign: {
            keywordPlanNetwork: 'GOOGLE_SEARCH',
            geoModifiers: [{ geoTargetConstant: `geoTargetConstants/${args.locationCode}` }],
            languageConstants: [`languageConstants/${args.languageCode === 'en' ? 1000 : 1000}`],
            /**
             * One ad group per call keeps the response attributable. Google
             * forecasts at campaign level, so splitting themes across calls is
             * how a per-theme number is obtained at all.
             */
            adGroups: [
              {
                biddableKeywords: args.keywords.map((k) => ({
                  keyword: { text: k.text, matchType: k.matchType },
                  maxCpcBidMicros: String(k.maxCpcMicros),
                })),
              },
            ],
          },
        }),
      },
    )

    const text = await res.text()
    if (!res.ok) {
      const detail = text.replace(/\s+/g, ' ').slice(0, 300)
      console.error(`[google-ads] forecast FAILED (${res.status}): ${detail}`)
      return {
        ...EMPTY,
        source: 'skipped',
        error: `${res.status}: ${detail}`,
        keywordCount: args.keywords.length,
      }
    }

    const json = JSON.parse(text) as {
      campaignForecastMetrics?: {
        impressions?: number
        clicks?: number
        costMicros?: string | number
        ctr?: number
        averageCpcMicros?: string | number
      }
    }
    const m = json.campaignForecastMetrics

    return {
      impressions: num(m?.impressions),
      clicks: num(m?.clicks),
      costMicros: micros(m?.costMicros),
      ctr: num(m?.ctr),
      averageCpcMicros: micros(m?.averageCpcMicros),
      source: 'google_ads',
      error: null,
      keywordCount: args.keywords.length,
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e)
    console.error(`[google-ads] forecast threw: ${message}`)
    return { ...EMPTY, source: 'skipped', error: message, keywordCount: args.keywords.length }
  }
}
