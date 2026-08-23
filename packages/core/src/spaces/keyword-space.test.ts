import { describe, expect, it } from 'vitest'
import {
  LOCATION_US,
  LOCATION_CA,
  WORLDWIDE,
  assertRequestLocation,
  audienceLocation,
  localModelsApply,
  normaliseKeyword,
  patternSlots,
  serpLocationFor,
  validateKeywordSpace,
  volumeLocationFor,
  volumeScopeLabel,
  type KeywordSpace,
  type SpaceEntity,
} from './keyword-space.js'

/**
 * Named after the case that motivated the invariant, so a future edit fails
 * against the real evidence rather than against a made-up fixture — the same
 * convention as acquisition-value.test.ts.
 *
 * Las Vegas is DataForSEO location_code 1014221. Somebody in Chicago planning a
 * trip is the customer; a Las Vegas resident is not.
 */
const LAS_VEGAS: SpaceEntity = {
  slug: 'las-vegas-nv',
  label: 'Las Vegas',
  aliases: ['vegas'],
  locationCode: 1014221,
}

const KENOSHA: SpaceEntity = {
  slug: 'kenosha-wi',
  label: 'Kenosha',
  aliases: [],
  locationCode: 1023191,
}

const HOTEL_SPACE: KeywordSpace = {
  geoMode: 'in_keyword',
  audienceScope: 'country:US',
  serpLocationCode: LOCATION_US,
  dimensions: { locality: { source: 'research_geos' } },
  patterns: [{ template: 'hotels with hot tubs in room {locality}', label: 'in-room' }],
  volumeFloor: 50,
}

const LOCAL_SPACE: KeywordSpace = {
  geoMode: 'location_code',
  audienceScope: 'per_locality',
  serpLocationCode: LOCATION_US,
  dimensions: {},
  patterns: [{ template: 'plumber', label: 'head' }],
  volumeFloor: 10,
}

describe('the destination is never a request parameter', () => {
  it('serpLocationFor ignores Las Vegas entirely on an in_keyword space', () => {
    expect(serpLocationFor(HOTEL_SPACE, LAS_VEGAS)).toBe(LOCATION_US)
    expect(serpLocationFor(HOTEL_SPACE, LAS_VEGAS)).not.toBe(LAS_VEGAS.locationCode)
  })

  it('volumeLocationFor ignores Las Vegas entirely on an in_keyword space', () => {
    expect(volumeLocationFor(HOTEL_SPACE, LAS_VEGAS)).toBe(LOCATION_US)
  })

  it('a Las Vegas SERP would be a different page, so the guard throws on it', () => {
    expect(() => assertRequestLocation(HOTEL_SPACE, LAS_VEGAS.locationCode!, LAS_VEGAS)).toThrow(
      /DESTINATION, not the audience/,
    )
  })

  it('the guard is silent when the code came from the space', () => {
    expect(() => assertRequestLocation(HOTEL_SPACE, LOCATION_US, LAS_VEGAS)).not.toThrow()
  })

  it('does NOT fire on a local space, where the entity code is the correct one', () => {
    expect(serpLocationFor(LOCAL_SPACE, KENOSHA)).toBe(KENOSHA.locationCode)
    expect(() => assertRequestLocation(LOCAL_SPACE, KENOSHA.locationCode!, KENOSHA)).not.toThrow()
  })

  it('an unresolved locality is excluded, never widened to a broader code', () => {
    const unresolved: SpaceEntity = { ...KENOSHA, locationCode: null }
    expect(() => serpLocationFor(LOCAL_SPACE, unresolved)).toThrow(/never widened/)
  })
})

describe('audienceScope', () => {
  it('worldwide returns the sentinel, not a number that could be coerced to US', () => {
    expect(volumeLocationFor({ ...HOTEL_SPACE, audienceScope: 'worldwide' }, LAS_VEGAS)).toBe(
      WORLDWIDE,
    )
  })

  it('country:US is 2840 — the same integer in DataForSEO and Google Ads', () => {
    expect(audienceLocation('country:US')).toBe(2840)
  })

  it('an unmapped country throws rather than falling back to US', () => {
    expect(() => audienceLocation('country:ZZ')).toThrow(/do not fall back to US/)
  })

  it('per_locality is meaningless on an in_keyword space and says so', () => {
    expect(() =>
      volumeLocationFor({ ...HOTEL_SPACE, audienceScope: 'per_locality' }, LAS_VEGAS),
    ).toThrow(/destination, not an audience/)
  })

  it('labels record English scope, because languageConstants/1000 is hardcoded', () => {
    expect(volumeScopeLabel(HOTEL_SPACE, LOCATION_US)).toBe('us/en')
    expect(volumeScopeLabel(HOTEL_SPACE, LOCATION_CA)).toBe('ca/en')
    expect(volumeScopeLabel(HOTEL_SPACE, WORLDWIDE)).toBe('worldwide/en')
  })
})

describe('localModelsApply', () => {
  it('is false for affiliate spaces, with a reason for the screen', () => {
    const r = localModelsApply(HOTEL_SPACE)
    expect(r.applies).toBe(false)
    if (!r.applies) expect(r.reason).toMatch(/share a location/)
  })

  it('is true for local services, unchanged', () => {
    expect(localModelsApply(LOCAL_SPACE).applies).toBe(true)
  })
})

describe('validateKeywordSpace', () => {
  it('accepts both real sites', () => {
    expect(validateKeywordSpace(HOTEL_SPACE)).toEqual([])
    expect(validateKeywordSpace(LOCAL_SPACE)).toEqual([])
  })

  it('rejects a pattern binding an undeclared dimension', () => {
    const errors = validateKeywordSpace({
      ...HOTEL_SPACE,
      patterns: [{ template: '{product} review', label: 'review' }],
    })
    expect(errors.join(' ')).toMatch(/dimension "product" is not declared/)
  })

  it('rejects a repeated dimension without pairwise, because it multiplies the grid', () => {
    const errors = validateKeywordSpace({
      ...HOTEL_SPACE,
      dimensions: { vendor: { source: 'entity_set', setSlug: 'vendors' } },
      patterns: [{ template: '{vendor} vs {vendor:2}', label: 'vs' }],
    })
    expect(errors.join(' ')).toMatch(/needs pairwise: true/)
  })

  it('rejects a local space that claims a country aggregate audience', () => {
    const errors = validateKeywordSpace({ ...LOCAL_SPACE, audienceScope: 'country:US' })
    expect(errors.join(' ')).toMatch(/measures the locality it buys/)
  })
})

describe('normalisation matches the catalog', () => {
  it('trims, lowercases and collapses whitespace like opportunity-screen does', () => {
    expect(normaliseKeyword('  Hotels  With   Hot Tubs  ')).toBe('hotels with hot tubs')
  })

  it('reads ordinals off repeated slots', () => {
    expect(patternSlots('{vendor} vs {vendor:2}')).toEqual([
      { raw: 'vendor', dimension: 'vendor', ordinal: 1 },
      { raw: 'vendor:2', dimension: 'vendor', ordinal: 2 },
    ])
  })
})
