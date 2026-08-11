/**
 * Local search volume via DataForSEO Keywords Data → Google Ads Search Volume.
 *
 * Why this instead of our direct Google Ads Keyword Planner client:
 *  - Same vendor + credentials as organic/map-pack SERPs
 *  - Accepts the same `location_code` family we use for local SERP / map pack
 *    (city criteria, e.g. Phoenix 1013462 → city-scoped volume, not US 165k)
 *  - Avoids a second OAuth stack that was returning wrong / empty city metrics
 *
 * Endpoint: POST /v3/keywords_data/google_ads/search_volume/live
 * Docs: location_code optional; omit → worldwide. We always pass a code.
 *
 * Note: Map pack SERP (`/serp/google/maps`) does **not** return search volume —
 * only local business listings. Volume always comes from Keywords Data (Ads).
 */

import type { Micros } from '@rnr/core'
import { DataForSeoClient } from './client.js'
import { ENDPOINTS } from './endpoints.js'
import { DfsTaskError } from './errors.js'

/** United States — Keywords Data / Google Ads national. */
export const DFS_VOLUME_LOCATION_US = 2840

export type MonthlySearchPoint = { year: number; month: number; searchVolume: number }

export interface DfsKeywordVolumeRow {
  keyword: string
  avgMonthlySearches: number | null
  competitionIndex: number | null
  competition: string | null
  /** CPC in micros USD when present. */
  cpcMicros: Micros | null
  lowTopOfPageBidMicros: Micros | null
  highTopOfPageBidMicros: Micros | null
  /** Last ~12 months when API returns them (seasonality). */
  monthlySearches: MonthlySearchPoint[]
}

export interface DfsKeywordVolumeResult {
  rows: DfsKeywordVolumeRow[]
  source: 'dataforseo_google_ads' | 'fixture' | 'skipped'
  error: string | null
  /** Location code actually used for the successful call. */
  locationCode: number
  /** Label stored on metrics for UI audit. */
  volumeGeoTarget: string
}

interface DfsSearchVolumeRaw {
  keyword?: string
  search_volume?: number | null
  competition?: string | null
  competition_index?: number | null
  cpc?: number | null
  low_top_of_page_bid?: number | null
  high_top_of_page_bid?: number | null
  location_code?: number | null
  monthly_searches?: Array<{
    year?: number
    month?: number
    search_volume?: number | null
  }> | null
}

function usdToMicros(n: number | null | undefined): Micros | null {
  if (n == null || !Number.isFinite(n)) return null
  return BigInt(Math.round(n * 1_000_000))
}

function emptyRows(keywords: string[]): DfsKeywordVolumeRow[] {
  return keywords.map((keyword) => ({
    keyword,
    avgMonthlySearches: null,
    competitionIndex: null,
    competition: null,
    cpcMicros: null,
    lowTopOfPageBidMicros: null,
    highTopOfPageBidMicros: null,
    monthlySearches: [],
  }))
}

function mapMonthly(
  raw: DfsSearchVolumeRaw['monthly_searches'],
): MonthlySearchPoint[] {
  if (!Array.isArray(raw)) return []
  const out: MonthlySearchPoint[] = []
  for (const row of raw) {
    const year = row?.year
    const month = row?.month
    const sv = row?.search_volume
    if (
      year == null ||
      month == null ||
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      sv == null ||
      !Number.isFinite(sv)
    ) {
      continue
    }
    out.push({
      year: Math.trunc(year),
      month: Math.trunc(month),
      searchVolume: Math.max(0, Math.trunc(sv)),
    })
  }
  return out
}

function mapRows(raw: DfsSearchVolumeRaw[] | undefined, keywords: string[]): DfsKeywordVolumeRow[] {
  const byKw = new Map<string, DfsSearchVolumeRaw>()
  for (const r of raw ?? []) {
    const k = (r.keyword ?? '').trim().toLowerCase()
    if (k) byKw.set(k, r)
  }
  return keywords.map((keyword) => {
    const r = byKw.get(keyword.toLowerCase())
    if (!r) {
      return {
        keyword,
        avgMonthlySearches: null,
        competitionIndex: null,
        competition: null,
        cpcMicros: null,
        lowTopOfPageBidMicros: null,
        highTopOfPageBidMicros: null,
        monthlySearches: [],
      }
    }
    const vol = r.search_volume
    return {
      keyword,
      avgMonthlySearches:
        vol == null || !Number.isFinite(vol) ? null : Math.max(0, Math.trunc(vol)),
      competitionIndex:
        r.competition_index == null || !Number.isFinite(r.competition_index)
          ? null
          : Math.trunc(r.competition_index),
      competition: r.competition ?? null,
      cpcMicros: usdToMicros(r.cpc),
      lowTopOfPageBidMicros: usdToMicros(r.low_top_of_page_bid),
      highTopOfPageBidMicros: usdToMicros(r.high_top_of_page_bid),
      monthlySearches: mapMonthly(r.monthly_searches),
    }
  })
}

/**
 * Fetch avg monthly searches for exact keywords, scoped to a DFS location_code
 * (same code used for local organic / maps SERP when available).
 *
 * On invalid city location_code (40501), retries once with US national (2840).
 */
