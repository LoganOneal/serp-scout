/**
 * What one affiliate keyword is worth per month.
 *
 * ==================== TWO OF THREE INPUTS ARE NOT MODELLED ====================
 * Local lead-gen value is derived: `avgTicketMicros x leadCommissionRateBps`,
 * both priors on the niche row, both calibratable from `lead_outcomes`.
 *
 * Affiliate value is not derivable from anything this tool can buy. Order value
 * and commission rate are FACTS THE OPERATOR SUPPLIES, and conversion rate is a
 * MEASUREMENT FROM THE AFFILIATE NETWORK that we do not yet import. A hotel
 * booking and a peptide order differ by an order of magnitude in every term.
 *
 * So this function refuses rather than guesses. A missing conversion rate does
 * NOT become "2%, which is typical" — it returns null and the keyword sorts with
 * the unknowns. That is the repo's first rule applied to money: an unmeasured
 * conversion rate must not read as a good one.
 * ============================================================================
 */

import type { Micros } from '../money.js'

/**
 * Organic CTR by position. MODELLED — a published industry curve, not our data.
 *
 * Labelled as modelled wherever it surfaces. It is the least wrong term here
 * (the shape of the curve is stable across studies even where the levels are
 * not) and it is still not a measurement of this site.
 */
const CTR_BY_POSITION: readonly number[] = [
  0.0, // index 0 unused — positions are 1-based
  0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.033, 0.028, 0.025,
]

/** Below the top 10 the curve is flat and small; one number is honest enough. */
const CTR_BELOW_TEN = 0.01

/** The position a BUILD is being justified against. Modelled, and stated. */
export const DEFAULT_TARGET_POSITION = 5

export function ctrAtPosition(position: number): number {
  if (!Number.isFinite(position) || position < 1) return 0
  const p = Math.trunc(position)
  if (p >= CTR_BY_POSITION.length) return CTR_BELOW_TEN
  return CTR_BY_POSITION[p] ?? CTR_BELOW_TEN
}

export interface AffiliateEconomics {
  /** Operator input. What the referred purchase is worth, in micros. */
  orderValueMicros: Micros | null
  /** Operator input. Basis points — 1000 = 10%. */
  commissionRateBps: number | null
  /**
   * MEASURED from the affiliate network. Basis points of clicks that convert.
   *
   * Null until network data is imported. Never defaulted — see the banner.
   */
  conversionRateBps: number | null
}

export interface AffiliateValueInput {
  /** Avg monthly searches at the space's audienceScope. Null = unmeasured. */
  volume: number | null
  /** Where we rank now, or null if we do not. */
  position: number | null
  /** Position the estimate is computed against when we do not yet rank. */
  targetPosition?: number
  economics: AffiliateEconomics
}

export interface AffiliateValueResult {
  /** Null whenever any required input was unmeasured. Never a fallback number. */
  monthlyValueMicros: Micros | null
  /** Value of one click, for display beside the monthly figure. */
  valuePerClickMicros: Micros | null
  estimatedMonthlyClicks: number | null
  /** Which inputs were null. Non-empty implies a null value. */
  missing: string[]
  /** Terms that are modelled rather than measured, for the on-screen banner. */
  modelled: string[]
}

/**
 * Value per click = order value x commission x conversion.
 *
 * Kept separate because it is the number an operator can sanity-check against
 * their own network dashboard, and a monthly figure that is wrong by 10x is
 * much harder to spot than a per-click one.
 */
export function valuePerClickMicros(e: AffiliateEconomics): Micros | null {
  if (e.orderValueMicros === null || e.commissionRateBps === null || e.conversionRateBps === null) {
    return null
  }
  // Integer micros throughout — bps are per 10,000, applied twice.
  return (e.orderValueMicros * BigInt(e.commissionRateBps) * BigInt(e.conversionRateBps)) / 100_000_000n
}

export function estimateAffiliateValue(input: AffiliateValueInput): AffiliateValueResult {
  const missing: string[] = []
  if (input.volume === null) missing.push('volume')
  if (input.economics.orderValueMicros === null) missing.push('orderValueMicros')
  if (input.economics.commissionRateBps === null) missing.push('commissionRateBps')
  if (input.economics.conversionRateBps === null) missing.push('conversionRateBps')

  const modelled = ['ctrAtPosition']
  if (input.position === null) modelled.push('targetPosition')

  const perClick = valuePerClickMicros(input.economics)

  if (missing.length > 0 || perClick === null || input.volume === null) {
    return {
      monthlyValueMicros: null,
      valuePerClickMicros: perClick,
      estimatedMonthlyClicks: null,
      missing,
      modelled,
    }
  }

  const position = input.position ?? input.targetPosition ?? DEFAULT_TARGET_POSITION
  const clicks = input.volume * ctrAtPosition(position)

  return {
    monthlyValueMicros: (BigInt(Math.round(clicks * 1_000_000)) * perClick) / 1_000_000n,
    valuePerClickMicros: perClick,
    estimatedMonthlyClicks: Math.round(clicks),
    missing: [],
    modelled,
  }
}

/**
 * The sentence that has to appear on any screen showing these numbers.
 *
 * The README's rule is "say what is modelled" as an on-screen banner, not a
 * docstring — so the banner text is generated here, beside the model, rather
 * than written into a component where it can drift away from what the code does.
 */
export function affiliateValueDisclosure(e: AffiliateEconomics): string {
  const unset: string[] = []
  if (e.orderValueMicros === null) unset.push('order value')
  if (e.commissionRateBps === null) unset.push('commission rate')
  if (e.conversionRateBps === null) unset.push('conversion rate')

  if (unset.length > 0) {
    return `Value is not modelled for this site: ${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} unset. Keywords are ranked on demand and difficulty only.`
  }
  return (
    'Value = volume x modelled CTR x order value x commission x conversion. ' +
    'Order value and commission are operator inputs; conversion is measured from the affiliate network; ' +
    'CTR is a published curve, not this site’s data.'
  )
}
