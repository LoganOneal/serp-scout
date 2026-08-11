/**
 * Collapse keyword variations into one niche x market cell.
 *
 * ==================== WHY THE GRID GROUPS AT ALL ====================
 * A sweep buys one SERP per keyword variation, so a niche measured with eight
 * variations produced eight rows in the same market. That reads as eight
 * opportunities when it is one: an operator ranking for "fire damage
 * restoration" in Indianapolis is ranking for the whole cluster, and the
 * decision they are making is about the niche in that market, not about a
 * single phrase.
 *
 * Grouping is done here rather than in SQL because the aggregation rules are a
 * judgement call that has to be arguable and testable without a database.
 * ===================================================================
 */

/** The subset of a grid row this module needs. Keeps core free of the DB shape. */
/**
 * Every optional field is `| undefined` on purpose. Callers render this grid
 * from more than one query, and the narrower view types mark columns they never
 * select as optional rather than null. Accepting both here keeps the grouper
 * usable from all of them; the output below normalises back to null so
 * consumers have exactly one "missing" value to check.
 */
export interface GroupableRow {
  researchKeywordId: number
  researchGeoId: number
  keyword: string
  seedKey?: string | undefined
  variant?: string | undefined
  /** Absent is treated as desktop, which is what desktop-only views show. */
  device?: string | undefined
  volume?: number | null | undefined
  opportunityScore?: number | null | undefined
  firstOrganicRankAbsolute?: number | null | undefined
  bestRedditAbsoluteRank?: number | null | undefined
  redditHitCount?: number | null | undefined
  nicheId?: number | null | undefined
  nicheSlug?: string | null | undefined
  difficulty?: number | null | undefined
  slotsOpen?: number | null | undefined
  redditVisits?: number | null | undefined
  redditBestPosition?: number | null | undefined
  verdictAcquired?: string | null | undefined
  verdictEmd?: string | null | undefined
  market: string
  stateAbbr?: string | null | undefined
  localitySlug?: string | null | undefined
  marketHref?: string | null | undefined
}

export interface GroupedOpportunityRow<T extends GroupableRow> {
  /** Stable key for React and for cross-render selection. */
  key: string
  /** Niche identity: the matched niche when there is one, else the seed. */
  nicheId: number | null
  nicheSlug: string | null
  /** What to show in the niche column. */
  label: string
  researchGeoId: number
  /** Every device this cell was measured on, e.g. ['desktop','mobile']. */
  devices: string[]
  market: string
  stateAbbr: string | null
  localitySlug: string | null
  marketHref: string | null

  /**
   * Total addressable demand: the SUM across DISTINCT KEYWORDS.
   *
   * Sum rather than max because the variations are different queries a real
   * searcher types, and a niche worth 2,410 searches across eight phrasings is
   * genuinely bigger than one worth 880 on the seed alone.
   *
   * Distinct keywords, not rows, because a cell measured on desktop AND mobile
   * yields two rows carrying the SAME volume -- volume is a property of the
   * query and the market, not of the device. Summing rows would report 2,260
   * for a niche worth 1,130. Nulls are skipped, never counted as zero, and
   * `volumeComplete` says whether any were missing.
   */
  volume: number | null
  /** False when at least one variation had no measured volume. */
  volumeComplete: boolean

  /** Best (lowest) organic rank any variation achieved. */
  firstOrganicRankAbsolute: number | null
  /** Best (lowest) Reddit rank any variation achieved. */
  bestRedditAbsoluteRank: number | null
  /**
   * Reddit threads across the cell's DISTINCT keywords.
   *
   * Deduped per keyword like volume and visits are: one keyword measured on
   * desktop and mobile returns the same threads twice, and summing rows would
   * report a cell as twice as busy as it is.
   *
   * Carried so the grid can tell "no Reddit here" apart from "Reddit here, but
   * no volume to estimate visits from" -- which previously rendered as the same
   * em dash in the column an operator scans first.
   */
  redditHitCount: number
  /** Highest opportunity score across variations. */
  opportunityScore: number | null
  /**
   * LOWEST difficulty across variations -- the easiest way into this niche in
   * this market. Max would describe the hardest phrasing, which nobody would
   * choose to target.
   */
  difficulty: number | null
  /** Most open slot count seen. */
  slotsOpen: number | null
  /**
   * Estimated monthly searches reaching a Reddit thread across this niche in
   * this market. Summed over DISTINCT KEYWORDS, like volume -- a keyword
   * measured on desktop and mobile is one audience, not two.
   */
  redditVisits: number | null
  /** Best organic position any thread held anywhere in the group. */
  redditBestPosition: number | null
  /** Best (fastest) verdict band across variations, on the acquisition path. */
  verdictAcquired: string | null
  verdictEmd: string | null