/** Build a DataForSeoClient from env (DATAFORSEO_LOGIN/PASSWORD). Null if missing. */
export function createDfsClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DataForSeoClient | null {
  const login = env['DATAFORSEO_LOGIN']?.trim()
  const password = env['DATAFORSEO_PASSWORD']?.trim()
  if (!login || !password) return null
  // Volume is optional enrichment — fail soft and quick if slow.
  const timeoutMs = env['VERCEL'] ? 20_000 : 60_000
  return new DataForSeoClient({ credentials: { login, password }, timeoutMs })
}

/**
 * Convenience: volume with env credentials. Returns skipped if not live / no creds.
 */
export async function fetchDfsKeywordVolumesFromEnv(args: {
  keywords: string[]
  locationCode?: number | null
  languageCode?: string
  live?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<DfsKeywordVolumeResult> {
  const env = args.env ?? process.env
  const live =
    args.live === true ||
    (args.live !== false && env['LIVE_CALLS_ENABLED'] === 'true')
  const preferred =
    args.locationCode != null && Number.isFinite(args.locationCode) && args.locationCode > 0
      ? Math.trunc(args.locationCode)
      : DFS_VOLUME_LOCATION_US

  if (!live) {
    return {
      rows: emptyRows(
        [...new Set(args.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))],
      ),
      source: 'fixture',
      error: null,
      locationCode: preferred,
      volumeGeoTarget: volumeGeoLabel(preferred),
    }
  }

  const client = createDfsClientFromEnv(env)
  if (!client) {
    return {
      rows: emptyRows(
        [...new Set(args.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))],
      ),
      source: 'skipped',
      error: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set',
      locationCode: preferred,
      volumeGeoTarget: volumeGeoLabel(preferred),
    }
  }

  return fetchDfsKeywordVolumes(client, {
    keywords: args.keywords,
    locationCode: preferred,
    languageCode: args.languageCode,
    live: true,
  })
}

export async function fetchDfsKeywordVolumes(
  client: DataForSeoClient,
  args: {
    keywords: string[]
    /** City/metro/state DFS location_code. Defaults to US 2840. */
    locationCode?: number | null
    languageCode?: string
    /** When false, return null volumes without calling the API. */
    live?: boolean
  },
): Promise<DfsKeywordVolumeResult> {
  const unique = [...new Set(args.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))]
  const preferred =
    args.locationCode != null && Number.isFinite(args.locationCode) && args.locationCode > 0
      ? Math.trunc(args.locationCode)
      : DFS_VOLUME_LOCATION_US
  const languageCode = args.languageCode ?? 'en'

  if (unique.length === 0) {
    return {
      rows: [],
      source: 'skipped',
      error: null,
      locationCode: preferred,
      volumeGeoTarget: volumeGeoLabel(preferred),
    }
  }

  if (args.live === false) {
    return {
      rows: emptyRows(unique),
      source: 'fixture',
      error: null,
      locationCode: preferred,
      volumeGeoTarget: volumeGeoLabel(preferred),
    }
  }

  const tryCodes = preferred === DFS_VOLUME_LOCATION_US ? [DFS_VOLUME_LOCATION_US] : [preferred, DFS_VOLUME_LOCATION_US]
  let lastError: string | null = null

  for (const locationCode of tryCodes) {
    try {
      // Result is an array of per-keyword metrics (not a single object).
      const result = await client.post<DfsSearchVolumeRaw[]>(
        ENDPOINTS.KEYWORDS_GOOGLE_ADS_SEARCH_VOLUME,
        [
          {
            keywords: unique,
            location_code: locationCode,
            language_code: languageCode,
            search_partners: false,
          },
        ],
      )
      const rows = mapRows(Array.isArray(result) ? result : [], unique)
      return {
        rows,
        source: 'dataforseo_google_ads',
        error: locationCode !== preferred ? `city location_code invalid; used US ${DFS_VOLUME_LOCATION_US}` : null,
        locationCode,
        volumeGeoTarget: volumeGeoLabel(locationCode),
      }
    } catch (e) {
      lastError = (e as Error).message ?? String(e)
      // Invalid location → try US. Other errors stop unless we have a fallback code left.
      const isInvalidLocation =
        e instanceof DfsTaskError &&
        (e.statusCode === 40501 || /invalid field.*location_code/i.test(e.message))
      if (!isInvalidLocation && locationCode === tryCodes[tryCodes.length - 1]) break
      if (!isInvalidLocation && locationCode !== DFS_VOLUME_LOCATION_US) {
        // Non-location error on city attempt: still try US once for resilience.
        continue
      }
      if (isInvalidLocation) continue
      break
    }
  }

  return {
    rows: emptyRows(unique),
    source: 'skipped',
    error: lastError ?? 'DataForSEO search volume failed',
    locationCode: preferred,
    volumeGeoTarget: volumeGeoLabel(preferred),
  }
}

export function volumeGeoLabel(locationCode: number): string {
  if (locationCode === DFS_VOLUME_LOCATION_US) {
    return 'dataforseo location_code=2840 (US national)'
  }
  return `dataforseo location_code=${locationCode}`
}
