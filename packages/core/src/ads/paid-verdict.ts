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
 * How much cheaper than break-even a keyword must be to count as BUY.
 *
 * POLICY, not a measurement. 2x is a starting position chosen because Lewis &
 * Rao's median ROI confidence interval was over 100 percentage points wide --
 * a margin thinner than 2x cannot be distinguished from zero by any test we can
 * afford to run, so calling it BUY would be claiming precision nobody has.
 *
 * Required as an option rather than buried as a constant, so it never reads as
 * evidence.
 */
export const DEFAULT_BUY_MARGIN = 2

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
  const buyMargin = opts.buyMargin ?? DEFAULT_BUY_MARGIN
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
  const achieved = input.achievedConversionBps as number

  if (required === null || !Number.isFinite(required)) {
    return {
      verdict: 'UNKNOWN',
      reason: 'Break-even could not be computed from the high end of the bid range.',
      breakEven,
      incrementality,
      marginRatio: null,
      missing: ['requiredConversionBpsHigh'],
      warnings,
    }
  }

  const marginRatio = required === 0 ? Number.POSITIVE_INFINITY : achieved / required
  const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`

  if (marginRatio >= buyMargin) {
    return {
      verdict: 'BUY',
      reason:
        `Needs ${pct(required)} to break even; we convert at ${pct(achieved)} — ` +
        `${marginRatio.toFixed(1)}× the bar. ${incrementality!.reason}.`,
      breakEven,
      incrementality,
      marginRatio,
      missing: [],
      warnings,
    }
  }

  if (marginRatio >= 1) {
    return {
      verdict: 'MARGINAL',
      reason:
        `Needs ${pct(required)}; we convert at ${pct(achieved)} — only ${marginRatio.toFixed(1)}× the bar. ` +
        `A margin this thin cannot be distinguished from zero by any test we can afford ` +
        `(Lewis & Rao 2015). Run it only inside a holdout.`,
      breakEven,
      incrementality,
      marginRatio,
      missing: [],
      warnings,
    }
  }

  return {
    verdict: 'SKIP',
    reason:
      `Needs ${pct(required)} to break even; we convert at ${pct(achieved)}. ` +
      `${incrementality!.reason}.`,
    breakEven,
    incrementality,
    marginRatio,
    missing: [],
    warnings,
  }
}