  /** The variation the headline rank/score came from, so the number is traceable. */
  bestVariation: T
  /** Every measured row, strongest first — one per keyword per device. */
  variations: T[]
  /** DISTINCT keywords measured. Not row count: two devices are not two keywords. */
  variationCount: number
}

const minOf = (values: Array<number | null | undefined>): number | null => {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v))
  return nums.length === 0 ? null : Math.min(...nums)
}

/**
 * Fastest-first. A group takes the best band any of its keywords reached,
 * because an operator targets the easiest way in, not the average way in.
 */
const VERDICT_ORDER = ['likely_30d', 'likely_90d', 'likely_6m', 'unknown', 'not_winnable'] as const

function bestVerdict(values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  let bestIdx = Number.POSITIVE_INFINITY
  for (const v of values) {
    if (!v) continue
    const i = VERDICT_ORDER.indexOf(v as (typeof VERDICT_ORDER)[number])
    // An unrecognised band sorts after every known one rather than winning.
    const idx = i === -1 ? VERDICT_ORDER.length : i
    if (idx < bestIdx) {
      bestIdx = idx
      best = v
    }
  }
  return best
}

const maxOf = (values: Array<number | null | undefined>): number | null => {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v))
  return nums.length === 0 ? null : Math.max(...nums)
}

/**
 * Identity of the niche this row belongs to.
 *
 * `nicheId` is what actually clusters an expansion set, and it is the only
 * thing that does.
 *
 * `seedKey` looks like it should group siblings but does not: the catalog
 * stores each expansion with its OWN keyword as its seed, so
 * "water damage restoration cost" has seed_key "water damage restoration cost",
 * not "water damage restoration". It groups a keyword with its own `near_me`
 * variant and nothing else. It is kept as a fallback because that pairing is
 * still better than nothing, but an unmatched niche will NOT collapse — which
 * is honest: without a niche we do not know what cluster a phrase belongs to.
 */
export function nicheGroupKey(row: GroupableRow): string {
  if (row.nicheId != null) return `n:${row.nicheId}`
  if (row.seedKey && row.seedKey.trim()) return `s:${row.seedKey.trim().toLowerCase()}`
  return `k:${row.keyword.trim().toLowerCase()}`
}

/**
 * The phrase to title the group with.
 *
 * `variant` cannot answer this — the catalog marks every expansion `primary`
 * (only `near_me` differs), so picking "the primary one" silently returned the
 * highest-scoring row and titled a group "water damage restoration cost" when
 * the niche is "water damage restoration".
 *
 * The seed is instead the phrase the others are built ON TOP OF, so it is
 * detected structurally: the variation that the most siblings start with wins.
 * Ties break to the shortest phrase, then to the highest volume, both of which
 * point the same way for a head term.
 */
function seedLabel<T extends GroupableRow>(variations: T[]): string {
  let best = variations[0]!
  let bestPrefixCount = -1
  for (const candidate of variations) {
    const kw = candidate.keyword.trim().toLowerCase()
    if (!kw) continue
    const prefixCount = variations.filter(
      (other) => other !== candidate && other.keyword.trim().toLowerCase().startsWith(kw),
    ).length

    if (prefixCount > bestPrefixCount) {
      best = candidate
      bestPrefixCount = prefixCount
      continue
    }
    if (prefixCount === bestPrefixCount) {
      const bestKw = best.keyword.trim()
      if (
        candidate.keyword.trim().length < bestKw.length ||
        (candidate.keyword.trim().length === bestKw.length &&
          (candidate.volume ?? -1) > (best.volume ?? -1))
      ) {
        best = candidate
      }
    }
  }
  return best.keyword
}

