/**
 * Clusters: aggregating many keywords into the one page that serves them.
 *
 * ==================== THE UNIT OF WORK IS A PAGE ====================
 * `hotels with jacuzzi in room houston`, `houston hotels with hot tub in room`
 * and `in room jacuzzi suites in houston tx` are one page. Deciding them
 * separately produces three BUILD verdicts for one job, three value estimates
 * that sum to three times the prize, and no answer to "which of these does the
 * title target".
 * ===================================================================
 */

/** What kind of page a cluster becomes. Decides whether supply applies at all. */
export type ClusterKind =
  /** A city/state/region page. The ONLY kind that binds an entity and inherits the supply gate. */
  | 'locality'
  /** A brand filter page — `chain_hilton`. Has no locality; supply is not applicable. */
  | 'brand'
  /** The home page or a national hub — `head`, `head_near_me`. */
  | 'head'
  /** A qualifier collection — `romantic`, `two_person`, `balcony`. */
  | 'modifier'
  /** A property-type collection — `suites`, `motel`, `resort`, `bnb`. */
  | 'property_type'
  /** A phrasing variant of another cluster, not a page of its own. */
  | 'vocab'
  /**
   * Not a cluster. Bad data parked somewhere visible.
   *
   * `data_anomaly` arrives as a cluster label in the source export. Imported
   * naively it becomes a content cluster with a verdict and a place in the work
   * queue — so it gets its own kind, is excluded from every board, and is
   * counted in the import report where somebody can fix it.
   */
  | 'quarantine'

export const CLUSTER_KINDS: readonly ClusterKind[] = [
  'locality',
  'brand',
  'head',
  'modifier',
  'property_type',
  'vocab',
  'quarantine',
]

/**
 * Infer a cluster's kind from the label the researcher wrote.
 *
 * The labels carry an implicit type prefix (`city_houston`, `chain_hilton`) and
 * that prefix is doing real work, so it is read rather than discarded. Anything
 * unrecognised becomes `modifier` — the least-privileged kind, which binds no
 * entity and claims no supply.
 */
export function inferClusterKind(label: string): ClusterKind {
  const s = label.trim().toLowerCase()
  if (!s) return 'modifier'
  if (s === 'data_anomaly' || s.startsWith('anomaly')) return 'quarantine'
  if (s.startsWith('city_') || s.startsWith('state_') || s.startsWith('region_')) return 'locality'
  if (s.startsWith('chain_') || s.startsWith('brand_')) return 'brand'
  if (s === 'head' || s.startsWith('head_')) return 'head'
  if (s.startsWith('vocab_')) return 'vocab'
  if (['suites', 'motel', 'resort', 'inn', 'bnb', 'hotel', 'cabin'].includes(s)) {
    return 'property_type'
  }
  return 'modifier'
}

/** Does this kind of cluster have inventory to speak of? */
export function clusterUsesSupply(kind: ClusterKind): boolean {
  return kind === 'locality'
}

export interface ClusterMember {
  keywordNorm: string
  /** Null = never measured. Never coerced to 0. */
  volume: number | null
  /** Semrush KD, on Semrush's scale. NOT scoreDifficulty. */
  semrushKd: number | null
  position: number | null
  positionMeasured: boolean
}

/**
 * ==================== TWO VOLUMES, AND THE REASON ====================
 * Summing member volumes is the obvious aggregate and it is measurably wrong.
 * In the source export 109 of 2,359 keywords report the SAME volume as a longer
 * or shorter variant of themselves — Google groups near-identical queries and
 * the export lists each surface form:
 *
 *     hot tub hotel rooms · hot tub hotel rooms near me ·
 *     hotels near me with hot tubs · hotels near me with hot tubs in room
 *
 * All four: 590. Summed, 2,360 claimed for roughly 590 of real demand.
 *
 * Per city the inflation measured 4.5x, 7.3x and 11.2x — and because it is
 * UNEVEN it does not cancel out when comparing cities. It REORDERS them: the
 * city with the most phrasings in the export wins, not the city with the most
 * demand.
 *
 * So `max` is the ranking number and a genuine lower bound (demand is at least
 * the biggest single query), `sum` is retained as an upper bound, and every
 * consumer is expected to show the range rather than pick a point it cannot
 * defend — the same discipline as computing break-even at both ends of a bid
 * range and qualifying only on the pessimistic one.
 * =====================================================================
 */
