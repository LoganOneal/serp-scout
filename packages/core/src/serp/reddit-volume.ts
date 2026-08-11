import { CTR_CURVE } from '../scoring/priors.js'

/**
 * How many searches a month actually land on a Reddit thread we could comment on.
 *
 * ==================== WHY THIS IS THE RIGHT TOP-LINE ====================
 * "Reddit is on page 1" is a yes/no that says nothing about size, and keyword
 * volume alone says nothing about whether we can reach any of it. The number an
 * operator actually needs is the product: the demand for the query multiplied
 * by the share of it that reaches the position the thread holds.
 *
 * A thread at #1 on a 200/mo keyword is worth more than one at #9 on a 1,000/mo
 * keyword -- 55 estimated visits against 21 -- and neither the rank column nor
 * the volume column tells you that on its own.
 * =======================================================================
 */

/** Estimated share of searches that reach a given 1-based organic position. */
export function organicCtr(position: number | null | undefined): number {
  if (position == null || !Number.isFinite(position) || position < 1) return 0
  return CTR_CURVE[Math.trunc(position) - 1] ?? 0
}

/**
 * Position to score a discussions-pack hit at when no organic position exists.
 *
 * Pack results carry a `pack_position` inside a module, not an organic rank, so
 * the organic curve does not apply to them directly. They are treated as
 * mid-page rather than dropped: the module is genuinely visible, and scoring
 * them at zero would erase the surface this whole strategy targets.
 */
export const PACK_EQUIVALENT_POSITION = 5

export interface RedditVolumeInput {
  /** Measured monthly searches for the query. Null = never bought. */
  volume: number | null | undefined
  /** 1-based rank among organic results. */
  organicPosition?: number | null
  /** Absolute rank including ads and packs. Fallback only. */
  rankAbsolute?: number | null
  /** True when the hit came from the discussions/forums module. */
  fromPack?: boolean
}

/**
 * Estimated monthly visits to one Reddit thread.
 *
 * Returns null, never 0, when the volume was never measured -- a market whose
 * volume was not bought is not a market with no Reddit demand, and a zero here
 * would sort identically to a genuinely dead cell.
 */
export function estimateRedditVisits(input: RedditVolumeInput): number | null {
  const volume = input.volume
  if (volume == null || !Number.isFinite(volume) || volume <= 0) return null

  /**
   * Organic position is preferred because the CTR curve is an organic curve.
   * `rankAbsolute` counts ads and packs, so using it would apply position-9
   * click-through to a result that is genuinely organic-#3 with six ad units
   * above it -- understating every cluttered SERP.
   */
  const position =
    input.organicPosition ?? (input.fromPack ? PACK_EQUIVALENT_POSITION : input.rankAbsolute)

  const ctr = organicCtr(position)
  if (ctr <= 0) return null
  return Math.round(volume * ctr)
}

export interface RedditVolumeHit extends RedditVolumeInput {
  /** Distinct query. Used so one keyword cannot be counted twice. */
  keyword: string
}

export interface RedditVolumeTotal {
  /** Estimated monthly visits to Reddit threads across this cell. */
  visits: number | null
  /** Distinct keywords contributing. */
  keywords: number
  /** Best (lowest) organic position any thread held. */
  bestPosition: number | null
}

/**
 * Total reachable Reddit audience for a niche in a market.
 *
 * Summed over DISTINCT KEYWORDS, not over hits. One SERP frequently returns
 * several Reddit threads, and one keyword measured on two devices returns the
 * same demand twice -- counting either would inflate the total by a multiple
 * that varies with how the run was configured, which is the fastest way to
 * make a headline number meaningless.
 *
 * Within a keyword the best-placed thread wins, because that is the one an
 * operator would comment on.
 */
export function totalRedditVolume(hits: RedditVolumeHit[]): RedditVolumeTotal {
  const bestPerKeyword = new Map<string, { visits: number | null; position: number | null }>()

  for (const hit of hits) {
    const key = hit.keyword.trim().toLowerCase()
    if (!key) continue
    const visits = estimateRedditVisits(hit)
    const position =
      hit.organicPosition ?? (hit.fromPack ? PACK_EQUIVALENT_POSITION : (hit.rankAbsolute ?? null))

    const existing = bestPerKeyword.get(key)
    if (!existing || (visits ?? -1) > (existing.visits ?? -1)) {
      bestPerKeyword.set(key, { visits, position })
    }
  }

  const entries = [...bestPerKeyword.values()]
  const measured = entries.map((e) => e.visits).filter((v): v is number => v != null)
  const positions = entries
    .map((e) => e.position)
    .filter((p): p is number => p != null && Number.isFinite(p))

  return {
    visits: measured.length === 0 ? null : measured.reduce((a, b) => a + b, 0),
    keywords: bestPerKeyword.size,
    bestPosition: positions.length === 0 ? null : Math.min(...positions),
  }
}
