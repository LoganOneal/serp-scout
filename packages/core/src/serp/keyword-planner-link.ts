/**
 * Google Ads Keyword Planner deep links.
 *
 * Reality: Google does **not** document (or reliably support) URL params that
 * pre-fill a keyword + city geo and jump straight to historical volume results.
 * The planner is a logged-in SPA; deep links typically land on home / ideas and
 * ignore unknown query keys.
 *
 * What we can do:
 *  1. Open Keyword Planner (account must already be signed in).
 *  2. Surface the exact query + geo criteria ID we used in the API so the operator
 *     can paste them into "Get search volume and forecasts" and set Location.
 *  3. Optionally deep-link with our own query string for copy/share (not consumed by Google).
 */

/** Keyword Planner home (requires Google Ads login). */
export const KEYWORD_PLANNER_HOME = 'https://ads.google.com/aw/keywordplanner/home'

/** "Discover new keywords" entry (still no official keyword prefill). */
export const KEYWORD_PLANNER_IDEAS = 'https://ads.google.com/aw/keywordplanner/ideas/new'

export interface KeywordPlannerVerify {
  /** Opens Ads UI (user must be logged into the right account). */
  href: string
  /** Exact string to paste into "Get search volume and forecasts". */
  keyword: string
  /** Criteria ID we sent as geoTargetConstants/{id}, when known. */
  geoCriteriaId: number | null
  /** Human label e.g. geoTargetConstants/1013462 or US national. */
  geoLabel: string | null
  /** One-line instruction for the operator. */
  howTo: string
  /** Title/tooltip for the link. */
  title: string
  /** Text to copy: keyword + geo hint. */
  copyText: string
}

/**
 * Parse criteria id from a stored volume_geo_target label when possible.
 * Accepts "geoTargetConstants/1013462", "1013462", or US national labels.
 */
export function parseGeoCriteriaId(geoLabel: string | null | undefined): number | null {
  if (!geoLabel) return null
  const m = geoLabel.match(/geoTargetConstants\/(\d+)/i) ?? geoLabel.match(/\b(\d{3,})\b/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Build a verify payload for UI next to measured volume.
 * Href opens Keyword Planner home; keyword/geo are for the operator to match our API call.
 */
export function buildKeywordPlannerVerify(args: {
  keyword: string
  /** Stored volume_geo_target or similar. */
  volumeGeoTarget?: string | null
  /** Explicit criteria id when known (preferred over parsing the label). */
  geoCriteriaId?: number | null
}): KeywordPlannerVerify {
  const keyword = args.keyword.trim()
  const geoCriteriaId =
    args.geoCriteriaId ?? parseGeoCriteriaId(args.volumeGeoTarget ?? null)
  const geoLabel = args.volumeGeoTarget?.trim() || null

  // Query string is for us / support / screenshots — Google typically ignores it.
  const params = new URLSearchParams()
  if (keyword) params.set('rnr_kw', keyword)
  if (geoCriteriaId != null) params.set('rnr_geo', String(geoCriteriaId))
  const qs = params.toString()
  const href = qs ? `${KEYWORD_PLANNER_HOME}?${qs}` : KEYWORD_PLANNER_HOME

  const geoHint =
    geoCriteriaId != null
      ? geoCriteriaId === 2840
        ? 'United States (national)'
        : `location criteria ${geoCriteriaId}`
      : geoLabel ?? 'same location as the research cell'

  const howTo =
    `In Keyword Planner → “Get search volume and forecasts”, paste the keyword, ` +
    `set Location to ${geoHint}, Language English, Network Google. ` +
    `Compare avg monthly searches to the figure we stored.`

  const title =
    keyword === ''
      ? 'Open Google Ads Keyword Planner'
      : `Verify “${keyword}” in Keyword Planner (${geoHint})`

  const copyText =
    geoCriteriaId != null
      ? `${keyword}\n# geoTargetConstants/${geoCriteriaId}`
      : keyword

  return {
    href,
    keyword,
    geoCriteriaId,
    geoLabel,
    howTo,
    title,
    copyText,
  }
}
