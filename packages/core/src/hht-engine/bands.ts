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
 */
export const SERP_BANDS: readonly SerpBand[] = [
  { band: 1, positionStart: 1, positionEnd: 20, displayOffset: 0, displayLimit: 20, usedFor: 'insertion_and_guest_post' },
  { band: 2, positionStart: 21, positionEnd: 50, displayOffset: 20, displayLimit: 30, usedFor: 'guest_post' },
  { band: 3, positionStart: 51, positionEnd: 100, displayOffset: 50, displayLimit: 50, usedFor: 'guest_post' },
]

export function bandForDepth(maxPositionScanned: number): SerpBand | null {
  return SERP_BANDS.find((band) => band.positionStart > maxPositionScanned) ?? null
}

export function phraseOrganicParams(keyword: string, band: SerpBand, database = 'us'): Record<string, unknown> {
  return {
    phrase: keyword,
    database,
    display_offset: band.displayOffset,
    display_limit: band.displayLimit,
    positions_type: 'organic',
  }
}
