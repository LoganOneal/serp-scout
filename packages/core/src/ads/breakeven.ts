import type { Micros } from '../money.js'
import type { IncrementalityEstimate } from './incrementality.js'

/**
 * What would this keyword have to convert at, to be worth buying?
 *
 * ==================== WHY THIS INSTEAD OF A PROFIT PREDICTION ====================
 * Predicting profit needs a conversion rate. We have never measured one, and the
 * literature says that even after spending real money the estimate will not be
 * decision-grade:
 *
 *   Lewis & Rao (2015, QJE), across 25 field experiments and $2.8m of spend:
 *   THE MEDIAN CONFIDENCE INTERVAL ON ROI WAS OVER 100 PERCENTAGE POINTS WIDE.
 *   Individual sales have a coefficient of variation around 10, so informative
 *   experiments can need more than ten million person-weeks.
 *
 *   Gordon et al. (2019, Marketing Science), 15 Facebook RCTs over 500m
 *   observations: no observational method reliably recovered the experimental
 *   lift.
 *
 * So a predicted ROAS here would be a fabricated number in a column an operator
 * reads as measured -- the exact failure this repo's first rule exists to stop.
 *
 * Invert it instead. Everything EXCEPT conversion is known or bounded, so solve
 * for conversion:
 *
 *       profit = n · i · (v · m · r)  −  n · c
 *
 *   where n clicks are all paid for, but only i·n are incremental (see
 *   incrementality.ts). Setting profit = 0:
 *
 *                     c
 *       r*  =  ─────────────────
 *                i  ·  v  ·  m
 *
 * `r*` has NO unmeasured input. It is computable today for every keyword, it
 * sorts the list, and an operator can compare it against a conversion rate they
 * already read off their affiliate dashboard. That comparison is a judgement
 * they are qualified to make; a predicted ROAS is not.
 * ================================================================================
 *
 * See docs/plan-paid-search.md §2.
 */

export interface PaidEconomics {
  /** Operator input. What a referred purchase is worth. */
  orderValueMicros: Micros | null
  /** Operator input. Basis points; 1000 = 10%. */
  commissionRateBps: number | null
}

export interface BreakEvenInput {
  /**
   * Google's published top-of-page bid range. NOT a CPC.
   *
   * Deliberately two numbers. `keyword-volume-cache.ts` refuses to derive a
   * single CPC from this range and it is right to: measured against cached
   * DataForSEO rows, cpc/high ran 0.07x-1.16x and cpc/low 0.79x-2.59x. Any
   * single derived figure would be an invention.
   */
  bidLowMicros: Micros | null
  bidHighMicros: Micros | null
  incrementality: IncrementalityEstimate | null
  economics: PaidEconomics
}

export interface BreakEvenResult {
  /** Basis points of clicks that must convert, at the LOW end of the bid range. */
  requiredConversionBpsLow: number | null
  /** ...and at the HIGH end. This is the one a decision must clear. */
  requiredConversionBpsHigh: number | null
  /** CPC × incrementality cost multiplier, at the high end. What a new click costs. */
  costPerIncrementalClickMicros: Micros | null
  /** Revenue from one converting incremental click. */
  valuePerConversionMicros: Micros | null
  /** Inputs that were null. Non-empty means every rate above is null. */
  missing: string[]
  /** Terms that are modelled rather than measured, for the on-screen banner. */
  modelled: string[]
}

/**
 * Basis points, integer arithmetic throughout.
 *
 * Percentages are stored as bps for the same reason money is stored as micros:
 * a float conversion rate compared against a float threshold drifts, and this
 * number gates spending.
 */
export function computeBreakEven(input: BreakEvenInput): BreakEvenResult {
  const missing: string[] = []
  if (input.economics.orderValueMicros === null) missing.push('orderValueMicros')
  if (input.economics.commissionRateBps === null) missing.push('commissionRateBps')
  if (input.bidHighMicros === null) missing.push('bidHighMicros')
  if (input.incrementality === null) missing.push('incrementality (organic position unmeasured)')

  const modelled = input.incrementality ? ['incrementality'] : []

  if (missing.length > 0) {
    return {
      requiredConversionBpsLow: null,
      requiredConversionBpsHigh: null,
      costPerIncrementalClickMicros: null,
      valuePerConversionMicros: null,
      missing,
      modelled,
    }
  }

  const orderValue = input.economics.orderValueMicros as Micros
  const commissionBps = input.economics.commissionRateBps as number
  const incBps = BigInt(input.incrementality!.bps)

  /** Revenue from one conversion: order value × commission. */
  const valuePerConversionMicros = (orderValue * BigInt(commissionBps)) / 10_000n

  if (valuePerConversionMicros <= 0n) {
    return {
      requiredConversionBpsLow: null,
      requiredConversionBpsHigh: null,
      costPerIncrementalClickMicros: null,
      valuePerConversionMicros,
      missing: ['valuePerConversionMicros is zero — a conversion is worth nothing'],
      modelled,
    }
  }

  /**
   * r* = c / (i · v · m), expressed in bps.
   *
   *   requiredBps = 10_000 · c / (i · valuePerConversion)
   *
   * with `i` itself in bps, so the 10_000s cancel once:
   *
   *   requiredBps = 10_000 · 10_000 · c / (incBps · valuePerConversion)
   */
  const required = (cpc: Micros): number => {
    const numerator = 100_000_000n * cpc
    const denominator = incBps * valuePerConversionMicros
    if (denominator === 0n) return Number.POSITIVE_INFINITY
    return Number(numerator / denominator)
  }

  const high = input.bidHighMicros as Micros
  const low = input.bidLowMicros ?? high

  return {
    requiredConversionBpsLow: required(low),
    requiredConversionBpsHigh: required(high),
    // The honest cost of a NEW click, which is what the CPC is not.
    costPerIncrementalClickMicros: (high * 10_000n) / incBps,
    valuePerConversionMicros,
    missing: [],
    modelled,
  }
}

/**
 * The sentence that must appear beside any of these numbers.
 *
 * Generated next to the model rather than written into a component, so it
 * cannot drift away from what the code actually computes -- same device as
 * `affiliateValueDisclosure`.
 */
export function breakEvenDisclosure(r: BreakEvenResult): string {
  if (r.missing.length > 0) {
    return `Not computable: ${r.missing.join(', ')} unset. No paid-search decision can be made from this row.`
  }
  return (
    'This is the conversion rate required to BREAK EVEN, not a prediction of profit. ' +
    'Incrementality is a published coefficient from 390 Search Ads Pause studies, not our measurement. ' +
    'Order value and commission are operator inputs. The high end of Google’s bid range is used, ' +
    'because the low end is what it costs to lose the auction.'
  )
}

/** Display helper. 1250 bps → "12.50%". Never fed back into arithmetic. */
export function formatBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '—'
  return `${(bps / 100).toFixed(2)}%`
}
