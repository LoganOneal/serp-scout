import { describe, expect, it } from 'vitest'
import { assessFeasibility, assignClusters, normalQuantile, requiredClicks } from './experiment.js'
import { allocateBudget, type AllocationCandidate } from './budget.js'

/** Deterministic source, so an allocation or assignment can be replayed exactly. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('cluster assignment', () => {
  const destinations = Array.from({ length: 195 }, (_, i) => `dest-${i}`)

  it('splits evenly by position, not by independent coin flips', () => {
    const a = assignClusters(destinations, { random: lcg(7) })
    const treatment = a.filter((x) => x.arm === 'treatment').length
    expect(treatment).toBe(98)
    expect(a.length - treatment).toBe(97)
  })

  it('is reproducible from the same seed — a disputed result must be auditable', () => {
    const a = assignClusters(destinations, { random: lcg(7) })
    const b = assignClusters(destinations, { random: lcg(7) })
    expect(a).toEqual(b)
  })

  it('assigns every cluster exactly once', () => {
    const a = assignClusters(destinations, { random: lcg(3) })
    expect(new Set(a.map((x) => x.cluster)).size).toBe(195)
  })
})

describe('power — the Lewis & Rao arithmetic', () => {
  it('detecting a 20% lift on a 3% baseline needs thousands of clicks per arm', () => {
    const r = requiredClicks({ baselineConversionBps: 300, minDetectableRelativeLift: 0.2 })
    expect(r.clicksPerArm).toBeGreaterThan(10_000)
  })

  it('rarer conversion needs more data — n scales roughly as 1/p', () => {
    const common = requiredClicks({ baselineConversionBps: 1000, minDetectableRelativeLift: 0.2 })
    const rare = requiredClicks({ baselineConversionBps: 100, minDetectableRelativeLift: 0.2 })
    expect(rare.clicksPerArm).toBeGreaterThan(common.clicksPerArm * 5)
  })

  it('a bigger detectable lift needs less data', () => {
    const small = requiredClicks({ baselineConversionBps: 300, minDetectableRelativeLift: 0.1 })
    const big = requiredClicks({ baselineConversionBps: 300, minDetectableRelativeLift: 0.5 })
    expect(big.clicksPerArm).toBeLessThan(small.clicksPerArm)
  })

  it('normalQuantile matches the conventional z values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.96, 2)
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416, 3)
  })
})

describe('feasibility — "no" is the valuable answer', () => {
  const base = {
    baselineConversionBps: 300,
    minDetectableRelativeLift: 0.2,
    dailyClicksAvailable: 50,
    cpcMicros: 1_200_000n,
    maxDays: 30,
    budgetMicros: 5_000_000_000n, // $5,000
  }

  it('refuses a test that cannot finish in the window, and says why', () => {
    const r = assessFeasibility(base)
    expect(r.feasible).toBe(false)
    expect(r.verdict).toMatch(/does not produce a smaller answer, it produces a wrong one/)
  })

  it('refuses a test that costs more than the budget', () => {
    const r = assessFeasibility({ ...base, dailyClicksAvailable: 5000, budgetMicros: 100_000_000n })
    expect(r.feasible).toBe(false)
    expect(r.verdict).toMatch(/underpowered test returns a number that will be acted on/)
  })

  it('passes a test that genuinely resolves the question', () => {
    const r = assessFeasibility({
      ...base,
      minDetectableRelativeLift: 1.0,
      dailyClicksAvailable: 2000,
      maxDays: 60,
      budgetMicros: 50_000_000_000n,
    })
    expect(r.feasible).toBe(true)
    expect(r.verdict).toMatch(/detects a 100% relative lift/)
  })

  it('reports infeasible rather than dividing by zero when no clicks exist', () => {
    const r = assessFeasibility({ ...base, dailyClicksAvailable: 0 })
    expect(r.feasible).toBe(false)
    expect(r.verdict).toMatch(/cannot be filled/)
  })
})

describe('budget allocation', () => {
  const candidates: AllocationCandidate[] = [
    { keywordNorm: 'a', dailyClickCapacity: 100, cpcMicros: 1_000_000n, marginRatio: 3, observedClicks: 0, observedConversions: 0 },
    { keywordNorm: 'b', dailyClickCapacity: 100, cpcMicros: 1_000_000n, marginRatio: 2, observedClicks: 0, observedConversions: 0 },
    { keywordNorm: 'c', dailyClickCapacity: 100, cpcMicros: 1_000_000n, marginRatio: 1.5, observedClicks: 0, observedConversions: 0 },
  ]

  it('spreads across viable keywords rather than concentrating (Zhang et al.)', () => {
    const r = allocateBudget(candidates, 100_000_000n, { random: lcg(11) })
    expect(r.allocations.length).toBeGreaterThan(1)
  })

  it('reserves a share for exploration', () => {
    const r = allocateBudget(candidates, 100_000_000n, { random: lcg(11), exploreShare: 0.3 })
    expect(r.exploreMicros).toBe(30_000_000n)
    expect(r.exploitMicros).toBe(70_000_000n)
  })

  it('does NOT allocate the exploit pot when nothing clears break-even', () => {
    const losing = candidates.map((c) => ({ ...c, marginRatio: 0.5 }))
    const r = allocateBudget(losing, 100_000_000n, { random: lcg(5) })
    expect(r.allocations.every((a) => a.pot === 'explore')).toBe(true)
    expect(r.notes.join(' ')).toMatch(/loses money faster/)
  })

  it('never exceeds the budget', () => {
    const r = allocateBudget(candidates, 10_000_000n, { random: lcg(2) })
    expect(r.spentMicros).toBeLessThanOrEqual(10_000_000n)
  })

  it('is reproducible from a seed', () => {
    const a = allocateBudget(candidates, 100_000_000n, { random: lcg(42) })
    const b = allocateBudget(candidates, 100_000_000n, { random: lcg(42) })
    expect(a.allocations).toEqual(b.allocations)
  })

  it('handles an empty candidate list without spending', () => {
    const r = allocateBudget([], 100_000_000n, { random: lcg(1) })
    expect(r.spentMicros).toBe(0n)
    expect(r.unspentMicros).toBe(100_000_000n)
  })
})
