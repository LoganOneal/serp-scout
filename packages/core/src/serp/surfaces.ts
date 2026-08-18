/**
 * SERP surfaces: which blocks a query returns, and whether we occupy one.
 *
 * ==================== A SERP IS A BOARD, NOT A RANKING ====================
 * `hotels with jacuzzi in room chicago` does not return ten blue links. It
 * returns an AI Overview, a Maps pack, a Discussions and Forums pack, an images
 * strip, a video carousel, People Also Ask, and then organic. "Are we ranking?"
 * collapses all of that into one number about one surface.
 *
 * The useful question is which surfaces we hold, which is a grid rather than a
 * scalar — and it is the question this module answers per (keyword, surface).
 * =========================================================================
 */

export type SerpSurface =
  | 'organic'
  | 'discussions'
  | 'images'
  | 'video'
  | 'paa'
  | 'ai_overview'
  | 'maps'
  | 'paid'
  | 'top_stories'
  | 'shopping'
  /**
   * Google's hotel booking module. Found by the first live probe, which is the
   * point of buying one: it is arguably THE surface for a hotel directory and it
   * was not in the list.
   *
   * Not occupiable — the pack lists properties and OTAs, not directories — but
   * its PRESENCE matters a great deal, because it sits above organic and absorbs
   * exactly the commercial intent this site monetises.
   */
  | 'hotels_pack'

export const SERP_SURFACES: readonly SerpSurface[] = [
  'organic',
  'discussions',
  'images',
  'video',
  'paa',
  'ai_overview',
  'maps',
  'paid',
  'top_stories',
  'shopping',
  'hotels_pack',
]

/** Human labels, short enough for a column header in a dense grid. */
export const SURFACE_LABELS: Readonly<Record<SerpSurface, string>> = {
  organic: 'Organic',
  discussions: 'Forums',
  images: 'Images',
  video: 'Video',
  paa: 'PAA',
  ai_overview: 'AI',
  maps: 'Maps',
  paid: 'Ads',
  top_stories: 'News',
  shopping: 'Shop',
  hotels_pack: 'Hotels',
}

/**
 * Surfaces a directory site can realistically occupy.
 *
 * `maps` is excluded because a directory is not a local business — it can never
 * hold a Maps slot, so counting it as an unheld surface would permanently
 * depress every completion figure by one for a reason nobody can act on.
 * Presence is still recorded; it just does not count against us.
 */
export const OCCUPIABLE_SURFACES: readonly SerpSurface[] = [
  'organic',
  'discussions',
  'images',
  'video',
  'paa',
  'ai_overview',
]

/**
 * DataForSEO `item_type` values, mapped to a surface.
 *
 * Matched by prefix and by membership rather than exact equality, because the
 * vendor adds types over time (`ai_overview`, `discussions_and_forums`, and
 * `perspectives` all appeared after this pipeline was first written). An
 * unrecognised type maps to null and is counted as unmapped rather than dropped
 * silently — a surface we cannot name is one we would otherwise never notice
 * arriving.
 */
export function surfaceForItemType(itemType: string): SerpSurface | null {
  const t = itemType.trim().toLowerCase()
  if (!t) return null

  if (t === 'organic') return 'organic'
  if (t.startsWith('paid') || t === 'commercial_units') return 'paid'
  if (t.includes('discussions') || t === 'perspectives' || t === 'forum') return 'discussions'
  if (t.startsWith('images') || t === 'image') return 'images'
  if (t.startsWith('video') || t === 'youtube') return 'video'
  if (t.includes('people_also_ask') || t === 'related_questions') return 'paa'
  if (t.includes('ai_overview') || t === 'generative_answers') return 'ai_overview'
  if (t.startsWith('local_pack') || t.startsWith('map') || t === 'local_finder') return 'maps'
  if (t.includes('top_stories') || t === 'news') return 'top_stories'
  if (t.includes('shopping') || t === 'popular_products') return 'shopping'
  if (t.includes('hotels_pack') || t === 'hotel_pack' || t === 'travel_pack') return 'hotels_pack'
  return null
}

