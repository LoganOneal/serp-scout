/**
 * Google Ads Keyword Historical Metrics — search volume for discovery/promote.
 *
 * Volume comes from Google Ads (Keyword Planner metrics), NOT DataForSEO.
 * Pass geoTargetCriteriaIds for city/metro scoping (Google Ads criteria IDs,
 * same family as google geotargets). Default is United States national (2840).
 *
 * Required env (never hard-code secrets in source):
 *   GOOGLE_ADS_DEVELOPER_TOKEN
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (MCC, digits only — e.g. 4841517599)
 *   GOOGLE_ADS_CUSTOMER_ID        (client, digits only — e.g. 3308824376)
 *   GOOGLE_ADS_CLIENT_ID
 *   GOOGLE_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_REFRESH_TOKEN
 *
 * When OAuth is missing or LIVE_CALLS_ENABLED is not true, returns empty volumes
 * (nulls) so promote still works offline.
 */

import type { Micros } from '@rnr/core'

/** United States — Keyword Planner national default. */
export const GOOGLE_ADS_GEO_US = 2840

/**
 * Prefer city/metro Google Ads criteria when the locality code is from google
 * geotargets (same ID family). Otherwise fall back to US national.
 */
export function googleAdsGeoIdsForLocation(args: {
  locationCode: number | null | undefined
  locationSource: string | null | undefined
}): number[] {
  const code = args.locationCode
  if (code == null || !Number.isFinite(code) || code <= 0) return [GOOGLE_ADS_GEO_US]
  const src = (args.locationSource ?? '').toLowerCase()
  // google_geotargets / csv_preresolved criteria IDs map to Keyword Planner geos.
  // dataforseo US city codes often match the same table — try them too.
  if (
    src === 'google_geotargets' ||
    src === 'csv_preresolved' ||
    src === 'dataforseo' ||
    src === ''
  ) {
    if (code === GOOGLE_ADS_GEO_US) return [GOOGLE_ADS_GEO_US]
    return [code]
  }
  return [GOOGLE_ADS_GEO_US]
}

export interface KeywordVolumeRow {
  keyword: string
  /** Avg monthly searches. Null = API had no data or call skipped. */
  avgMonthlySearches: number | null
  /** Competition index 0–100 when present. */
  competitionIndex: number | null
  /** Low top-of-page bid in micros (USD). */
  lowTopOfPageBidMicros: Micros | null
  highTopOfPageBidMicros: Micros | null
  /**
   * Last ~12 months, newest last. Google returns MONTH names (`JANUARY`), not
   * numbers -- DataForSEO resells this same series already numbered, which is
   * the only reason its shape differs.
   */
  monthlySearches: Array<{ year: number; month: number; searchVolume: number }>
}

/** Google Ads month enum -> 1-12. */
const MONTH_INDEX: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
}

function mapMonthlyVolumes(
  raw: Array<{ year?: string | number; month?: string; monthlySearches?: string | number }> | undefined,
): Array<{ year: number; month: number; searchVolume: number }> {
  const out: Array<{ year: number; month: number; searchVolume: number }> = []
  for (const row of raw ?? []) {
    const year = Number(row?.year)
    const month = MONTH_INDEX[String(row?.month ?? '').toUpperCase()]
    const searchVolume = Number(row?.monthlySearches)
    if (!Number.isFinite(year) || month === undefined || !Number.isFinite(searchVolume)) continue
    out.push({ year, month, searchVolume })
  }
  return out
}

export interface KeywordVolumeResult {
  rows: KeywordVolumeRow[]
  source: 'google_ads' | 'fixture' | 'skipped'
  error: string | null
  /** Criteria IDs sent to the API (e.g. [1023191] NYC or [2840] US). */
  geoTargetCriteriaIds: number[]
  /** Human label for UI, e.g. geoTargetConstants/1023191 */
  geoTargetLabel: string
}

export type GoogleAdsEnv = Record<string, string | undefined>

function digitsOnly(raw: string | undefined): string {
  return (raw ?? '').replace(/\D/g, '')
}