/**
 * One row per niche x market. Device is NOT part of the key.
 *
 * ==================== WHY DEVICE IS NOT A GROUPING AXIS ====================
 * It used to be, on the reasoning that a desktop and a mobile measurement are
 * two different observations. That reasoning is fine and the conclusion was
 * wrong: it produced two rows for "hvac repair - Houston, TX" in the grid,
 * which is exactly the duplication this module exists to remove. An operator
 * decides about a niche in a market once, not once per device.
 *
 * Both measurements are kept as variations, each tagged with its device, so the
 * desktop/mobile difference is one click away rather than a duplicated row.
 * ==========================================================================
 */
export function groupByNicheMarket<T extends GroupableRow>(
  rows: T[],
): Array<GroupedOpportunityRow<T>> {
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const key = `${nicheGroupKey(row)}|${row.researchGeoId}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  const out: Array<GroupedOpportunityRow<T>> = []
  for (const [key, bucket] of buckets) {
    // Strongest first, so `variations[0]` is a sensible representative and the
    // expanded list reads top-down.
    const variations = [...bucket].sort(
      (a, b) =>
        (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1) ||
        (b.volume ?? -1) - (a.volume ?? -1) ||
        a.keyword.localeCompare(b.keyword),
    )

    const first = variations[0]!

    /**
     * One volume per distinct keyword. The first non-null wins; a keyword
     * measured on both devices contributes once.
     */
    const volumeByKeyword = new Map<string, number | null | undefined>()
    for (const v of variations) {
      const k = v.keyword.trim().toLowerCase()
      const existing = volumeByKeyword.get(k)
      if (existing == null) volumeByKeyword.set(k, v.volume)
    }
    const volumes = [...volumeByKeyword.values()]
    const known = volumes.filter((v): v is number => v != null && Number.isFinite(v))

    const bestScore = maxOf(variations.map((v) => v.opportunityScore))
    // Trace the headline score back to the variation that produced it.
    const bestVariation =
      bestScore == null ? first : (variations.find((v) => v.opportunityScore === bestScore) ?? first)

    const label = seedLabel(variations)

    out.push({
      key,
      nicheId: first.nicheId ?? null,
      nicheSlug: first.nicheSlug ?? null,
      label,
      researchGeoId: first.researchGeoId,
      devices: [...new Set(variations.map((v) => v.device ?? 'desktop'))].sort(),
      market: first.market,
      stateAbbr: first.stateAbbr ?? null,
      localitySlug: first.localitySlug ?? null,
      marketHref: first.marketHref ?? null,
      volume: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
      volumeComplete: known.length === volumes.length,
      firstOrganicRankAbsolute: minOf(variations.map((v) => v.firstOrganicRankAbsolute)),
      bestRedditAbsoluteRank: minOf(variations.map((v) => v.bestRedditAbsoluteRank)),
      redditHitCount: (() => {
        const byKeyword = new Map<string, number>()
        for (const v of variations) {
          const k = v.keyword.trim().toLowerCase()
          byKeyword.set(k, Math.max(byKeyword.get(k) ?? 0, v.redditHitCount ?? 0))
        }
        return [...byKeyword.values()].reduce((a, b) => a + b, 0)
      })(),
      opportunityScore: bestScore,
      difficulty: minOf(variations.map((v) => v.difficulty)),
      redditVisits: (() => {
        // One value per keyword, then summed -- the device duplicate carries
        // the same audience and must not be added twice.
        const byKeyword = new Map<string, number>()
        for (const v of variations) {
          if (v.redditVisits == null) continue
          const k = v.keyword.trim().toLowerCase()
          byKeyword.set(k, Math.max(byKeyword.get(k) ?? 0, v.redditVisits))
        }
        const vals = [...byKeyword.values()]
        return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0)
      })(),
      redditBestPosition: minOf(variations.map((v) => v.redditBestPosition)),
      slotsOpen: maxOf(variations.map((v) => v.slotsOpen)),
      verdictAcquired: bestVerdict(variations.map((v) => v.verdictAcquired)),
      verdictEmd: bestVerdict(variations.map((v) => v.verdictEmd)),
      bestVariation,
      variations,
      variationCount: volumeByKeyword.size,
    })
  }

  return out.sort(
    (a, b) =>
      (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1) ||
      (b.volume ?? -1) - (a.volume ?? -1) ||
      a.label.localeCompare(b.label),
  )
}
