import type { Micros } from '../money.js'
import { computeBreakEven, type BreakEvenResult, type PaidEconomics } from './breakeven.js'
import { estimateIncrementality, type IncrementalityEstimate } from './incrementality.js'

/**
 * Should we buy Google Ads on this keyword?
 *
 * ==================== A BAR THE OPERATOR SETS, NOT A PREDICTION ====================
 * Every verdict here is a comparison of the REQUIRED conversion rate (see
 * breakeven.ts) against a rate the operator states they actually achieve. The
 * model never claims to know what a keyword will convert at.
 *
 * That framing is what keeps this honest under the literature in
 * docs/plan-paid-search.md §0: predicting paid-search profit from observational
 * data is the thing that reliably produces optimistic, wrong answers.
 * ==================================================================================
 */

export type PaidVerdict =
  /** Required conversion is comfortably below what we achieve. Worth testing. */
  | 'BUY'
  /** Plausible but thin — the margin is inside the noise. Test only with a holdout. */
  | 'MARGINAL'
  /** The arithmetic does not work at any bid we would pay. */
  | 'SKIP'
  /** A structural reason not to bid, independent of the arithmetic. */
  | 'BLOCKED'
  /** A required signal was never measured. Never folded into SKIP. */
  | 'UNKNOWN'

/**
 * How much cheaper than break-even a keyword must be to count as BUY, when the
 * achieved rate arrives as a BARE POINT ESTIMATE.
 *
 * POLICY, not a measurement. 2x is chosen because Lewis & Rao's median ROI
 * confidence interval was over 100 percentage points wide -- a margin thinner
 * than 2x cannot be distinguished from zero by any test we can afford to run,
 * so calling it BUY would claim precision nobody has.
 *
 * ==================== IT IS A BLUNT STAND-IN, AND THERE IS A BETTER ONE ====
 * This constant demands the same 2x headroom from a keyword measured on 40,000
 * clicks as from one measured on 40. That is obviously wrong and it is the best
 * available rule when all you are handed is a number.
 *
 * When the caller supplies `achievedConversionLowerBps` -- a posterior lower
 * credible bound from @rnr/core resolveConversion -- the uncertainty is already
 * priced INTO the input, in proportion to how much data there actually is. The
 * flat multiplier then double-counts it, so the default drops to
 * BUY_MARGIN_WITH_BOUND.
 * =========================================================================
 */
export const DEFAULT_BUY_MARGIN = 2

/**
 * The margin once uncertainty is carried by the input rather than by a constant.
 *
 * 1.0 means "the 10th-percentile of what we believe the rate is must still clear
 * break-even" -- a stricter test than a 2x margin on a well-measured keyword's
 * mean, and a much stricter one on a barely-measured keyword.
 */
export const BUY_MARGIN_WITH_BOUND = 1

export interface PaidVerdictInput {
  keywordNorm: string
  /** Avg monthly searches at the space's audienceScope. Null = unmeasured. */
  volume: number | null
  organicPosition: number | null
  /** Search Console silence and never asking are the same null. See assessKeyword. */
  positionMeasured: boolean
  bidLowMicros: Micros | null
  bidHighMicros: Micros | null
  /**
   * Google returned an AI Overview for this query.
   *
   * Null = the SERP was never bought, which is NOT the same as "no AI Overview".
   */
  hasAiOverview: boolean | null
  economics: PaidEconomics
  /**
   * The conversion rate the operator actually achieves, in bps.
   *
   * MEASURED, from the affiliate network. Null until imported, and null makes
   * every verdict UNKNOWN rather than letting a plausible 2% decide spending.
   */
  achievedConversionBps: number | null
  /**
   * Posterior LOWER CREDIBLE BOUND on the achieved rate, from
   * @rnr/core resolveConversion.
   *
   * When present this is what the decision uses, and the flat buy margin drops
   * to 1.0 — the uncertainty is in the number rather than in a constant beside
   * it. A keyword measured on 40,000 clicks has a bound near its mean and needs
   * almost no headroom; one measured on 40 has a bound far below and must clear
   * break-even by a lot, automatically.
   */
  achievedConversionLowerBps?: number | null
  /** Brand terms to flag. See incrementality.isBrandQuery. */
  brandTerms?: string[]
}

export interface PaidVerdictResult {
  verdict: PaidVerdict
  reason: string
  breakEven: BreakEvenResult
  incrementality: IncrementalityEstimate | null
  /** How many times cheaper than break-even we are. Null when not computable. */
  marginRatio: number | null
  /** Which rate the verdict actually used, and which margin applied. */
  decidedOn: 'lower_bound' | 'point_estimate' | null
  appliedMargin: number | null
  missing: string[]
  warnings: string[]
}

export interface PaidVerdictOptions {
  buyMargin?: number
  /** Below this, a keyword cannot buy enough clicks to learn anything. */
  minMonthlyVolume?: number
}

/**
 * Too few searches to ever resolve whether it worked.
 *
 * Not a demand threshold -- a MEASUREMENT threshold. At a few hundred searches a
 * month, a keyword produces so few clicks that per-keyword conversion is
 * unknowable at any budget (Lewis & Rao). Such keywords can still be bought as
 * part of a themed group; they cannot be evaluated alone.
 */
export const DEFAULT_MIN_MONTHLY_VOLUME = 100

