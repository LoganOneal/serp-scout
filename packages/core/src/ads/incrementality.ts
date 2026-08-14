/**
 * How many of the clicks we buy are clicks we did not already have?
 *
 * ==================== THE TERM THAT DECIDES PAID SEARCH ====================
 * A paid click on a query where we already rank #1 organically is mostly a
 * click we were getting for free. Paying for it does not add revenue, it moves
 * the same revenue from the free column to the paid one.
 *
 * This is not a modelling opinion. It is the single most replicated result in
 * the paid-search literature, and there is a published coefficient for it keyed
 * on exactly the column this tool already stores.
 *
 * Google Research, "Impact of Organic Ranking on Ad Click Incrementality" — a
 * META-ANALYSIS OF 390 SEARCH ADS PAUSE STUDIES, where advertisers switched
 * search ads off and the change in total clicks was measured:
 *
 *     organic rank 1      50% of ad clicks are incremental
 *     organic ranks 2-4   82%
 *     organic rank 5+     96%
 *
 * and, for scale: 81% of ad impressions and 66% of ad clicks occur with NO
 * associated organic result on page one at all.
 *
 * ==================== WHY THIS INVERTS THE INTUITION ====================
 * Read as a cost multiplier: at rank 1 the true cost per INCREMENTAL click is
 * 2x the CPC, so the keyword needs twice the conversion rate to break even. At
 * rank 5+ the multiplier is 1.04 and paid search is nearly pure addition.
 *
 * So the keywords where paid search wastes least are the ones we rank WORST
 * for -- the opposite of "defend your best keywords", and exactly the set the
 * organic model already labels BUILD.
 *
 * ==================== THE TWO ENDS OF THE SAME AXIS ====================
 * Blake, Nosko & Tadelis (2015, Econometrica) turned eBay's ads off and found
 * brand keywords had NO measurable benefit and non-brand average returns were
 * NEGATIVE. Chan et al. (2011) report 89% average incremental clicks across
 * verticals. Those look contradictory and are not: eBay ranked #1 organically
 * for its own brand (the 50% row), while most accounts in the Google programme
 * had no first-page organic result at all (the 96%+ rows).
 *
 * Keying on organic rank is what reconciles them, which is why this function
 * takes a rank rather than returning a global constant.
 * =========================================================================
 *
 * See docs/plan-paid-search.md §0.1 and §7 for the full bibliography.
 */

/** Basis points of ad clicks that are incremental, by our organic rank band. */
export const INCREMENTALITY_BPS = {
  /** Organic rank 1. Half of every paid click is cannibalised from ourselves. */
  rank1: 5_000,
  /** Organic ranks 2-4. */
  rank2to4: 8_200,
  /** Organic rank 5 and worse. */
  rank5plus: 9_600,
  /**
   * No organic presence measured on page one.
   *
   * Treated as the rank-5+ band rather than as 100%. The study reports the 5+
   * band, not a separate "absent" figure, and rounding an unmeasured case UP to
   * the most favourable possible value is the direction of error this whole
   * codebase exists to avoid. 96% is already close to pure addition.
   */
  noOrganic: 9_600,
} as const

export type IncrementalityBand = keyof typeof INCREMENTALITY_BPS

export interface IncrementalityEstimate {
  /** Basis points. 10_000 = every paid click is new. */
  bps: number
  band: IncrementalityBand
  /**
   * Cost multiplier on the CPC to get cost per INCREMENTAL click.
   * 2.0 at rank 1. This is the number that changes decisions.
   */
  costMultiplier: number
  /** Plain-language, for the screen. A disputed row has to be arguable. */
  reason: string
  /**
   * Always true here. Literal rather than boolean so an estimate cannot be
   * constructed that claims to be measured -- same device as DemandEstimate.
   */
  modelled: true
  source: string
}

const SOURCE =
  'Google Research, meta-analysis of 390 Search Ads Pause studies ' +
  '("Impact of Organic Ranking on Ad Click Incrementality")'

/**
 * `organicPosition === null` must mean "we checked and we do not rank", not
 * "nobody looked". The caller proves it with `positionMeasured`, exactly as
 * `assessKeyword` does -- Search Console silence and never having asked Search
 * Console are the same null and completely different facts.
 *
 * Returns null when unmeasured. There is no safe default: guessing high makes
 * every keyword look buyable, and guessing low silently kills the whole feature.
 */
export function estimateIncrementality(args: {
  organicPosition: number | null
  positionMeasured: boolean
}): IncrementalityEstimate | null {
  if (!args.positionMeasured) return null

  const p = args.organicPosition

  if (p === null) {
    return build(
      'noOrganic',
      'No organic result on page one — nearly every paid click is a click we do not already have',
    )
  }
  if (p <= 1) {
    return build(
      'rank1',
      `We rank #${p} organically — about half of every paid click is cannibalised from our own free listing, ` +
        `so an incremental click costs twice the CPC`,
    )
  }
  if (p <= 4) {
    return build('rank2to4', `We rank #${p} organically — most paid clicks are additional, some are not`)
  }
  return build('rank5plus', `We rank #${p} organically — paid clicks are almost entirely additional`)
}

function build(band: IncrementalityBand, reason: string): IncrementalityEstimate {
  const bps = INCREMENTALITY_BPS[band]
  return {
    bps,
    band,
    costMultiplier: 10_000 / bps,
    reason,
    modelled: true,
    source: SOURCE,
  }
}

/**
 * Brand/vendor keywords carry a separate, worse result and it is not captured by
 * organic rank.
 *
 * Blake, Nosko & Tadelis found NO measurable short-term benefit from brand-
 * keyword ads at eBay. Simonov, Nosko & Rao (2018, Marketing Science) measured
 * 1-4% on Bing when no competitor was bidding, SMALLER for larger brands.
 *
 * For `borenhealth.com` this is live: `{vendor} review`, `is {vendor} legit` and
 * `{vendor} coupon code` are all brand queries — for someone else's brand, which
 * is a different case again, but the crowd-out mechanic is the same. Flagged
 * rather than scored, because 1-4% is small enough that the honest output is a
 * warning, not a coefficient.
 */
export function isBrandQuery(keywordNorm: string, brandTerms: string[]): boolean {
  const hay = ` ${keywordNorm} `
  return brandTerms.some((t) => {
    const needle = t.trim().toLowerCase()
    return needle.length > 0 && hay.includes(` ${needle} `)
  })
}
