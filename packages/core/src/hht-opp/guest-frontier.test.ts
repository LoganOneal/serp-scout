import { describe, expect, it } from 'vitest'
import {
  guestContactMethod,
  guestKeywordFetchDecision,
  guestSerpNeighborhood,
  isGuestFrontierKeyword,
  maxSerpResultOverlap,
  selectGuestFrontierIdeas,
  serpResultKey,
} from './guest-frontier.js'

describe('guest keyword frontier', () => {
  const fetched = [
    { keyword: 'travel write for us', neighborhood: 'saturated' as const },
    { keyword: 'best hotels in charleston', neighborhood: 'productive' as const },
  ]

  it('keeps travel queries and drops product queries', () => {
    expect(isGuestFrontierKeyword('things to do in asheville')).toBe(true)
    expect(isGuestFrontierKeyword('romantic hotels in napa')).toBe(true)
    expect(isGuestFrontierKeyword('hot tub repair near me')).toBe(false)
    expect(isGuestFrontierKeyword('travel')).toBe(false)
  })

  it('skips a reordered duplicate before spending a Semrush call', () => {
    const decision = guestKeywordFetchDecision('write for us travel', fetched)
    expect(decision).toMatchObject({ fetch: false, reason: 'near_duplicate', matched: 'travel write for us' })
  })

  it('skips a close variant once that neighborhood SERP is used up', () => {
    const decision = guestKeywordFetchDecision('family travel write for us', fetched)
    expect(decision).toMatchObject({ fetch: false, reason: 'neighborhood_saturated' })
  })

  it('still fetches a close variant of a productive SERP', () => {
    const decision = guestKeywordFetchDecision('romantic hotels in charleston', fetched)
    expect(decision).toEqual({ fetch: true })
  })

  it('fetches a keyword whose SERP is not the same neighborhood', () => {
    expect(guestKeywordFetchDecision('honeymoon itinerary italy', fetched)).toEqual({ fetch: true })
  })

  it('treats half-overlapping result URLs as a used-up SERP', () => {
    const mine = ['a', 'b', 'c', 'd']
    const overlap = maxSerpResultOverlap(mine, [['a', 'b', 'c', 'e']])
    expect(overlap).toBeGreaterThanOrEqual(0.5)
    expect(guestSerpNeighborhood(overlap, 2)).toBe('saturated')
    expect(guestSerpNeighborhood(0.1, 2)).toBe('productive')
    expect(serpResultKey('https://www.Example.com/write-for-us/?utm=1')).toBe('example.com/write-for-us')
  })

  it('drops known and zero-volume ideas', () => {
    const picked = selectGuestFrontierIdeas({
      ideas: [
        { keyword: 'travel blogs that accept guest posts', avgMonthlySearches: 90, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'hot tub chemicals', avgMonthlySearches: 500, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'weekend getaways', avgMonthlySearches: 0, volumeLow: null, volumeHigh: null, volumeIsRange: false },
        { keyword: 'napa romantic hotels', avgMonthlySearches: 40, volumeLow: null, volumeHigh: null, volumeIsRange: false },
      ],
      alreadyKnown: ['travel blogs that accept guest posts'],
      limit: 5,
    })
    expect(picked).toEqual(['napa romantic hotels'])
  })
})

describe('guest contact method', () => {
  it('lists a published editorial email ahead of a form', () => {
    const contact = guestContactMethod([
      {
        url: 'https://example.com/write-for-us',
        text: 'Email the editor at editor@example.com or use the form.',
        html: '<a href="mailto:editor@example.com">editor</a><a href="/contact">Contact</a>',
      },
    ])
    expect(contact).toEqual({
      method: 'email',
      value: 'editor@example.com',
      sourceUrl: 'https://example.com/write-for-us',
    })
  })

  it('lists the form link when no email is published', () => {
    const contact = guestContactMethod([
      {
        url: 'https://example.com/',
        text: 'We accept guest posts.',
        html: '<a href="/write-for-us/">Write for us</a>',
      },
    ])
    expect(contact).toEqual({
      method: 'form',
      value: 'https://example.com/write-for-us/',
      sourceUrl: 'https://example.com/',
    })
  })
})
