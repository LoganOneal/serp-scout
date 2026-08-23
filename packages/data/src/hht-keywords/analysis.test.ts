import { describe, expect, it } from 'vitest'
import {
  aggregateHhtCity,
  classifyHhtKeyword,
  hhtIntentCluster,
  mergeHhtKeywords,
  type HhtDestination,
} from './analysis.js'

const chicago: HhtDestination = {
  slug: 'chicago-il',
  label: 'Chicago',
  aliases: ['Chicago IL'],
  countryCode: 'US',
  googleAdsGeoTarget: 2840,
  volumeScope: 'us/en',
}

const idea = (keyword: string, volume: number | null) => ({
  keyword,
  avgMonthlySearches: volume,
  competitionIndex: null,
  lowTopOfPageBidMicros: null,
  highTopOfPageBidMicros: null,
})

describe('classifyHhtKeyword', () => {
  it('keeps destination-bound hotel amenity intent', () => {
    expect(classifyHhtKeyword('Chicago hotels with jacuzzi in room', chicago)).toMatchObject({
      eligible: true,
      intentTier: 'room',
    })
    expect(classifyHhtKeyword('Chicago jacuzzi suites', chicago)).toMatchObject({
      eligible: true,
      intentTier: 'suite',
    })
  })

  it('rejects generic, product/service, and unsupported inventory queries', () => {
    expect(classifyHhtKeyword('hotels with hot tubs near me', chicago)).toEqual({
      eligible: false,
      reason: 'missing_city',
    })
    expect(classifyHhtKeyword('Chicago hot tub repair', chicago)).toEqual({
      eligible: false,
      reason: 'missing_lodging',
    })
    expect(classifyHhtKeyword('Chicago Airbnb with hot tub', chicago)).toEqual({
      eligible: false,
      reason: 'missing_lodging',
    })
  })

  it('recognises safe common aliases', () => {
    const nyc = {
      ...chicago,
      slug: 'new-york-city-ny',
      label: 'New York City',
      aliases: ['New York City NY'],
    }
    expect(classifyHhtKeyword('NYC hotels with private hot tub', nyc)).toMatchObject({
      eligible: true,
    })
  })

  it('rejects a same-named city in another explicit state', () => {
    const lancaster = {
      ...chicago,
      slug: 'lancaster-ca',
      label: 'Lancaster',
      aliases: ['Lancaster CA'],
    }
    expect(classifyHhtKeyword('hotel in Lancaster PA with jacuzzi', lancaster)).toEqual({
      eligible: false,
      reason: 'wrong_geography',
    })
    expect(classifyHhtKeyword('Lancaster hotels with jacuzzi in room', lancaster)).toMatchObject({
      eligible: true,
    })
  })

  it('keeps a bare Canadian city while rejecting an explicit wrong province', () => {
    const london: HhtDestination = {
      slug: 'london-on-ca',
      label: 'London',
      aliases: ['London ON', 'London Ontario'],
      countryCode: 'CA',
      googleAdsGeoTarget: 2124,
      volumeScope: 'ca/en',
    }
    expect(classifyHhtKeyword('London hotels with private hot tubs', london)).toMatchObject({
      eligible: true,
    })
    expect(classifyHhtKeyword('London Kentucky hotels with jacuzzi', london)).toEqual({
      eligible: false,
      reason: 'wrong_geography',
    })
  })

  it('does not confuse an ordinary preposition with a state abbreviation', () => {
    expect(classifyHhtKeyword('hotels in Chicago with hot tub in room', chicago)).toMatchObject({
      eligible: true,
    })
  })
})

describe('hhtIntentCluster', () => {
  it('groups amenity synonyms and word-order variants', () => {
    expect(hhtIntentCluster('Chicago hotels with jacuzzi in room', chicago)).toBe(
      hhtIntentCluster('hotels with hot tubs in room Chicago', chicago),
    )
    expect(hhtIntentCluster('Chicago jacuzzi suites', chicago)).not.toBe(
      hhtIntentCluster('Chicago hotels with jacuzzi in room', chicago),
    )
  })

  it('does not split clusters on state spelling or redundant tub wording', () => {
    expect(hhtIntentCluster('Chicago Illinois hotels with jacuzzi tub in room', chicago)).toBe(
      hhtIntentCluster('Chicago IL hotels with hot tubs in room', chicago),
    )
  })

  it('does not split Canadian clusters on a redundant country qualifier', () => {
    const toronto: HhtDestination = {
      slug: 'toronto-on-ca',
      label: 'Toronto',
      aliases: ['Toronto ON', 'Toronto Ontario'],
      countryCode: 'CA',
      googleAdsGeoTarget: 2124,
      volumeScope: 'ca/en',
    }
    expect(hhtIntentCluster('Toronto hotels with hot tubs in room', toronto)).toBe(
      hhtIntentCluster('hotels with jacuzzi in room Toronto Canada', toronto),
    )
  })
})

describe('aggregation', () => {
  it('exports a raw sum and a conservative cluster-deduped sum', () => {
    const merged = mergeHhtKeywords({
      destination: chicago,
      grid: [idea('Chicago hotels with jacuzzi in room', 2900)],
      ideas: [
        idea('hotels with hot tubs in room Chicago', 2900),
        idea('Chicago jacuzzi suites', 880),
      ],
    })
    const aggregate = aggregateHhtCity(chicago, merged.candidates)
    expect(aggregate.keywordCount).toBe(3)
    expect(aggregate.rawAggregateVolume).toBe(6680)
    expect(aggregate.conservativeAggregateVolume).toBe(3780)
    expect(aggregate.topKeywordVolume).toBe(2900)
  })
})