/**
 * ==================== FOUR STATES, AND THREE OF THEM LOOK LIKE "NO" ======
 * For one keyword on one surface:
 *
 *   held        the surface exists and we occupy a slot
 *   theirs      the surface exists, someone else holds it   -> go compete
 *   absent      Google does not return this surface here    -> nothing to win
 *   unmeasured  no SERP has ever been bought                -> go find out
 *
 * A grid that paints the last three as one empty cell merges three completely
 * different instructions. It matters more here than in a table, because a grid
 * INVITES the eye to read empty as bad — and today almost every cell is
 * unmeasured.
 * ========================================================================
 */
export type SurfaceState =
  | 'held'
  | 'theirs'
  | 'absent'
  | 'unmeasured'
  /**
   * The surface is on the page and the response carries NO domains for it, so
   * ownership cannot be determined either way.
   *
   * Found by the first live probe: the images block came back present with zero
   * holder domains, and the four-state model called that THEIRS — a claim that
   * somebody else holds it, made from a response that says nothing about who
   * holds it. "We looked and cannot tell" is not "we looked and it is not ours",
   * and on a grid the difference is a cell that sends you to compete for
   * something you may already have.
   */
  | 'unattributable'

export interface SurfaceObservation {
  surface: SerpSurface
  /** Did Google return this surface at all? */
  present: boolean
  /** Our rank within it. Null WITH present means the surface exists without us. */
  ourRank: number | null
  /**
   * How many domains the response attributed to this block.
   *
   * Zero on a PRESENT surface means the block carries no attribution at all, so
   * `ourRank: null` cannot be read as "someone else holds it". Optional so older
   * rows keep working; undefined is treated as attributable, which is what the
   * four-state model already assumed.
   */
  holderCount?: number
}

export function surfaceState(obs: SurfaceObservation | null | undefined): SurfaceState {
  if (!obs) return 'unmeasured'
  if (!obs.present) return 'absent'
  if (obs.ourRank !== null) return 'held'
  return obs.holderCount === 0 ? 'unattributable' : 'theirs'
}

/** Glyphs, because status must never be colour alone. */
export const SURFACE_GLYPHS: Readonly<Record<SurfaceState, string>> = {
  held: '●',
  theirs: '○',
  absent: '·',
  unmeasured: '▪',
  unattributable: '?',
}

export interface CoverageTally {
  /** Surfaces we occupy. */
  held: number
  /**
   * Surfaces we COULD occupy — present, occupiable, and measured.
   *
   * Excludes absent surfaces deliberately: a keyword with no video carousel is
   * not behind for failing to be in one, and a denominator that counted it would
   * make every score a function of what Google happened to render.
   */
  available: number
  /** True when nothing has been measured. Renders as an em dash, never 0/n. */
  unmeasured: boolean
}

export function tallyCoverage(
  observations: SurfaceObservation[],
  occupiable: readonly SerpSurface[] = OCCUPIABLE_SURFACES,
): CoverageTally {
  const relevant = observations.filter((o) => occupiable.includes(o.surface))
  if (relevant.length === 0) return { held: 0, available: 0, unmeasured: true }

  let held = 0
  let available = 0
  for (const o of relevant) {
    if (!o.present) continue
    /**
     * A surface whose ownership cannot be determined is left OUT of the
     * denominator entirely rather than counted as unheld. Counting it would
     * quietly depress the ratio using a fact we do not have.
     */
    if (o.ourRank === null && o.holderCount === 0) continue
    available += 1
    if (o.ourRank !== null) held += 1
  }
  return { held, available, unmeasured: false }
}

/**
 * Does this domain belong to us?
 *
 * Subdomain-aware and boundary-safe: `hotelhottubs.com` must match
 * `www.hotelhottubs.com` and must NOT match `nothotelhottubs.com`. The naive
 * `includes()` gets the second one wrong and would credit us with a competitor's
 * slot.
 */
export function isOurDomain(candidate: string, ours: string): boolean {
  const c = candidate.trim().toLowerCase().replace(/^www\./, '')
  const o = ours.trim().toLowerCase().replace(/^www\./, '')
  if (!c || !o) return false
  return c === o || c.endsWith(`.${o}`)
}
