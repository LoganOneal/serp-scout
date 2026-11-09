import { describe, expect, it } from 'vitest'
import {
  deferForPlanSpread,
  guestContactMethod,
  guestKeywordFetchDecision,
  guestSerpNeighborhood,
  guestSerpRequest,
  parseGuestSerpHarvest,
  isGuestFrontierKeyword,
  isLegacyGuestDiscoveryKeyword,
  maxSerpResultOverlap,
  selectGuestFrontierIdeas,
  serpResultKey,
} from './guest-frontier.js'
import { parseOrganicSerp } from '../hht-engine/serp-table.js'
import { normalizeFrontierKeyword } from '../hht-engine/keywords.js'

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

  it('accepts topical packing and staycation seeds, never contribution footprints', () => {
    for (const keyword of ['packing list for ecuador', 'staycation ideas for married couples', 'hotels with private hot tub']) {
      expect(isGuestFrontierKeyword(keyword)).toBe(true)
    }
    for (const keyword of ['travel write for us', 'travel guest post guidelines', 'travel contributor guidelines', 'inurl:write-for-us travel']) {
      expect(isLegacyGuestDiscoveryKeyword(keyword)).toBe(true)
      expect(isGuestFrontierKeyword(keyword)).toBe(false)
    }
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
        { keyword: 'travel write for us', avgMonthlySearches: 900, volumeLow: null, volumeHigh: null, volumeIsRange: false },
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

describe('guest frontier Semrush MCP hand-off', () => {
  it('asks for the phrase_organic report the SERP parser reads', () => {
    expect(guestSerpRequest(7, 'romantic getaways in vermont')).toEqual({
      keywordId: 7,
      keyword: 'romantic getaways in vermont',
      report: 'phrase_organic',
      params: {
        phrase: 'romantic getaways in vermont',
        database: 'us',
        display_limit: 100,
        positions_type: 'organic',
        export_columns: ['position', 'domain', 'url'],
      },
    })
  })

  it('reads a harvest file into SERP rows and units', () => {
    const fixture = {
      'Romantic Getaways in Vermont': {
        data: 'Position;Domain;Url\n1;vermont.com;https://vermont.com/romance/\n2;www.ourtravelblog.net;https://www.ourtravelblog.net/vermont-getaways/',
        units: 1000,
      },
      'cozy cabins in maine': {
        data: { data: [{ position: 3, domain: 'mainecabins.org', url: 'https://mainecabins.org/list' }], metadata: { usage: { api_units: 500 } } },
      },
      'hotels with private hot tub': { error: 'no_api_units' },
    }
    const entries = parseGuestSerpHarvest(fixture)
    expect(entries.map((row) => row.normalized)).toEqual([
      normalizeFrontierKeyword('romantic getaways in vermont'),
      normalizeFrontierKeyword('cozy cabins in maine'),
      normalizeFrontierKeyword('hotels with private hot tub'),
    ])
    expect(parseOrganicSerp(entries[0]!.entry.data)).toEqual([
      { position: 1, domain: 'vermont.com', url: 'https://vermont.com/romance/' },
      { position: 2, domain: 'www.ourtravelblog.net', url: 'https://www.ourtravelblog.net/vermont-getaways/' },
    ])
    expect(entries[0]!.entry.units).toBe(1000)
    expect(parseOrganicSerp(entries[1]!.entry.data)).toEqual([
      { position: 3, domain: 'mainecabins.org', url: 'https://mainecabins.org/list' },
    ])
    expect(entries[1]!.entry.units).toBe(500)
    expect('data' in entries[2]!.entry).toBe(false)
  })

  it('rejects malformed harvest files', () => {
    expect(() => parseGuestSerpHarvest([])).toThrow(/JSON object/)
    expect(() => parseGuestSerpHarvest({ a: 'x' })).toThrow(/must be/)
    expect(() => parseGuestSerpHarvest({ a: { units: 3 } })).toThrow(/neither/)
    expect(() => parseGuestSerpHarvest({ a: { data: '', units: -1 } })).toThrow(/units/)
  })
})

describe('deferForPlanSpread', () => {
  it('defers a variant of a keyword already in the plan', () => {
    const planned = ['things to do in seattle this weekend']
    expect(deferForPlanSpread('fun things to do in seattle', planned)).toBe(true)
    expect(deferForPlanSpread('seattle things to do this weekend', planned)).toBe(true)
  })
  it('keeps a different topic and an empty plan', () => {
    expect(deferForPlanSpread('seattle tourist attractions', ['things to do in seattle this weekend'])).toBe(false)
    expect(deferForPlanSpread('fun things to do in seattle', [])).toBe(false)
  })
})
