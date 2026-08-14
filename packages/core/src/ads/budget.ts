import type { Micros } from '../money.js'

/**
 * Where does a fixed daily budget go?
 *
 * ==================== BID WIDER, NOT DEEPER ====================
 * The intuitive allocation -- pour the budget into the single best-scoring
 * keyword -- is the wrong shape, and there is a derivation for why.
 *
 * Zhang, Yuan & Wang (2014, KDD, "Optimal Real-Time Bidding for Display
 * Advertising") solve budget-constrained bidding and find the optimum is to bid
 * on MORE impressions rather than concentrate on a small set of high-valued
 * ones: lower-valued inventory is more cost-effective per unit and easier to
 * win, so a concentrated budget buys fewer conversions than a spread one.
 *
 * ==================== AND SPEND TO LEARN, NOT ONLY TO EARN ====================
 * Every keyword's conversion rate here is UNMEASURED. Allocating purely by
 * expected value would pour the budget into whichever keyword the prior happens
 * to favour and never find out about the others -- and per Lewis & Rao the prior
 * is not accurate enough to justify that.
 *
 * So a share of the budget is explicitly reserved for exploration, allocated by
 * Thompson sampling (Chapelle & Li 2011, NIPS): draw from each keyword's
 * posterior and spend on the draw's winner. It naturally sends budget to
 * keywords that are UNCERTAIN rather than merely estimated-high, which is the
 * behaviour we want when nothing has been measured yet.
 * ============================================================================
 *
 * See docs/plan-paid-search.md §4.
 */

export interface AllocationCandidate {
  keywordNorm: string
  /** Estimated clicks per day this keyword can absorb. */
  dailyClickCapacity: number
  /** What one click costs. High end of the bid range, per breakeven.ts. */
  cpcMicros: Micros
  /**
   * How far above break-even we expect to be. `assessPaidKeyword.marginRatio`.
   * Higher is better; 1.0 is break-even.
   */
  marginRatio: number
  /**
   * Prior strength for exploration. Clicks already bought on this keyword.
   * Zero means nothing is known and it is a pure exploration candidate.
   */
  observedClicks: number
  observedConversions: number
}

export interface Allocation {
  keywordNorm: string
  /** Clicks per day this keyword is allocated. */
  clicks: number
  budgetMicros: Micros
  /** Which pot this came from. Reported so the split stays visible. */
  pot: 'exploit' | 'explore'
}

export interface AllocationResult {
  allocations: Allocation[]
  spentMicros: Micros
  unspentMicros: Micros
  exploreMicros: Micros
  exploitMicros: Micros
  notes: string[]
}

/**
 * Share of the daily budget reserved for keywords we know nothing about.
 *
 * POLICY. 30% is a starting position, not a measurement -- stated so nobody
 * reads it as one. It matters most on day one, when EVERY keyword is unmeasured
 * and the exploit pot is being allocated on a prior rather than on data.
 */
export const DEFAULT_EXPLORE_SHARE = 0.3

export interface AllocateOptions {
  exploreShare?: number
  /** Per-keyword daily ceiling, so one keyword cannot absorb the whole budget. */
  maxPerKeywordMicros?: Micros | null
  /**
   * Deterministic draws for the exploration pot.
   *
   * Thompson sampling needs randomness, and this package is pure and tested --
   * `Math.random()` would make the allocation untestable and unreproducible.
   * The caller supplies the source, so a run can be replayed exactly.
   */
  random?: () => number
}

/**
 * Split a daily budget across keywords.
 *
 * Exploit pot: proportional to `marginRatio × capacity`, capped per keyword, so
 * it spreads across everything above break-even rather than concentrating --
 * the Zhang et al. result.
 *
 * Explore pot: Thompson-sampled over Beta posteriors on the conversion rate.
 */
