import { describe, expect, it } from 'vitest'
import { scoreHhtBlOpportunity, scoreHhtBlResearchValue } from './scoring.js'

describe('HHT backlink scoring', () => {
  it('keeps research components and penalties auditable', () => {
    const result = scoreHhtBlResearchValue({
      targetSerpVisibility: 80,
      transferability: 90,
      seoEfficiency: 70,
      businessModelSimilarity: 85,
      backlinkProfileTractability: 60,
      penalties: { major_brand: 15 },
    })
    expect(result.unpenalizedScore).toBeCloseTo(79.25)
    expect(result.score).toBeCloseTo(64.25)
    expect(result.penalties).toEqual({ major_brand: 15 })
  })

  it('uses effort inversely without hiding the four component scores', () => {
    const easy = scoreHhtBlOpportunity({
      linkValue: 80,
      gettability: 70,
      transferability: 90,
      effort: 20,
    })
    const hard = scoreHhtBlOpportunity({
      linkValue: 80,
      gettability: 70,
      transferability: 90,
      effort: 90,
    })
    expect(easy.overallScore).toBeGreaterThan(hard.overallScore)
    expect(easy.expectedValue).toBeGreaterThan(hard.expectedValue)
    expect(easy.linkValue).toBe(80)
  })
})