export function assessPaidKeyword(
  input: PaidVerdictInput,
  opts: PaidVerdictOptions = {},
): PaidVerdictResult {
  /**
   * The bound, when we have one, IS the decision input — and it changes the
   * margin, because a flat multiplier on top of an already-conservative bound
   * double-counts the same uncertainty.
   */
  const hasBound = input.achievedConversionLowerBps != null
  const buyMargin = opts.buyMargin ?? (hasBound ? BUY_MARGIN_WITH_BOUND : DEFAULT_BUY_MARGIN)
  const decidedOn: 'lower_bound' | 'point_estimate' = hasBound ? 'lower_bound' : 'point_estimate'
  const minVolume = opts.minMonthlyVolume ?? DEFAULT_MIN_MONTHLY_VOLUME
  const warnings: string[] = []

  const incrementality = estimateIncrementality({
    organicPosition: input.organicPosition,
    positionMeasured: input.positionMeasured,
  })

  const breakEven = computeBreakEven({
    bidLowMicros: input.bidLowMicros,
    bidHighMicros: input.bidHighMicros,
    incrementality,
    economics: input.economics,
  })

  /**
   * ==================== STRUCTURAL BLOCKS COME FIRST ====================
   * These do not depend on the arithmetic, and running the arithmetic first
   * would produce a tidy BUY on a keyword we must not bid on -- which is worse
   * than no answer, because it is actionable.
   */
  if (input.hasAiOverview === true) {
    return {
      verdict: 'BLOCKED',
      reason:
        'Google returns an AI Overview for this query. It pushes ads down and absorbs the ' +
        'informational click. We have no defensible coefficient for how much, so this is a block ' +
        'rather than a discount — see plan-paid-search.md §2.4.',
      breakEven,
      incrementality,
      marginRatio: null,
      decidedOn: null,
      appliedMargin: null,
      missing: [],
      warnings,
    }
  }

  if (input.brandTerms?.length) {
    const hay = ` ${input.keywordNorm} `
    const hit = input.brandTerms.find((t) => hay.includes(` ${t.trim().toLowerCase()} `))
    if (hit) {
      warnings.push(
        `Brand query ("${hit}"). Blake, Nosko & Tadelis measured NO short-term benefit from ` +
          `brand-keyword ads; Simonov et al. measured 1–4% when no competitor is bidding. ` +
          `The organic-rank coefficient does not capture this.`,
      )
    }
  }

  // --- Then the signals the decision genuinely needs. -----------------------
  const missing = [...breakEven.missing]
  if (input.volume === null) missing.push('volume')
  if (input.achievedConversionBps === null) missing.push('achievedConversionBps')

  if (missing.length > 0) {
    return {
      verdict: 'UNKNOWN',
      reason: `Not decidable — never measured: ${missing.join(', ')}`,
      breakEven,
      incrementality,
      marginRatio: null,
      decidedOn: null,
      appliedMargin: null,
      missing,
      warnings,
    }
  }

  const volume = input.volume as number
  if (volume < minVolume) {
    return {
      verdict: 'SKIP',
      reason:
        `${volume}/mo cannot produce enough clicks to tell whether it worked. Buyable inside a ` +
        `themed ad group, not evaluable on its own.`,
      breakEven,
      incrementality,
      marginRatio: null,
      decidedOn: null,
      appliedMargin: null,
      missing: [],
      warnings,
    }
  }

  /**
   * The HIGH end of the bid range, always.
   *
   * The low end is roughly what it costs to lose the auction. Qualifying on it
   * would be the same fabrication the volume cache refuses when it declines to
   * turn a bid range into a CPC.
   */
  const required = breakEven.requiredConversionBpsHigh

  if (required === null || !Number.isFinite(required)) {
    return {
      verdict: 'UNKNOWN',
      reason: 'Break-even could not be computed from the high end of the bid range.',
      breakEven,
      incrementality,
      marginRatio: null,
      decidedOn: null,
      appliedMargin: null,
      missing: ['requiredConversionBpsHigh'],
      warnings,
    }
  }

  /**
   * The bound decides when we have one. `achievedConversionBps` stays in the
   * message so both numbers are visible — an operator comparing a verdict
   * against their dashboard will look for the rate they recognise.
   */
  const point = input.achievedConversionBps as number
  const achieved = hasBound ? (input.achievedConversionLowerBps as number) : point

  const marginRatio = required === 0 ? Number.POSITIVE_INFINITY : achieved / required
  const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`
  const rate = hasBound
    ? `we convert at ${pct(point)} (10th-pct ${pct(achieved)})`
    : `we convert at ${pct(point)}`

  const base = { breakEven, incrementality, marginRatio, decidedOn, appliedMargin: buyMargin }

  if (marginRatio >= buyMargin) {
    return {
      ...base,
      verdict: 'BUY',
      reason:
        `Needs ${pct(required)} to break even; ${rate} — ${marginRatio.toFixed(1)}× the bar. ` +
        `${incrementality!.reason}.`,
      missing: [],
      warnings,
    }
  }

  if (marginRatio >= 1) {
    return {
      ...base,
      verdict: 'MARGINAL',
      reason: hasBound
        ? `Needs ${pct(required)}; ${rate} — the lower bound clears break-even by only ` +
          `${marginRatio.toFixed(1)}×. More data would move this either way.`
        : `Needs ${pct(required)}; ${rate} — only ${marginRatio.toFixed(1)}× the bar. ` +
          `A margin this thin cannot be distinguished from zero by any test we can afford ` +
          `(Lewis & Rao 2015). Run it only inside a holdout.`,
      missing: [],
      warnings,
    }
  }

  return {
    ...base,
    verdict: 'SKIP',
    reason:
      `Needs ${pct(required)} to break even; ${rate}. ` +
      `${hasBound ? 'The lower bound does not clear it. ' : ''}${incrementality!.reason}.`,
    missing: [],
    warnings,
  }
}
