import { describe, expect, it } from 'vitest'
import { clusterKeywords, workflowsCompatible } from './clustering.js'
import { extractConcepts } from './concepts.js'
import { underwrite } from './economics.js'
import { expansionPriorityScore } from './expansion.js'
import { evaluateGarbage } from './garbage.js'
import { inferBuyerType, inferWillingnessToPay, scoreMarket, type ScoreInput } from './scoring.js'
import { TARGET_CAC_SHARE } from './economics.js'

function baseScore(over: Partial<ScoreInput> & Pick<ScoreInput, 'garbage'>): ScoreInput {
  return {
    adjustedVolume: 10_000,
    weightedCpc: 3,
    weightedKd: 40,
    medianKd: 38,
    commercialVolumeShare: 0.5,
    highIntentVolumeShare: 0.3,
    uniqueAdvertisers: 3,
    persistentAdvertisers: 2,
    observedPriceCount: 0,
    observedMedianPrice: null,
    cpcCoverageBase: 1.2,
    cpcCoverageBear: 0.7,
    gpLtvBase: 400,
    recurringUsage: 3,
    willingnessToPay: 3,
    expansionPotential: 3,
    serpWeakness: 3,
    competitorAuthority: 35,
    growth12m: 0.1,
    buildComplexity: 2,
    buyerType: 'prosumer',
    ...over,
  }
}

describe('underwrite', () => {
  it('computes GP-LTV, allowable CAC, sustainable CPC, and coverage', () => {
    const r = underwrite({
      monthlyPrice: { bear: 50, base: 99, bull: 149 },
      lifetimeMonths: { bear: 8, base: 14, bull: 24 },
      grossMargin: { bear: 0.7, base: 0.8, bull: 0.85 },
      clickToPaid: { bear: 0.01, base: 0.025, bull: 0.04 },
      targetCacShare: TARGET_CAC_SHARE,
      observedWeightedCpc: 7.41,
    })
    expect(r.grossProfitLtv.base).toBeCloseTo(99 * 14 * 0.8, 5)
    expect(r.allowableCac.base).toBeCloseTo(99 * 14 * 0.8 * 0.3, 5)
    expect(r.sustainableCpc.base).toBeCloseTo(99 * 14 * 0.8 * 0.3 * 0.025, 5)
    expect(r.cpcCoverage.base).toBeCloseTo((99 * 14 * 0.8 * 0.3 * 0.025) / 7.41, 5)
  })
})

describe('example markets A/B/C', () => {
  const baby = scoreMarket(
    baseScore({
      adjustedVolume: 90_000,
      weightedCpc: 1.2,
      weightedKd: 22,
      medianKd: 20,
      commercialVolumeShare: 0.25,
      uniqueAdvertisers: 1,
      persistentAdvertisers: 0,
      cpcCoverageBase: 0.4,
      cpcCoverageBear: 0.15,
      gpLtvBase: 18,
      recurringUsage: 1,
      willingnessToPay: 1,
      expansionPotential: 1,
      buyerType: 'consumer',
      buildComplexity: 1,
      garbage: {
        keywords: ['ai baby name generator', 'baby name generator', 'unique baby names'],
        brandedShare: 0,
        uniqueAdvertisers: 1,
        observedPriceCount: 0,
        weightedCpc: 1.2,
        majorPlatformOwned: false,
      },
    }),
  )

  const roofing = scoreMarket(
    baseScore({
      adjustedVolume: 18_000,
      weightedCpc: 7.4,
      weightedKd: 36,
      medianKd: 34,
      commercialVolumeShare: 0.82,
      highIntentVolumeShare: 0.55,
      uniqueAdvertisers: 8,
      persistentAdvertisers: 6,
      observedPriceCount: 4,
      observedMedianPrice: 99,
      cpcCoverageBase: 1.7,
      cpcCoverageBear: 0.9,
      gpLtvBase: 842,
      recurringUsage: 5,
      willingnessToPay: 5,
      expansionPotential: 5,
      serpWeakness: 4.1,
      competitorAuthority: 24,
      growth12m: 0.28,
      buildComplexity: 3,
      buyerType: 'SMB',
      garbage: {
        keywords: ['roofing estimating software', 'roofing proposal generator', 'roofing estimate app'],
        brandedShare: 0.05,
        uniqueAdvertisers: 8,
        observedPriceCount: 4,
        weightedCpc: 7.4,
        majorPlatformOwned: false,
      },
    }),
  )

  const headshot = scoreMarket(
    baseScore({
      adjustedVolume: 70_000,
      weightedCpc: 5.5,
      weightedKd: 48,
      medianKd: 50,
      commercialVolumeShare: 0.7,
      uniqueAdvertisers: 9,
      persistentAdvertisers: 5,
      observedPriceCount: 3,
      observedMedianPrice: 29,
      cpcCoverageBase: 0.85,
      cpcCoverageBear: 0.35,
      gpLtvBase: 28,
      recurringUsage: 2,
      willingnessToPay: 3,
      expansionPotential: 2,
      serpWeakness: 2.1,
      competitorAuthority: 55,
      buildComplexity: 2,
      buyerType: 'prosumer',
      garbage: {
        keywords: ['ai headshot generator', 'professional headshot ai'],
        brandedShare: 0.1,
        uniqueAdvertisers: 9,
        observedPriceCount: 3,
        weightedCpc: 5.5,
        majorPlatformOwned: false,
      },
    }),
  )

  it('scores roofing estimating far above baby-name novelty', () => {
    expect(roofing.totalScore).toBeGreaterThan(baby.totalScore + 15)
    expect(roofing.recurringUsageScore).toBeGreaterThan(baby.recurringUsageScore)
    expect(roofing.monetizationEvidenceScore).toBeGreaterThan(baby.monetizationEvidenceScore)
  })

  it('treats headshots as commercially real but not a subscription goldmine', () => {
    expect(headshot.monetizationEvidenceScore).toBeGreaterThan(baby.monetizationEvidenceScore)
    expect(headshot.recurringUsageScore).toBeLessThan(roofing.recurringUsageScore)
    expect(headshot.totalScore).toBeGreaterThan(baby.totalScore)
    expect(headshot.totalScore).toBeLessThan(roofing.totalScore)
  })
})

