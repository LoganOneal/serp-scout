import type { Micros } from '../money.js'

/**
 * How would we know whether the ads worked?
 *
 * ==================== DESIGNED BEFORE LAUNCH, NOT AFTER ====================
 * The temptation after a campaign runs is to read last-click conversions from
 * the affiliate network and declare a winner. Gordon, Zettelmeyer, Bhargava &
 * Chapsky (2019, Marketing Science) is the direct rebuttal: across 15 Facebook
 * RCTs -- 500m user-experiment observations, 1.6bn impressions -- NO
 * observational approach reliably recovered the experimental lift.
 *
 * Worse, last-click is the metric most biased toward paid search specifically:
 * it credits the ad for the click it cannibalised from our own organic listing,
 * which is exactly the quantity incrementality.ts exists to discount.
 *
 * ==================== THE RANDOMISATION UNIT IS ALREADY IN THE DATA ========
 * Geo experiments (Vaver & Koehler 2011, Google) randomise non-overlapping
 * regions into treatment and control. The usual hard part is finding enough
 * independent units.
 *
 * `hotelhottubs.com` has ~195 of them BY CONSTRUCTION. Its keyword space is
 * destination x pattern, and destinations are naturally disjoint: somebody
 * searching for a Gatlinburg hotel is not substituting to the Las Vegas
 * listing. So we randomise DESTINATIONS, not searcher geography -- no geo
 * targeting required -- and compare total affiliate revenue per destination,
 * paid AND organic together.
 *
 * Measuring the total is the point. A design that measured only paid revenue
 * would score cannibalised clicks as wins.
 * =========================================================================
 *
 * See docs/plan-paid-search.md §6.
 */

export interface ClusterAssignment {
  /** The entity slug -- a destination for hotelhottubs. */
  cluster: string
  arm: 'treatment' | 'control'
}

/**
 * Deterministic split. `random` is injected for the same reason as in budget.ts:
 * this package is pure and tested, and an assignment nobody can reproduce is an
 * assignment nobody can audit six weeks later when the result is disputed.
 */
export function assignClusters(
  clusters: string[],
  opts: { treatmentShare?: number; random?: () => number } = {},
): ClusterAssignment[] {
  const share = opts.treatmentShare ?? 0.5
  const random = opts.random ?? (() => 0.5)

  /**
   * Shuffled, then split by position -- NOT a per-cluster coin flip.
   *
   * Independent flips give a binomially-varying arm size; on 195 clusters that
   * is routinely a 10-cluster imbalance, which costs power for no reason.
   */
  const shuffled = [...clusters]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = shuffled[i]!
    shuffled[i] = shuffled[j]!
    shuffled[j] = a
  }
  const cut = Math.round(shuffled.length * share)
  return shuffled.map((cluster, i) => ({
    cluster,
    arm: i < cut ? ('treatment' as const) : ('control' as const),
  }))
}

export interface PowerInput {
  /** Conversion rate we believe we have, in bps. The null hypothesis centre. */
  baselineConversionBps: number
  /** Smallest RELATIVE lift worth detecting, e.g. 0.20 for +20%. */
  minDetectableRelativeLift: number
  /** Two-sided significance. 0.05 conventional. */
  alpha?: number
  /** 1 - type II error. 0.80 conventional. */
  power?: number
}

export interface PowerResult {
  /** Clicks needed PER ARM. */
  clicksPerArm: number
  clicksTotal: number
  /** Absolute conversion-rate difference being detected, in bps. */
  detectableDifferenceBps: number
}

/**
 * Two-proportion sample size.
 *
 *     n = (z_{1-a/2} + z_{1-b})^2 · (p1(1-p1) + p2(1-p2)) / (p1-p2)^2
 *
 * Conversion is a RARE event, so `p(1-p)` stays near `p` and the required n
 * scales roughly as 1/p. That is the arithmetic behind Lewis & Rao's finding
 * that informative advertising experiments can need more than ten million
 * person-weeks -- it is not a quirk of their data, it falls out of the formula.
 */
