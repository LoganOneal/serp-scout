/**
 * Turning a handful of clicks into a number you can spend against.
 *
 * ==================== THE LEADERBOARD OF NOISE ====================
 * Per-keyword conversion is a rare event on a small sample. Estimate each
 * keyword independently and the ranking is dominated by accident: the keyword
 * with 1 order in 3 clicks tops the list at 33%, and the one with 300 orders in
 * 12,000 clicks sits below it at 2.5%.
 *
 * Agarwal, Broder, Chakrabarti et al. (2007, 2010) is the standard treatment —
 * estimate at a level where data is stable and use it as a PRIOR to shrink the
 * finer level. The keyword grid supplies that hierarchy for free: every keyword
 * already carries a `pattern_label`, and every pattern belongs to a site.
 *
 *     prior      Beta(p0·m, (1-p0)·m)      p0 = parent rate, m = prior strength
 *     posterior  Beta(p0·m + k, (1-p0)·m + n - k)
 *     shrunk     (k + p0·m) / (n + m)
 *
 * `m` is "how many of our own clicks before we stop trusting the parent". At
 * n << m the estimate is the parent's; at n >> m it is the keyword's own.
 *
 * ==================== AND WHY THE MEAN IS NOT THE ANSWER ====================
 * A go/no-go on spending should not use the posterior MEAN. Lewis & Rao (2015)
 * measured a median ROI confidence interval over 100 percentage points wide
 * across 25 real experiments; the mean of a wide posterior is a number that
 * happens to sit in the middle of an interval containing both "excellent" and
 * "ruinous".
 *
 * So `lowerBound` is the decision input. A keyword measured on 40,000 clicks
 * has a bound close to its mean and needs little headroom; one measured on 40
 * has a bound far below and must clear break-even by a lot -- automatically,
 * and in proportion to how little we know.
 *
 * That is the principled version of `DEFAULT_BUY_MARGIN = 2`, which demands the
 * same 2x from both.
 * =========================================================================
 *
 * See docs/plan-affiliate-economics.md §3.
 */

/**
 * Clicks of our own data before the parent stops dominating.
 *
 * POLICY, not a measurement, and stated as such. 200 is chosen so that a
 * keyword with a few hundred clicks is still mostly explained by its pattern,
 * which is the regime nearly every keyword lives in. `estimatePriorStrength`
 * replaces it with a data-driven value once there are enough siblings.
 */
export const DEFAULT_PRIOR_STRENGTH = 200

/**
 * Which tail we plan against. 10th percentile of the posterior.
 *
 * POLICY. Lower is more conservative; 0.10 leaves a 1-in-10 chance the true
 * rate is worse than the number we planned with. Named rather than buried
 * because it is the single knob controlling how much thin data is distrusted.
 */
export const DEFAULT_LOWER_QUANTILE = 0.1

export interface Observation {
  clicks: number
  orders: number
}

export interface ShrunkRate {
  /** Posterior mean. For display. */
  meanBps: number
  /** Posterior lower credible bound. THE DECISION INPUT. */
  lowerBps: number
  /** Unshrunk k/n. Shown beside the shrunk value so the shrinkage is visible. */
  rawBps: number | null
  clicks: number
  orders: number
  /** Prior strength actually used, in click-equivalents. */
  priorStrength: number
  /** Parent rate shrunk toward. */
  priorBps: number
  /**
   * How much of the estimate is our own data: n / (n + m).
   * 0.02 means "this is 98% the parent's number wearing this keyword's name".
   */
  ownDataWeight: number
}

/**
 * Shrink one observation toward a parent rate.
 *
 * `clicks: 0` is legitimate and returns the parent rate with `ownDataWeight: 0`
 * -- which is the honest answer for a keyword nobody has measured, and is very
 * different from returning null. Null is reserved for "there is no parent rate
 * either", i.e. nothing anywhere has been measured.
 */
