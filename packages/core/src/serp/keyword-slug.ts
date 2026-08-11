/**
 * URL slugs for a measured keyword inside a run.
 *
 * ==================== WHY A SLUG AND NOT AN ID ====================
 * `/research/runs/38/serp/best-roofing-san-jose` says what it opens. A metrics
 * id does not, and an operator cannot guess, share or edit one.
 *
 * The cost is ambiguity, and it is real: a catalog sweep measures the SAME
 * keyword across many markets, so "roofing" in run 27 slugs identically for
 * Houston and San Jose. The resolver therefore returns MATCHES rather than a
 * row, and the page disambiguates by market when more than one comes back.
 * A slug that cannot be resolved to exactly one measurement must never quietly
 * pick the first.
 * ==================================================================
 */

/** Lowercase, hyphenated, ASCII-only. Stable across renders and safe in a path. */
export function keywordSlug(keyword: string): string {
  return keyword
    .normalize('NFKD')
    // Strip diacritics so "café" and "cafe" do not become different pages.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Slug for a market, used only when a keyword slug is ambiguous within a run.
 * "San Jose" + "CA" -> "san-jose-ca".
 */
export function marketSlug(market: string, stateAbbr?: string | null): string {
  return keywordSlug([market, stateAbbr].filter(Boolean).join(' '))
}

export interface SlugCandidate {
  keyword: string
  market: string | null
  stateAbbr: string | null
}

/**
 * Does this candidate answer the requested path segments?
 *
 * Accepts either `[keyword]` or `[market]/[keyword]`, so the short form works
 * whenever it is unambiguous and the long form is available when it is not.
 */
export function matchesKeywordPath(candidate: SlugCandidate, segments: string[]): boolean {
  const parts = segments.filter(Boolean)
  if (parts.length === 0) return false
  const kw = keywordSlug(candidate.keyword)

  if (parts.length === 1) return parts[0] === kw
  const [market, ...rest] = parts
  if (rest.join('-') !== kw && rest.join('/') !== kw) return false
  return marketSlug(candidate.market ?? '', candidate.stateAbbr) === market
}

/** The path a link should use: short when unique in the run, market-qualified when not. */
export function keywordPathFor(
  candidate: SlugCandidate,
  allInRun: SlugCandidate[],
): string {
  const kw = keywordSlug(candidate.keyword)
  const sameSlug = allInRun.filter((c) => keywordSlug(c.keyword) === kw)
  const distinctMarkets = new Set(
    sameSlug.map((c) => marketSlug(c.market ?? '', c.stateAbbr)),
  )
  if (distinctMarkets.size <= 1) return kw
  return `${marketSlug(candidate.market ?? '', candidate.stateAbbr)}/${kw}`
}