export function allocateBudget(
  candidates: AllocationCandidate[],
  dailyBudgetMicros: Micros,
  opts: AllocateOptions = {},
): AllocationResult {
  const notes: string[] = []
  const exploreShare = opts.exploreShare ?? DEFAULT_EXPLORE_SHARE
  const random = opts.random ?? (() => 0.5)

  if (candidates.length === 0 || dailyBudgetMicros <= 0n) {
    return {
      allocations: [],
      spentMicros: 0n,
      unspentMicros: dailyBudgetMicros,
      exploreMicros: 0n,
      exploitMicros: 0n,
      notes: ['No candidates, or no budget.'],
    }
  }

  const exploreMicros = (dailyBudgetMicros * BigInt(Math.round(exploreShare * 10_000))) / 10_000n
  const exploitMicros = dailyBudgetMicros - exploreMicros

  const viable = candidates.filter((c) => c.marginRatio >= 1 && c.cpcMicros > 0n)
  if (viable.length === 0) {
    notes.push(
      'No candidate is above break-even. The exploit pot is unallocated — a budget spread across ' +
        'keywords that all lose money loses money faster.',
    )
  }

  const byKeyword = new Map<string, Allocation>()
  const cap = opts.maxPerKeywordMicros ?? null

  // --- Exploit: proportional to margin × capacity, spread not concentrated ---
  const weights = viable.map((c) => ({
    c,
    w: Math.max(0, (c.marginRatio - 1) * c.dailyClickCapacity),
  }))
  const totalWeight = weights.reduce((a, b) => a + b.w, 0)

  if (totalWeight > 0) {
    for (const { c, w } of weights) {
      if (w <= 0) continue
      let micros = (exploitMicros * BigInt(Math.round((w / totalWeight) * 1_000_000))) / 1_000_000n
      if (cap !== null && micros > cap) micros = cap
      const clicks = Number(micros / c.cpcMicros)
      const capped = Math.min(clicks, c.dailyClickCapacity)
      if (capped <= 0) continue
      byKeyword.set(c.keywordNorm, {
        keywordNorm: c.keywordNorm,
        clicks: capped,
        budgetMicros: BigInt(Math.round(capped)) * c.cpcMicros,
        pot: 'exploit',
      })
    }
  }

  // --- Explore: Thompson sampling over Beta(1+conv, 1+clicks-conv) ----------
  /**
   * Beta(1,1) for an untouched keyword — a uniform prior, i.e. "we know
   * nothing", which is the truth on day one. It is deliberately NOT an
   * informative prior centred on some plausible rate: that would encode a guess
   * about conversion, which is the one thing this whole design refuses to do.
   */
  let exploreLeft = exploreMicros
  const exploreOrder = [...candidates]
    .map((c) => ({
      c,
      draw: sampleBeta(1 + c.observedConversions, 1 + Math.max(0, c.observedClicks - c.observedConversions), random),
    }))
    .sort((a, b) => b.draw - a.draw)

  for (const { c } of exploreOrder) {
    if (exploreLeft < c.cpcMicros) break
    const wanted = cap === null ? exploreLeft : cap < exploreLeft ? cap : exploreLeft
    const clicks = Math.min(Number(wanted / c.cpcMicros), c.dailyClickCapacity)
    if (clicks <= 0) continue
    const micros = BigInt(Math.round(clicks)) * c.cpcMicros
    const existing = byKeyword.get(c.keywordNorm)
    if (existing) {
      existing.clicks += clicks
      existing.budgetMicros += micros
    } else {
      byKeyword.set(c.keywordNorm, {
        keywordNorm: c.keywordNorm,
        clicks,
        budgetMicros: micros,
        pot: 'explore',
      })
    }
    exploreLeft -= micros
  }

  const allocations = [...byKeyword.values()].sort((a, b) => Number(b.budgetMicros - a.budgetMicros))
  const spentMicros = allocations.reduce((a, b) => a + b.budgetMicros, 0n)

  if (allocations.length === 1 && candidates.length > 1) {
    notes.push(
      'The whole budget landed on one keyword. Zhang et al. (2014) find concentrating a constrained ' +
        'budget buys fewer conversions than spreading it — set maxPerKeywordMicros.',
    )
  }

  return {
    allocations,
    spentMicros,
    unspentMicros: dailyBudgetMicros - spentMicros,
    exploreMicros,
    exploitMicros,
    notes,
  }
}

/**
 * Beta draw via two Gammas. Marsaglia-Tsang for shape >= 1, boosted below.
 *
 * Written out rather than pulled in, because @rnr/core has ZERO runtime
 * dependencies by policy and that boundary is load-bearing (it is what makes
 * this package safe to import from a client component).
 */
export function sampleBeta(alpha: number, beta: number, random: () => number): number {
  const x = sampleGamma(alpha, random)
  const y = sampleGamma(beta, random)
  const total = x + y
  return total === 0 ? 0.5 : x / total
}

function sampleGamma(shape: number, random: () => number): number {
  if (shape <= 0) return 0
  if (shape < 1) {
    // Johnk/boosting: Gamma(a) = Gamma(a+1) · U^(1/a)
    const u = Math.max(random(), Number.EPSILON)
    return sampleGamma(shape + 1, random) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (let i = 0; i < 1000; i++) {
    const z = normal(random)
    const v = Math.pow(1 + c * z, 3)
    if (v <= 0) continue
    const u = Math.max(random(), Number.EPSILON)
    if (Math.log(u) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v
  }
  // Bounded rather than unbounded: a hung loop in a budget allocator is worse
  // than a slightly-off draw.
  return d
}

function normal(random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON)
  const u2 = random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}
