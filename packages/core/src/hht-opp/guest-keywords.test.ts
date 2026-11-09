import { describe, expect, it } from 'vitest'
import {
  isExplicitContributionUrl,
  isGuestRoundupUrl,
  isTravelGuestPostKeyword,
  pickGuestPostIdeas,
  HHT_OPP_GUEST_SEED_KEYWORDS,
} from './guest-keywords.js'
import { isGuestFrontierKeyword } from './guest-frontier.js'

describe('travel guest-post keywords', () => {
  it('defaults to the latest twelve topical seeds', () => {
    expect(HHT_OPP_GUEST_SEED_KEYWORDS).toHaveLength(12)
    expect(HHT_OPP_GUEST_SEED_KEYWORDS.every(isGuestFrontierKeyword)).toBe(true)
  })
  it('keeps travel phrases that ask for a guest post', () => {
    expect(isTravelGuestPostKeyword('luxury travel write for us')).toBe(true)
    expect(isTravelGuestPostKeyword('hotel blogs that accept guest posts')).toBe(true)
  })

  it('drops phrases that are not both travel and a guest-post ask', () => {
    expect(isTravelGuestPostKeyword('food write for us')).toBe(false)
    expect(isTravelGuestPostKeyword('romantic hotels california')).toBe(false)
    expect(isTravelGuestPostKeyword('buy travel backlinks')).toBe(false)
  })

  it('tells a publisher guideline URL from a roundup', () => {
    expect(isExplicitContributionUrl('https://example.com/write-for-us')).toBe(true)
    expect(isExplicitContributionUrl('https://example.com/guest-post-guidelines')).toBe(true)
    expect(isExplicitContributionUrl('https://example.com/')).toBe(false)
    expect(isGuestRoundupUrl('https://example.com/blogs-that-accept-guest-posts')).toBe(true)
    expect(isGuestRoundupUrl('https://example.com/write-for-us')).toBe(false)
  })

  it('picks new Google Ads ideas and skips duplicates and zero volume', () => {
    const picked = pickGuestPostIdeas({
      alreadySearched: ['packing list for europe'],
      limit: 2,
      ideas: [
        { keyword: 'travel write for us', avgMonthlySearches: 90, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'cruise write for us', avgMonthlySearches: 40, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'honeymoon guest post', avgMonthlySearches: 0, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'food guest post', avgMonthlySearches: 500, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'hotel guest posting sites', avgMonthlySearches: 70, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'packing list for europe', avgMonthlySearches: 100, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'packing list for japan', avgMonthlySearches: 90, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'romantic weekend getaways', avgMonthlySearches: 70, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'staycation ideas', avgMonthlySearches: 0, volumeLow: null, volumeHigh: null, volumeIsRange: false },
      ],
    })
    expect(picked).toEqual(['packing list for japan', 'romantic weekend getaways'])
  })
})