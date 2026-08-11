import { describe, expect, it } from 'vitest'
import {
  extractRelatedSearches,
  extractSerpLayoutMetrics,
  isLsaItem,
  isPaidSearchItem,
} from './serp-layout.js'

describe('extractSerpLayoutMetrics', () => {
  it('counts paid search ads and local pack strictly above first organic', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'paid', rank_absolute: 1 },
      { type: 'local_pack', rank_absolute: 2, items: [{ type: 'maps_search' }, { type: 'maps_search' }, { type: 'maps_search' }] },
      { type: 'organic', rank_absolute: 5, domain: 'yelp.com' },
      { type: 'organic', rank_absolute: 6, domain: 'reddit.com' },
    ])
    expect(m.firstOrganicRankAbsolute).toBe(5)
    expect(m.adsAboveOrganicCount).toBe(1)
    expect(m.localProfilesAboveOrganicCount).toBe(1)
    expect(m.organicCount).toBe(2)
    expect(m.paidCount).toBe(1)
    expect(m.localPackCount).toBe(1)
    expect(m.mapPresent).toBe(true)
    expect(m.mapRankAbsolute).toBe(2)
    expect(m.localBusinessCount).toBe(3)
    expect(m.localBusinessAboveOrganicCount).toBe(3)
    expect(m.localPackRankAbsolute).toBe(2)
    expect(m.lsaCount).toBe(0)
    expect(m.sponsoredAboveOrganicCount).toBe(1)
  })

  it('treats LSA separately from paid search ads', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'local_services', rank_absolute: 1 },
      { type: 'paid', rank_absolute: 2 },
      { type: 'organic', rank_absolute: 4 },
    ])
    expect(m.lsaCount).toBe(1)
    expect(m.lsaAboveOrganicCount).toBe(1)
    expect(m.lsaRankAbsolute).toBe(1)
    expect(m.paidCount).toBe(1)
    expect(m.adsAboveOrganicCount).toBe(1)
    expect(m.sponsoredAboveOrganicCount).toBe(2)
    expect(isLsaItem({ type: 'local_services' })).toBe(true)
    expect(isPaidSearchItem({ type: 'local_services' })).toBe(false)
    expect(isPaidSearchItem({ type: 'paid' })).toBe(true)
  })

  it('counts forums pack and rank', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'paid', rank_absolute: 1 },
      {
        type: 'discussions_and_forums',
        rank_absolute: 3,
        items: [
          { type: 'discussions_and_forums_element', title: 'a', url: 'https://reddit.com/r/x' },
          { type: 'discussions_and_forums_element', title: 'b', url: 'https://reddit.com/r/y' },
        ],
      },
      { type: 'organic', rank_absolute: 7 },
    ])
    expect(m.discussionsPackPresent).toBe(true)
    expect(m.forumsCount).toBe(2)
    expect(m.forumsRankAbsolute).toBe(3)
  })

  it('does not count equal rank as above', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'paid', rank_absolute: 2 },
      { type: 'organic', rank_absolute: 2 },
    ])
    expect(m.adsAboveOrganicCount).toBe(0)
  })

  it('treats is_paid organic as paid search', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'organic', is_paid: true, rank_absolute: 1 },
      { type: 'organic', rank_absolute: 2 },
    ])
    expect(m.adsAboveOrganicCount).toBe(1)
    expect(m.organicCount).toBe(1)
  })

  it('when no organic, counts all paid/local/LSA as above', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'paid', rank_absolute: 1 },
      { type: 'local_services', rank_absolute: 2 },
      { type: 'local_pack', rank_absolute: 3 },
    ])
    expect(m.firstOrganicRankAbsolute).toBeNull()
    expect(m.adsAboveOrganicCount).toBe(1)
    expect(m.lsaAboveOrganicCount).toBe(1)
    expect(m.localProfilesAboveOrganicCount).toBe(1)
  })

  it('counts local_pack nested businesses', () => {
    const m = extractSerpLayoutMetrics([
      {
        type: 'local_pack',
        rank_absolute: 1,
        items: [{ type: 'maps_search' }, { type: 'maps_search' }],
      },
      { type: 'organic', rank_absolute: 3 },
    ])
    expect(m.localProfilesAboveOrganicCount).toBe(1)
    expect(m.localPackCount).toBe(1)
    expect(m.localBusinessCount).toBe(2)
    expect(m.localBusinessAboveOrganicCount).toBe(2)
  })

  it('ignores items without rank_absolute', () => {
    const m = extractSerpLayoutMetrics([
      { type: 'paid' },
      { type: 'organic', rank_absolute: 1 },
    ])
    expect(m.adsAboveOrganicCount).toBe(0)
    expect(m.paidCount).toBe(0)
  })

  it('extracts top organic domains and GBP leaders', () => {
    const m = extractSerpLayoutMetrics([
      {
        type: 'local_pack',
        rank_absolute: 1,
        items: [
          {
            type: 'maps_search',
            title: 'Ace Roofing',
            domain: 'aceroofing.com',
            rating: { value: 4.8, votes_count: 120 },
          },
          { type: 'maps_search', title: 'Bob’s Roof', domain: 'bobsroof.com', rating: 4.2 },
        ],
      },
      { type: 'organic', rank_absolute: 4, domain: 'yelp.com' },
      { type: 'organic', rank_absolute: 5, domain: 'angi.com' },
      { type: 'people_also_ask', rank_absolute: 6 },
    ])
    expect(m.topOrganicDomains.map((d) => d.domain)).toEqual(['yelp.com', 'angi.com'])
    expect(m.gbpLeaders[0]?.title).toBe('Ace Roofing')
    expect(m.gbpLeaders[0]?.rating).toBe(4.8)
    expect(m.gbpLeaders[0]?.reviewsCount).toBe(120)
    expect(m.hasPeopleAlsoAsk).toBe(true)
  })
})

describe('extractRelatedSearches', () => {
  it('caps at 8 and dedupes', () => {
    const items = [
      {
        type: 'related_searches',
        items: Array.from({ length: 12 }, (_, i) => ({
          type: 'related_searches_element',
          title: i % 2 === 0 ? `query ${i / 2}` : `query ${Math.floor(i / 2)}`,
        })),
      },
    ]
    const r = extractRelatedSearches(items)
    expect(r.length).toBeLessThanOrEqual(8)
    expect(new Set(r.map((x) => x.toLowerCase())).size).toBe(r.length)
  })
})
