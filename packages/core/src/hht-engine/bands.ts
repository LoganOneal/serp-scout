export interface SerpBand {
  band: 1 | 2 | 3
  positionStart: number
  positionEnd: number
  displayOffset: number
  displayLimit: number
  usedFor: 'insertion_and_guest_post' | 'guest_post'
}

/**
 * phrase_organic accepts display_offset, measured 2026-09-29. Fetch each band
 * on its own so band 2 does not pay for positions 1–20 again.
 * A one-row phrase_organic call consumed 10 API units.
 *
 * On the Semrush MCP, display_limit is the last position returned, not a row
 * count: offset 20 / limit 50 returns positions 21–50 (measured 2026-10-03).
 * An offset at or above the limit is rejected with ERROR 605.
 */
export const SERP_BANDS: readonly SerpBand[] = [
  { band: 1, positionStart: 1, positionEnd: 20, displayOffset: 0, displayLimit: 20, usedFor: 'insertion_and_guest_post' },
  { band: 2, positionStart: 21, positionEnd: 50, displayOffset: 20, displayLimit: 30, usedFor: 'guest_post' },
  { band: 3, positionStart: 51, positionEnd: 100, displayOffset: 50, displayLimit: 50, usedFor: 'guest_post' },
]

/** Resumes inside a band when an earlier fetch stopped short of its end. */
export function bandForDepth(maxPositionScanned: number): SerpBand | null {
  const band = SERP_BANDS.find((candidate) => candidate.positionEnd > maxPositionScanned)
  if (!band) return null
  const offset = Math.max(band.displayOffset, maxPositionScanned)
  return { ...band, positionStart: offset + 1, displayOffset: offset, displayLimit: band.positionEnd - offset }
}

export function phraseOrganicParams(keyword: string, band: SerpBand, database = 'us'): Record<string, unknown> {
  return {
    phrase: keyword,
    database,
    display_offset: band.displayOffset,
    display_limit: band.displayOffset + band.displayLimit,
    positions_type: 'organic',
  }
}