export function googleAdsConfigured(env: GoogleAdsEnv = process.env): boolean {
  return Boolean(
    env['GOOGLE_ADS_DEVELOPER_TOKEN']?.trim() &&
      digitsOnly(env['GOOGLE_ADS_CUSTOMER_ID']) &&
      env['GOOGLE_ADS_CLIENT_ID']?.trim() &&
      env['GOOGLE_ADS_CLIENT_SECRET']?.trim() &&
      env['GOOGLE_ADS_REFRESH_TOKEN']?.trim(),
  )
}

async function fetchAccessToken(
  env: GoogleAdsEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  const clientId = env['GOOGLE_ADS_CLIENT_ID']!.trim()
  const clientSecret = env['GOOGLE_ADS_CLIENT_SECRET']!.trim()
  const refreshToken = env['GOOGLE_ADS_REFRESH_TOKEN']!.trim()

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Google OAuth token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ''}`,
    )
  }
  return json.access_token
}

function normalizeGeoIds(ids: number[] | undefined): number[] {
  if (!ids?.length) return [GOOGLE_ADS_GEO_US]
  const cleaned = [
    ...new Set(
      ids
        .map((n) => Math.trunc(n))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ]
  return cleaned.length > 0 ? cleaned : [GOOGLE_ADS_GEO_US]
}

function geoLabel(ids: number[]): string {
  if (ids.length === 1 && ids[0] === GOOGLE_ADS_GEO_US) {
    return 'geoTargetConstants/2840 (US national)'
  }
  return ids.map((id) => `geoTargetConstants/${id}`).join(', ')
}

function emptyRows(keywords: string[]): KeywordVolumeRow[] {
  return keywords.map((keyword) => ({
    keyword,
    avgMonthlySearches: null,
    competitionIndex: null,
    lowTopOfPageBidMicros: null,
    highTopOfPageBidMicros: null,
    monthlySearches: [],
  }))
}

/**
 * Fetch avg monthly search volume for exact keyword strings (Google Search).
 *
 * Batches of up to 10_000 keywords are allowed by the API; we chunk at 100.
 * Optional geoTargetCriteriaIds scopes Keyword Planner (city/metro/state);
 * default is US national (2840). Criteria IDs match Google geotargets.
 */
export async function fetchKeywordVolumes(
  keywords: string[],
  opts: {
    env?: GoogleAdsEnv
    /** Force live even when LIVE_CALLS_ENABLED is unset — default respects the flag. */
    live?: boolean
    fetchImpl?: typeof fetch
    /**
     * Google Ads geo criteria IDs (e.g. New York city 1023191).
     * Empty/omitted → United States national (2840).
     */
    geoTargetCriteriaIds?: number[]
  } = {},
): Promise<KeywordVolumeResult> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const unique = [...new Set(keywords.map((k) => k.trim()).filter((k) => k !== ''))]
  const geoTargetCriteriaIds = normalizeGeoIds(opts.geoTargetCriteriaIds)
  const geoTargetLabel = geoLabel(geoTargetCriteriaIds)

  if (unique.length === 0) {
    return {
      rows: [],
      source: 'skipped',
      error: null,
      geoTargetCriteriaIds,
      geoTargetLabel,
    }
  }

  const live =
    opts.live === true ||
    (opts.live !== false && env['LIVE_CALLS_ENABLED'] === 'true')

  if (!live) {
    // Deterministic offline stub: null volumes (not zeros — null means unmeasured).
    return {
      rows: emptyRows(unique),
      source: 'fixture',
      error: null,
      geoTargetCriteriaIds,
      geoTargetLabel,
    }
  }

  if (!googleAdsConfigured(env)) {
    return {
      rows: emptyRows(unique),
      source: 'skipped',
      error:
        'Google Ads volume skipped: set GOOGLE_ADS_DEVELOPER_TOKEN, CUSTOMER_ID, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN.',
      geoTargetCriteriaIds,
      geoTargetLabel,
    }
  }

  try {
    const accessToken = await fetchAccessToken(env, fetchImpl)
    const customerId = digitsOnly(env['GOOGLE_ADS_CUSTOMER_ID'])
    const loginCustomerId = digitsOnly(env['GOOGLE_ADS_LOGIN_CUSTOMER_ID']) || customerId
    const developerToken = env['GOOGLE_ADS_DEVELOPER_TOKEN']!.trim()
    /**
     * ==================== VERSIONS SUNSET, AND THE FAILURE IS SILENT ====================
     * Google Ads retires API versions on a schedule, and a retired one answers
     * 400 UNSUPPORTED_VERSION -- which this module used to turn into "no volume
     * for this keyword" without a word in the logs.
     *
     * v21 was pinned here and in Vercel, and it went dead: measured 2026-08-11,
     * v21 returns 400 for generateKeywordHistoricalMetrics while v22 returns
     * 4400 for the same keyword. Every fresh lookup was quietly becoming null,
     * which then made the Reddit-visits estimate null, which made a run holding
     * real Reddit threads render an empty column.
     *
     * So the default moves forward with the API, and a failure is logged rather
     * than absorbed. See the error path at the bottom of this function.
     * ====================================================================================
     */
    const apiVersion = env['GOOGLE_ADS_API_VERSION']?.trim() || 'v22'

    const byKeyword = new Map<string, KeywordVolumeRow>()
    const geoTargetConstants = geoTargetCriteriaIds.map((id) => `geoTargetConstants/${id}`)

    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100)
      const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}:generateKeywordHistoricalMetrics`
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'login-customer-id': loginCustomerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          keywords: chunk,
          geoTargetConstants,
          language: 'languageConstants/1000',
          keywordPlanNetwork: 'GOOGLE_SEARCH',
        }),
      })

      const text = await res.text()
      let json: {
        results?: Array<{
          text?: string
          keywordMetrics?: {
            avgMonthlySearches?: string | number
            competitionIndex?: string | number
            lowTopOfPageBidMicros?: string | number
            highTopOfPageBidMicros?: string | number
            /** 12-month series; same field DataForSEO resells as monthly_searches. */
            monthlySearchVolumes?: Array<{
              year?: string | number
              month?: string
              monthlySearches?: string | number
            }>
          }
          closeVariants?: string[]
        }>
        error?: { message?: string; status?: string }
      }
      try {
        json = JSON.parse(text) as typeof json
      } catch {
        throw new Error(`Google Ads non-JSON response (${res.status}): ${text.slice(0, 200)}`)
      }

      if (!res.ok) {
        throw new Error(
          `Google Ads keyword metrics failed (${res.status}): ${json.error?.message ?? text.slice(0, 200)}`,
        )
      }

      for (const r of json.results ?? []) {
        const keyword = (r.text ?? '').trim()
        if (!keyword) continue
        const m = r.keywordMetrics
        byKeyword.set(keyword.toLowerCase(), {
          keyword,
          avgMonthlySearches: numOrNull(m?.avgMonthlySearches),
          competitionIndex: numOrNull(m?.competitionIndex),
          lowTopOfPageBidMicros: microsOrNull(m?.lowTopOfPageBidMicros),
          highTopOfPageBidMicros: microsOrNull(m?.highTopOfPageBidMicros),
          monthlySearches: mapMonthlyVolumes(m?.monthlySearchVolumes),
        })
      }
    }

    const rows: KeywordVolumeRow[] = unique.map((keyword) => {
      const hit = byKeyword.get(keyword.toLowerCase())
      return (
        hit ?? {
          keyword,
          avgMonthlySearches: null,
          competitionIndex: null,
          lowTopOfPageBidMicros: null,
          highTopOfPageBidMicros: null,
          monthlySearches: [],
        }
      )
    })

    return {
      rows,
      source: 'google_ads',
      error: null,
      geoTargetCriteriaIds,
      geoTargetLabel,
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e)
    /**
     * LOUD. A caller cannot tell "Google Ads has no figure for this keyword"
     * from "the call failed" by looking at the rows -- both are nulls -- so the
     * only place that distinction can survive is here. A dead API version went
     * unnoticed for as long as it did because this returned quietly.
     */
    console.error(`[google-ads] keyword volume request FAILED: ${message}`)
    return {
      rows: emptyRows(unique),
      source: 'skipped',
      error: message,
      geoTargetCriteriaIds,
      geoTargetLabel,
    }
  }
}

function numOrNull(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

function microsOrNull(v: string | number | undefined): Micros | null {
  const n = numOrNull(v)
  return n === null ? null : BigInt(n)
}
