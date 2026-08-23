import { describe, expect, it } from 'vitest'
import {
  dedupeHhtBlOpportunitiesBySource,
  HHT_BL_SITEWIDE_LINK_VALUE_PENALTY,
  hhtBlOpportunityAuthority,
  hhtBlOpportunityExclusionReason,
} from './scoring.js'

describe('HHT opportunity quality gates', () => {
  it('requires an explicit follow link, a replicable mechanism, relevance, and authority', () => {
    const eligible = { follow: true, replicable: true, relevance: 70, authority: 35 }
    expect(hhtBlOpportunityExclusionReason(eligible, 20)).toBeNull()
    expect(hhtBlOpportunityExclusionReason({ ...eligible, follow: false }, 20)).toBe('not_follow')
    expect(hhtBlOpportunityExclusionReason({ ...eligible, replicable: false }, 20)).toBe(
      'not_replicable',
    )
    expect(hhtBlOpportunityExclusionReason({ ...eligible, relevance: 39 }, 20)).toBe(
      'low_relevance',
    )
    expect(hhtBlOpportunityExclusionReason({ ...eligible, authority: 19 }, 20)).toBe(
      'low_authority',
    )
  })

  it('keeps one highest-scoring opportunity per source page and research site', () => {
    expect(
      dedupeHhtBlOpportunitiesBySource([
        { id: 1, sourceUrl: 'https://example.com/page', researchSiteId: 1, overallScore: 60 },
        { id: 2, sourceUrl: 'https://example.com/page', researchSiteId: 1, overallScore: 75 },
        { id: 3, sourceUrl: 'https://example.com/page', researchSiteId: 2, overallScore: 65 },
      ]).map((row) => row.id),
    ).toEqual([2, 3])
  })

  it('applies a meaningful sitewide-link penalty', () => {
    expect(HHT_BL_SITEWIDE_LINK_VALUE_PENALTY).toBe(15)
  })

  it('uses page authority for user-controlled shared platforms', () => {
    expect(
      hhtBlOpportunityAuthority({
        sourceDomain: 'pinterest.com',
        pageAuthority: 22,
        referringDomainAuthority: 100,
      }),
    ).toBe(22)
    expect(
      hhtBlOpportunityAuthority({
        sourceDomain: 'theguardian.com',
        pageAuthority: 35,
        referringDomainAuthority: 100,
      }),
    ).toBe(100)
  })
})
