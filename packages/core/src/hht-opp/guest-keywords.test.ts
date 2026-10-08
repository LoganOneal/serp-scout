import { describe, expect, it } from 'vitest'
import {
  isExplicitContributionUrl,
  isGuestRoundupUrl,
  isTravelGuestPostKeyword,
  pickGuestPostIdeas,
} from './guest-keywords.js'

describe('travel guest-post keywords', () => {
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
      alreadySearched: ['best travel write for us'],
      limit: 2,
      ideas: [
        { keyword: 'travel write for us', avgMonthlySearches: 90, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'cruise write for us', avgMonthlySearches: 40, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'honeymoon guest post', avgMonthlySearches: 0, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'food guest post', avgMonthlySearches: 500, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'hotel guest posting sites', avgMonthlySearches: 70, volumeLow: null, volumeHigh: null, volumeIsRange: false },
      ],
    })
    expect(picked).toEqual(['hotel guest posting sites', 'cruise write for us'])
  })
})