export function shrinkRate(args: {
  observation: Observation
  /** Parent rate in bps. Null when no parent has data — then this returns null. */
  priorBps: number | null
  priorStrength?: number
  lowerQuantile?: number
}): ShrunkRate | null {
  if (args.priorBps === null) return null

  const m = args.priorStrength ?? DEFAULT_PRIOR_STRENGTH
  const q = args.lowerQuantile ?? DEFAULT_LOWER_QUANTILE
  const n = Math.max(0, Math.trunc(args.observation.clicks))
  const k = Math.max(0, Math.min(n, Math.trunc(args.observation.orders)))
  const p0 = clamp(args.priorBps / 10_000, 1e-6, 1 - 1e-6)

  const alpha = p0 * m + k
  const beta = (1 - p0) * m + (n - k)

  const mean = alpha / (alpha + beta)
  const lower = betaQuantile(q, alpha, beta)

  return {
    meanBps: Math.round(mean * 10_000),
    lowerBps: Math.round(lower * 10_000),
    rawBps: n > 0 ? Math.round((k / n) * 10_000) : null,
    clicks: n,
    orders: k,
    priorStrength: m,
    priorBps: args.priorBps,
    ownDataWeight: n + m === 0 ? 0 : n / (n + m),
  }
}

/**
 * Prior strength from the spread across siblings (method of moments).
 *
 * If sibling rates cluster tightly, the parent explains them well and the prior
 * deserves to be strong. If they are all over the place, it does not, and each
 * child should be trusted sooner.
 *
 * Returns null with fewer than 3 siblings carrying data — with two points the
 * "spread" is noise, and a prior strength derived from noise is worse than a
 * documented constant.
 */
export function estimatePriorStrength(siblings: Observation[]): number | null {
  const usable = siblings.filter((s) => s.clicks > 0)
  if (usable.length < 3) return null

  const totalClicks = usable.reduce((a, b) => a + b.clicks, 0)
  const totalOrders = usable.reduce((a, b) => a + b.orders, 0)
  if (totalClicks === 0) return null

  const pBar = totalOrders / totalClicks
  if (pBar <= 0 || pBar >= 1) return null

  const rates = usable.map((s) => s.orders / s.clicks)
  const observedVar = variance(rates)
  /** Variance you would see from sampling noise alone, at these sample sizes. */
  const binomialVar =
    usable.reduce((a, s) => a + (pBar * (1 - pBar)) / s.clicks, 0) / usable.length
  const trueVar = observedVar - binomialVar

  /**
   * All the spread is explained by sampling noise, so the siblings are
   * indistinguishable and the prior should be very strong. Capped rather than
   * infinite: an unbounded prior means a child's own data never matters.
   */
  if (trueVar <= 0) return 10_000

  const m = (pBar * (1 - pBar)) / trueVar - 1
  if (!Number.isFinite(m) || m <= 0) return DEFAULT_PRIOR_STRENGTH
  return clamp(m, 1, 10_000)
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

// --- Beta distribution, hand-rolled ------------------------------------------
//
// @rnr/core has ZERO runtime dependencies by policy, and that boundary is what
// makes the package safe to import from a client component. The same reasoning
// already produced Acklam's inverse normal CDF in ads/experiment.ts and a
// Marsaglia-Tsang gamma sampler in ads/budget.ts.
//
// A normal approximation was considered and rejected: it is worst exactly where
// this is used most -- small k and n, where the Beta posterior is strongly
// skewed and a symmetric interval puts the lower bound below zero.

/** Lanczos approximation, g=7, n=9. Standard coefficients. */
export function lnGamma(x: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    // Reflection, so the series is only ever evaluated where it converges well.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  }
  const z = x - 1
  let a = c[0]!
  const t = z + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i]! / (z + i)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Continued fraction for the incomplete beta (Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 300
  const EPS = 3e-14
  const TINY = 1e-300

  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d

  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/** Regularized incomplete beta, I_x(a,b) — the Beta CDF. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  )
  // The fraction converges fast only for x < (a+1)/(a+b+2); use the symmetry
  // relation on the other side.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b
}

/**
 * Inverse Beta CDF by bisection.
 *
 * Bisection rather than Newton: it cannot diverge, 200 iterations reach machine
 * precision on [0,1], and this runs once per keyword rather than in a loop that
 * matters. A quantile that occasionally fails to converge would be a silent
 * wrong number in a spending decision.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  if (a <= 0 || b <= 0) return Number.NaN

  let lo = 0
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (betaCdf(mid, a, b) < p) lo = mid
    else hi = mid
    if (hi - lo < 1e-12) break
  }
  return (lo + hi) / 2
}
