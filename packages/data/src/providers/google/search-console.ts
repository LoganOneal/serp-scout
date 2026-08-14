import 'server-only'

/**
 * Google Search Console — what we ACTUALLY rank for, free and complete.
 *
 * ==================== WHY THIS BEATS A KEYWORD VENDOR ====================
 * For a domain we own, this is strictly better than DataForSEO Labs on every
 * axis that matters, and the difference is not marginal:
 *
 *                     Search Console          Labs ranked_keywords
 *   Coverage          every query that        a crawl sample of the
 *                     produced an impression  vendor's index
 *   Position          our real average         modelled from a snapshot
 *   Impressions/CTR   yes                      impossible — no vendor has it
 *   Cost              $0                       per request, per-row unverified
 *   Competitors       no                       YES — its only advantage
 *
 * Where the two disagree about our own domain, this one is right. Do not
 * average them, and do not fall back to Labs for a domain we own just because
 * this returned few rows: few rows here is a measurement.
 *
 * The one thing it cannot do is show a keyword we have never had a single
 * impression for. That gap is exactly what the pattern grid and the competitor
 * gap exist to fill.
 * ======================================================================
 *
 * Credentials reuse the Google OAuth app already configured for Google Ads
 * (`keyword-ideas.ts` runs the same refresh flow), but the SCOPE is different —
 * `webmasters.readonly` — so the refresh token must be its own.
 */

/** Index-signature shape, matching GoogleAdsEnv, so `process.env` assigns cleanly. */
export type SearchConsoleEnv = Record<string, string | undefined>

export interface GscQueryRow {
  keyword: string
  /** Real clicks. No keyword vendor can supply this. */
  clicks: number
  impressions: number
  /**
   * Google's average position — a real number like 7.3, kept as such.
   *
   * Rounded only where a caller needs an integer. Averaging 4.4 and 10.6 to
   * "7" and calling it a ranking is the sort of quiet precision loss that makes
   * an IMPROVE decision look like a DEFEND one.
   */
  position: number
  ctr: number
}

export interface GscResult {
  rows: GscQueryRow[]
  source: 'search_console' | 'skipped'
  error: string | null
  /** True when Google returned a full page — there is more behind it. */
  truncated: boolean
  siteUrl: string
}

/** Google's documented maximum per searchAnalytics.query request. */
export const GSC_ROW_LIMIT = 25_000

export function searchConsoleConfigured(env: SearchConsoleEnv = process.env): boolean {
  const id = env['GSC_CLIENT_ID']?.trim() || env['GOOGLE_ADS_CLIENT_ID']?.trim()
  const secret = env['GSC_CLIENT_SECRET']?.trim() || env['GOOGLE_ADS_CLIENT_SECRET']?.trim()
  return Boolean(id && secret && env['GSC_REFRESH_TOKEN']?.trim())
}

async function accessToken(env: SearchConsoleEnv, fetchImpl: typeof fetch): Promise<string> {
  const body = new URLSearchParams({
    client_id: (env['GSC_CLIENT_ID']?.trim() || env['GOOGLE_ADS_CLIENT_ID']?.trim())!,
    client_secret: (env['GSC_CLIENT_SECRET']?.trim() || env['GOOGLE_ADS_CLIENT_SECRET']?.trim())!,
    refresh_token: env['GSC_REFRESH_TOKEN']!.trim(),
    grant_type: 'refresh_token',
  })
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as { access_token?: string; error_description?: string }
  if (!res.ok || !json.access_token) {
    throw new Error(`Search Console token exchange failed: ${json.error_description ?? res.status}`)
  }
  return json.access_token
}

/**
 * A property can be registered as a domain property or a URL-prefix property and
 * the API key is the exact string either way. Tried in order so an operator does
 * not have to know which one was verified.
 */
export function siteUrlCandidates(domain: string): string[] {
  const bare = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  return [`sc-domain:${bare}`, `https://${bare}/`, `https://www.${bare}/`, `http://${bare}/`]
}

/**
 * Query performance for one property.
 *
 * ==================== FAILURE IS LOUD HERE, UNLIKE THE ADS PATH ====================
 * `fetchKeywordIdeas` never throws — it returns `source: 'skipped'` and the
 * caller keeps its template keywords, which is right for an optional enrichment
 * on a sweep that must not stop.
 *
 * This is not optional enrichment. It is the answer to "what do we rank for",
 * and an empty result from it means "this site ranks for nothing". So a
 * configuration or auth failure returns `source: 'skipped'` WITH an error, and
 * every caller must branch on `source`, never on `rows.length`.
 * ================================================================================
 */
export async function fetchSearchConsoleQueries(args: {
  domain: string
  startDate: string
  endDate: string
  env?: SearchConsoleEnv
  fetchImpl?: typeof fetch
  rowLimit?: number
  /** Explicit property string, skipping candidate probing. */
  siteUrl?: string
}): Promise<GscResult> {
  const env = args.env ?? process.env
  const fetchImpl = args.fetchImpl ?? fetch
  const rowLimit = Math.min(args.rowLimit ?? GSC_ROW_LIMIT, GSC_ROW_LIMIT)

  if (!searchConsoleConfigured(env)) {
    return {
      rows: [],
      source: 'skipped',
      error:
        'Search Console not configured. Needs GSC_REFRESH_TOKEN (scope webmasters.readonly) ' +
        'plus GSC_CLIENT_ID/SECRET or the Google Ads OAuth app credentials.',
      truncated: false,
      siteUrl: '',
    }
  }

  let token: string
  try {
    token = await accessToken(env, fetchImpl)
  } catch (e) {
    return { rows: [], source: 'skipped', error: (e as Error).message, truncated: false, siteUrl: '' }
  }

  const candidates = args.siteUrl ? [args.siteUrl] : siteUrlCandidates(args.domain)
  const attempts: string[] = []

  for (const siteUrl of candidates) {
    const res = await fetchImpl(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: args.startDate,
          endDate: args.endDate,
          dimensions: ['query'],
          rowLimit,
          dataState: 'final',
        }),
      },
    )

    const text = await res.text()
    if (!res.ok) {
      attempts.push(`${siteUrl}: ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
      continue
    }

    const json = JSON.parse(text) as {
      rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>
    }
    const rows: GscQueryRow[] = []
    for (const r of json.rows ?? []) {
      const keyword = r.keys?.[0]?.trim().toLowerCase()
      if (!keyword) continue
      rows.push({
        keyword,
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        position: r.position ?? 0,
        ctr: r.ctr ?? 0,
      })
    }

    return {
      rows,
      source: 'search_console',
      error: null,
      // A full page means Google had more to give. Reported so nobody reads a
      // capped page as the complete keyword set.
      truncated: rows.length >= rowLimit,
      siteUrl,
    }
  }

  return {
    rows: [],
    source: 'skipped',
    error:
      `No Search Console property matched ${args.domain}. Tried: ${attempts.join(' | ')}. ` +
      `Verify the property and that this OAuth user has at least read access.`,
    truncated: false,
    siteUrl: '',
  }
}