export function requiredClicks(input: PowerInput): PowerResult {
  const alpha = input.alpha ?? 0.05
  const power = input.power ?? 0.8
  const p1 = input.baselineConversionBps / 10_000
  const p2 = p1 * (1 + input.minDetectableRelativeLift)

  const zAlpha = normalQuantile(1 - alpha / 2)
  const zBeta = normalQuantile(power)
  const diff = p2 - p1

  if (diff <= 0 || p1 <= 0) {
    return { clicksPerArm: Number.POSITIVE_INFINITY, clicksTotal: Number.POSITIVE_INFINITY, detectableDifferenceBps: 0 }
  }

  const n = ((zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (diff * diff)
  const perArm = Math.ceil(n)
  return {
    clicksPerArm: perArm,
    clicksTotal: perArm * 2,
    detectableDifferenceBps: Math.round(diff * 10_000),
  }
}

export interface FeasibilityInput extends PowerInput {
  /** Clicks per day the treatment arm can actually buy. */
  dailyClicksAvailable: number
  cpcMicros: Micros
  /** How long we are willing to run. */
  maxDays: number
  budgetMicros: Micros
}

export interface FeasibilityResult {
  feasible: boolean
  required: PowerResult
  daysNeeded: number
  costMicros: Micros
  /** The honest sentence. Non-empty when infeasible. */
  verdict: string
}

/**
 * Can this test answer the question, at this budget, in this time?
 *
 * ==================== "NO" IS THE MOST VALUABLE OUTPUT HERE ====================
 * A test too small to conclude is WORSE than no test, because it still returns a
 * number and the number gets acted on. Lewis & Rao's median ROI confidence
 * interval was over 100 percentage points wide across 25 real experiments -- the
 * default outcome of an underpowered ad test is a confident, wrong answer.
 *
 * So this is computed BEFORE spending, and an infeasible design is reported as
 * infeasible rather than run at whatever size the budget allows.
 * ============================================================================
 */
export function assessFeasibility(input: FeasibilityInput): FeasibilityResult {
  const required = requiredClicks(input)

  if (!Number.isFinite(required.clicksPerArm)) {
    return {
      feasible: false,
      required,
      daysNeeded: Number.POSITIVE_INFINITY,
      costMicros: 0n,
      verdict: 'Not computable: baseline conversion or minimum detectable lift is non-positive.',
    }
  }

  const daysNeeded =
    input.dailyClicksAvailable <= 0
      ? Number.POSITIVE_INFINITY
      : Math.ceil(required.clicksPerArm / input.dailyClicksAvailable)
  const costMicros = BigInt(required.clicksPerArm) * input.cpcMicros

  if (!Number.isFinite(daysNeeded)) {
    return {
      feasible: false,
      required,
      daysNeeded,
      costMicros,
      verdict: 'No clicks are available to buy — the treatment arm cannot be filled.',
    }
  }

  if (daysNeeded > input.maxDays) {
    return {
      feasible: false,
      required,
      daysNeeded,
      costMicros,
      verdict:
        `Needs ${required.clicksPerArm.toLocaleString()} clicks per arm — ${daysNeeded} days at ` +
        `${input.dailyClicksAvailable}/day, against a ${input.maxDays}-day limit. ` +
        `Running it shorter does not produce a smaller answer, it produces a wrong one.`,
    }
  }

  if (costMicros > input.budgetMicros) {
    return {
      feasible: false,
      required,
      daysNeeded,
      costMicros,
      verdict:
        `Needs ${required.clicksPerArm.toLocaleString()} clicks in the treatment arm, which costs more ` +
        `than the budget allows. An underpowered test returns a number that will be acted on — ` +
        `raise the budget, widen the minimum detectable lift, or do not run it.`,
    }
  }

  return {
    feasible: true,
    required,
    daysNeeded,
    costMicros,
    verdict:
      `${required.clicksPerArm.toLocaleString()} clicks per arm over ${daysNeeded} days detects a ` +
      `${(input.minDetectableRelativeLift * 100).toFixed(0)}% relative lift at ` +
      `${((1 - (input.alpha ?? 0.05)) * 100).toFixed(0)}% confidence.`,
  }
}

/**
 * Acklam's inverse normal CDF. Absolute error < 1.15e-9 — far beyond what a
 * sample-size calculation needs, and it removes a dependency.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) return Number.NaN
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  )
}
