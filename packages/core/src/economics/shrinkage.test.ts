import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRIOR_STRENGTH,
  betaCdf,
  betaQuantile,
  estimatePriorStrength,
  lnGamma,
  shrinkRate,
} from './shrinkage.js'

describe('the Beta machinery', () => {
  it('lnGamma matches known factorials', () => {
    expect(Math.exp(lnGamma(5))).toBeCloseTo(24, 6) // 4!
    expect(Math.exp(lnGamma(1))).toBeCloseTo(1, 9)
    expect(Math.exp(lnGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 9)
  })

  it('betaCdf(x, 1, 1) is the uniform CDF', () => {
    expect(betaCdf(0.25, 1, 1)).toBeCloseTo(0.25, 9)
    expect(betaCdf(0.75, 1, 1)).toBeCloseTo(0.75, 9)
  })

  it('betaCdf is symmetric for equal parameters', () => {
    expect(betaCdf(0.5, 3, 3)).toBeCloseTo(0.5, 9)
  })

  it('betaQuantile inverts betaCdf', () => {
    for (const [a, b] of [
      [2, 5],
      [10, 300],
      [0.5, 0.5],
      [50, 50],
    ] as const) {
      for (const p of [0.05, 0.1, 0.5, 0.9]) {
        expect(betaCdf(betaQuantile(p, a, b), a, b)).toBeCloseTo(p, 6)
      }
    }
  })

  /**
   * The regime this is used in: small k, small n, strongly skewed posterior. A
   * normal approximation puts the lower bound below zero here, which is why one
   * was rejected.
   */
  it('stays inside [0,1] on a tiny, skewed sample', () => {
    const q = betaQuantile(0.1, 1.2, 40)
    expect(q).toBeGreaterThan(0)
    expect(q).toBeLessThan(1)
  })
})

describe('shrinkRate', () => {
  /** Site converts at 3%. */
  const PRIOR = 300

  it('a keyword with no clicks of its own IS the parent rate', () => {
    const r = shrinkRate({ observation: { clicks: 0, orders: 0 }, priorBps: PRIOR })!
    expect(r.meanBps).toBe(PRIOR)
    expect(r.ownDataWeight).toBe(0)
    expect(r.rawBps).toBeNull()
  })

  /**
   * The leaderboard-of-noise case, and the reason this module exists: 1 order in
   * 3 clicks is a raw 33% and must not be allowed anywhere near a ranking.
   */
  it('crushes a 1-in-3 fluke back toward the parent', () => {
    const r = shrinkRate({ observation: { clicks: 3, orders: 1 }, priorBps: PRIOR })!
    expect(r.rawBps).toBe(3333)
    expect(r.meanBps).toBeLessThan(500)
    expect(r.ownDataWeight).toBeLessThan(0.02)
  })

  it('lets a well-measured keyword speak for itself', () => {
    const r = shrinkRate({ observation: { clicks: 40_000, orders: 4_000 }, priorBps: PRIOR })!
    expect(r.rawBps).toBe(1000)
    expect(r.meanBps).toBeGreaterThan(950)
    expect(r.ownDataWeight).toBeGreaterThan(0.99)
  })

  it('returns null only when nothing anywhere has been measured', () => {
    expect(shrinkRate({ observation: { clicks: 500, orders: 20 }, priorBps: null })).toBeNull()
  })
})

describe('the lower bound is what makes thin data safe', () => {
  const PRIOR = 300

  it('is always below the mean', () => {
    for (const n of [10, 100, 1_000, 40_000]) {
      const r = shrinkRate({ observation: { clicks: n, orders: Math.round(n * 0.05) }, priorBps: PRIOR })!
      expect(r.lowerBps).toBeLessThan(r.meanBps)
    }
  })

  /**
   * THE POINT OF THE WHOLE MODULE. A flat 2x buy margin demands the same
   * headroom from both of these; the bound demands far more from the thin one,
   * automatically and in proportion.
   */
  it('sits far below the mean on thin data and close to it on thick data', () => {
    const thin = shrinkRate({ observation: { clicks: 40, orders: 4 }, priorBps: PRIOR })!
    const thick = shrinkRate({ observation: { clicks: 40_000, orders: 4_000 }, priorBps: PRIOR })!

    const thinGap = (thin.meanBps - thin.lowerBps) / thin.meanBps
    const thickGap = (thick.meanBps - thick.lowerBps) / thick.meanBps

    expect(thinGap).toBeGreaterThan(thickGap * 5)
    expect(thickGap).toBeLessThan(0.05)
  })

  it('never goes negative, however extreme the sample', () => {
    const r = shrinkRate({ observation: { clicks: 1, orders: 0 }, priorBps: 10 })!
    expect(r.lowerBps).toBeGreaterThanOrEqual(0)
  })
})

describe('estimatePriorStrength', () => {
  it('refuses fewer than 3 siblings with data — two points give noise, not spread', () => {
    expect(
      estimatePriorStrength([
        { clicks: 100, orders: 3 },
        { clicks: 100, orders: 5 },
      ]),
    ).toBeNull()
  })

  it('returns a strong prior when siblings are indistinguishable', () => {
    const siblings = Array.from({ length: 6 }, () => ({ clicks: 1_000, orders: 30 }))
    expect(estimatePriorStrength(siblings)!).toBeGreaterThan(DEFAULT_PRIOR_STRENGTH)
  })

  it('returns a weak prior when siblings genuinely differ', () => {
    const siblings = [
      { clicks: 5_000, orders: 50 },
      { clicks: 5_000, orders: 500 },
      { clicks: 5_000, orders: 100 },
      { clicks: 5_000, orders: 400 },
    ]
    const m = estimatePriorStrength(siblings)!
    expect(m).toBeLessThan(DEFAULT_PRIOR_STRENGTH)
  })

  it('ignores siblings with no clicks rather than counting them as zeros', () => {
    expect(
      estimatePriorStrength([
        { clicks: 0, orders: 0 },
        { clicks: 0, orders: 0 },
        { clicks: 100, orders: 3 },
      ]),
    ).toBeNull()
  })
})
