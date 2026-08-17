import { describe, expect, it } from 'vitest'
import { parseHhtBlLinkAnalysis, parseHhtBlSiteClassification } from './types.js'

const valid = {
  mechanism: 'tourism_board_resource',
  mechanismConfidence: 0.91,
  editorial: true,
  likelyPaid: false,
  replicable: true,
  replicabilityScore: 86,
  hotelHotTubsRelevance: 92,
  requiresNewAsset: false,
  requiredAssetType: null,
  likelyContactRole: 'destination content editor',
  recommendedAction: 'Pitch the matching destination page.',
  facts: ['The page labels the section lodging resources.'],
  inferences: ['The editor may accept comparable independent guides.'],
  evidence: ['Lodging resources'],
}

describe('HHT link analysis schema', () => {
  it('accepts controlled, evidence-bearing output', () => {
    expect(parseHhtBlLinkAnalysis(valid)).toEqual(valid)
  })

  it('rejects invented mechanism names and out-of-range scores', () => {
    expect(() => parseHhtBlLinkAnalysis({ ...valid, mechanism: 'clever_new_thing' })).toThrow(
      /unknown acquisition mechanism/,
    )
    expect(() => parseHhtBlLinkAnalysis({ ...valid, mechanismConfidence: 1.2 })).toThrow(/0 to 1/)
  })
})

describe('HHT site classification schema', () => {
  it('requires controlled types and measured 0-100 components', () => {
    const classification = {
      siteType: 'independent_affiliate_publisher',
      businessModel: 'affiliate',
      contentModel: 'destination hotel guides',
      affiliateLikely: true,
      directoryLikely: true,
      programmaticSeoLikely: false,
      hotelInventory: true,
      editorialContent: true,
      geographicLandingPages: true,
      brandDependency: 20,
      travelRelevance: 95,
      hhtSimilarity: 88,
      transferability: 92,
      reasoning: 'The sampled pages are destination hotel directories with affiliate links.',
      evidence: ['The Chicago page lists independently operated hotels.'],
    }
    expect(parseHhtBlSiteClassification(classification)).toEqual(classification)
    expect(() => parseHhtBlSiteClassification({ ...classification, siteType: 'seo_site' })).toThrow(
      /unknown site type/,
    )
  })
})