export interface ClusterVolume {
  /** Lower bound. THE number to rank on. Null when no member was measured. */
  max: number | null
  /** Upper bound, inflated by near-duplicate phrasings. Never sort on it. */
  sum: number | null
  /** How many members carried a measured volume. The denominator for the bound. */
  measuredMembers: number
}

export interface ClusterAggregate {
  memberCount: number
  volume: ClusterVolume
  /** The easiest way in — the member you would actually target first. */
  kdMin: number | null
  /** The honest picture of the cluster as a whole. */
  kdMedian: number | null
  /** Best position across members: if any member ranks, the page ranks. */
  bestPosition: number | null
  /** True when at least one member's position was actually looked up. */
  positionMeasured: boolean
  /** The highest-volume member. What a page title would target. */
  primaryKeywordNorm: string | null
}

export function aggregateCluster(members: ClusterMember[]): ClusterAggregate {
  const volumes = members.map((m) => m.volume).filter((v): v is number => v !== null)
  const kds = members.map((m) => m.semrushKd).filter((v): v is number => v !== null)
  const positions = members
    .filter((m) => m.positionMeasured && m.position !== null)
    .map((m) => m.position as number)

  /**
   * The primary is the highest-VOLUME member, not the shortest string.
   *
   * Shortest looks like the head term and often is not: "hotels with jacuzzi in
   * room in" is longer than "hotels with jacuzzi in room" and reports identical
   * volume, while a genuine head term can be long. Ties break on the shorter
   * string, which is the tidier title of two equals.
   */
  let primary: ClusterMember | null = null
  for (const m of members) {
    if (m.volume === null) continue
    if (
      primary === null ||
      primary.volume === null ||
      m.volume > primary.volume ||
      (m.volume === primary.volume && m.keywordNorm.length < primary.keywordNorm.length)
    ) {
      primary = m
    }
  }

  return {
    memberCount: members.length,
    volume: {
      max: volumes.length > 0 ? Math.max(...volumes) : null,
      sum: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) : null,
      measuredMembers: volumes.length,
    },
    kdMin: kds.length > 0 ? Math.min(...kds) : null,
    kdMedian: median(kds),
    bestPosition: positions.length > 0 ? Math.min(...positions) : null,
    /**
     * Measured if ANY member was looked up. Search Console silence for a keyword
     * is itself the measurement, so a cluster whose members were all checked and
     * none ranked is measured-and-absent, not unmeasured.
     */
    positionMeasured: members.some((m) => m.positionMeasured),
    primaryKeywordNorm: primary?.keywordNorm ?? members[0]?.keywordNorm ?? null,
  }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  // Even counts interpolate; a KD is a score, not a count, so a .5 is meaningful
  // and rounding it here would quietly claim precision in the wrong direction.
  return s.length % 2 === 1 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10
}

/**
 * How many more listings a locality needs before its demand is worth building for.
 *
 * ==================== POLICY, NOT A MEASUREMENT ====================
 * Taken from the operator's own hand-built sheet, which classified a city as
 * `credible` or `thin` and recorded `stays_needed`. It turns the supply model's
 * have/none/unknown into an instruction — "one more listing and this unlocks" is
 * strictly more actionable than "supply gap", and it is a threshold over data the
 * system already holds rather than anything new to fetch.
 *
 * Five is their number, not a derived one, and it sits here so it can be argued
 * with rather than buried in a query.
 * ===================================================================
 */
export const CREDIBLE_SUPPLY_THRESHOLD = 5

export interface SupplyShortfall {
  have: number
  needed: number
  credible: boolean
}

export function supplyShortfall(
  availableItems: number,
  threshold = CREDIBLE_SUPPLY_THRESHOLD,
): SupplyShortfall {
  return {
    have: availableItems,
    needed: Math.max(0, threshold - availableItems),
    credible: availableItems >= threshold,
  }
}