describe('clustering', () => {
  it('does not dump contractor CRM and estimating into one market', () => {
    expect(workflowsCompatible('crm', 'estimating')).toBe(false)
    const clusters = clusterKeywords([
      { id: 1, keyword: 'roofing estimating software', volume: 2400, domains: ['jobnimbus.com'] },
      { id: 2, keyword: 'roofing proposal generator', volume: 880, domains: ['jobnimbus.com'] },
      { id: 3, keyword: 'contractor crm', volume: 5400, domains: ['jobber.com'] },
      { id: 4, keyword: 'contractor payroll software', volume: 1600, domains: ['gusto.com'] },
    ])
    const roofing = clusters.find((c) => c.keywordIds.includes(1) && c.keywordIds.includes(2))
    expect(roofing).toBeTruthy()
    expect(roofing!.keywordIds).not.toContain(3)
    expect(roofing!.keywordIds).not.toContain(4)
  })

  it('keeps AI interior visualization keywords together', () => {
    const clusters = clusterKeywords([
      { id: 1, keyword: 'ai interior design', volume: 12000, domains: [] },
      { id: 2, keyword: 'ai room designer', volume: 8000, domains: [] },
      { id: 3, keyword: 'ai home design', volume: 6000, domains: [] },
    ])
    const joined = clusters.find((c) => c.keywordIds.includes(1))
    expect(joined?.keywordIds.length).toBeGreaterThanOrEqual(2)
  })
})

describe('concepts', () => {
  it('extracts a roofing proposal generator', () => {
    const c = extractConcepts('AI proposal generator for roofing contractors')
    expect(c.productArchetype).toBe('generator')
    expect(c.industry).toBe('roofing')
    expect(c.persona).toMatch(/roofing|contractor/)
    expect(c.commercialIntent).toBeGreaterThanOrEqual(4)
    expect(c.recurringUsageLikelihood).toBeGreaterThanOrEqual(4)
  })
})

describe('expansion and garbage', () => {
  it('prioritizes commercial product-shaped keywords', () => {
    const high = expansionPriorityScore({
      keyword: 'roofing estimating software',
      volume: 2400,
      cpc: 8,
      intent: 'commercial',
      hasAdvertisers: true,
      growing: true,
      semanticallyNovel: true,
      depth: 1,
    })
    const low = expansionPriorityScore({
      keyword: 'what is a roof',
      volume: 40_000,
      cpc: 0.1,
      intent: 'informational',
      hasAdvertisers: false,
      growing: false,
      semanticallyNovel: false,
      depth: 1,
    })
    expect(high).toBeGreaterThan(low)
  })

  it('penalizes piracy and celebrity clusters', () => {
    const g = evaluateGarbage({
      keywords: ['photoshop crack', 'adobe photoshop nulled'],
      brandedShare: 0.2,
      uniqueAdvertisers: 0,
      observedPriceCount: 0,
      weightedCpc: 0.2,
      majorPlatformOwned: false,
    })
    expect(g.reject).toBe(true)
    expect(g.scoreMultiplier).toBeLessThan(0.3)
  })
})

describe('buyer inference', () => {
  it('classifies roofing as SMB with high WTP', () => {
    const buyer = inferBuyerType({
      industry: 'roofing',
      persona: 'roofing contractor',
      archetype: 'software',
      keywords: ['roofing estimating software'],
    })
    expect(buyer).toBe('SMB')
    expect(
      inferWillingnessToPay({
        buyer,
        recurring: 5,
        weightedCpc: 7,
        observedMedianPrice: 99,
        workflow: 'estimating',
      }),
    ).toBeGreaterThanOrEqual(4)
  })
})
