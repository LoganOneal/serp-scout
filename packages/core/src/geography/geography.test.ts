import { describe, expect, it } from 'vitest'
import {
  abbreviationVariants,
  cleanCensusName,
  expandParenthetical,
  nameCandidates,
  stripLegalSuffix,
} from './names.js'
import { assignSlugs } from './slug.js'
import {
  ACCEPT_TYPES,
  ProviderLocationIndex,
  candidateProviderNames,
  resolveLocality,
} from './resolve.js'
import { shouldCreateMetro, shouldRollUpCounty } from './rollup.js'
import type { ProviderLocation } from '../types.js'

// ---------------------------------------------------------------------------

describe('legal suffix stripping is case-SENSITIVE', () => {
  it('strips lowercase legal suffixes', () => {
    expect(stripLegalSuffix('Richmond city')).toBe('Richmond')
    expect(stripLegalSuffix('Virginia Beach city')).toBe('Virginia Beach')
    expect(stripLegalSuffix('Kenosha city')).toBe('Kenosha')
    expect(stripLegalSuffix('Mount Pleasant village')).toBe('Mount Pleasant')
    expect(stripLegalSuffix('Bloomfield town')).toBe('Bloomfield')
    expect(stripLegalSuffix('State College borough')).toBe('State College')
  })

  it('does NOT strip a capitalised City, which is part of the name', () => {
    // Case-insensitive stripping sends Kansas City -> "Kansas" -> the STATE of
    // Kansas, and Boise City OK -> "Boise" -> Boise, IDAHO. Both return a
    // well-formed SERP for the wrong place, with no error anywhere.
    expect(stripLegalSuffix('Kansas City')).toBe('Kansas City')
    expect(stripLegalSuffix('Boise City')).toBe('Boise City')
    expect(stripLegalSuffix('Oklahoma City')).toBe('Oklahoma City')
    expect(stripLegalSuffix('Salt Lake City')).toBe('Salt Lake City')
    expect(stripLegalSuffix('Iowa City')).toBe('Iowa City')
    expect(stripLegalSuffix('Carson City')).toBe('Carson City')
    expect(stripLegalSuffix('Traverse City')).toBe('Traverse City')
  })

  it('never strips a name down to nothing', () => {
    expect(stripLegalSuffix('city')).toBe('city')
  })

  it('strips MULTI-WORD legal suffixes, longest form first', () => {
    // The first match wins, so a short-first list leaves debris:
    // "Juneau city and borough" -> " borough" -> "Juneau city and".
    expect(stripLegalSuffix('Juneau city and borough')).toBe('Juneau')
    expect(stripLegalSuffix('Sitka city and borough')).toBe('Sitka')
    // Utah: " township" alone leaves "Kearns metro".
    expect(stripLegalSuffix('Kearns metro township')).toBe('Kearns')
    expect(stripLegalSuffix('Magna metro township')).toBe('Magna')
    expect(stripLegalSuffix('Canton charter township')).toBe('Canton')
  })
})

describe('New England "Town" is a legal form, not part of the name', () => {
  it('strips it in New England, where Census writes "Weymouth Town city"', () => {
    // Eleven Massachusetts places over 25k were unresolvable: stripping the
    // lowercase " city" leaves "Weymouth Town", but the provider carries
    // "Weymouth".
    expect(cleanCensusName('Weymouth Town city', 'MA')).toBe('Weymouth')
    expect(cleanCensusName('Barnstable Town city', 'MA')).toBe('Barnstable')
    expect(cleanCensusName('Amherst Town city', 'MA')).toBe('Amherst')
    expect(cleanCensusName('West Springfield Town city', 'MA')).toBe('West Springfield')
    expect(cleanCensusName('North Attleborough Town city', 'MA')).toBe('North Attleborough')
  })

  it('does NOT strip it elsewhere -- Boys Town, Nebraska is not "Boys"', () => {
    expect(cleanCensusName('Boys Town village', 'NE')).toBe('Boys Town')
    expect(cleanCensusName('Boys Town', 'NE')).toBe('Boys Town')
  })

  it('leaves single-word names containing "town" alone anywhere', () => {
    expect(cleanCensusName('Watertown city', 'MA')).toBe('Watertown')
    expect(cleanCensusName('Georgetown town', 'TX')).toBe('Georgetown')
    expect(cleanCensusName('Middletown city', 'CT')).toBe('Middletown')
  })
})

describe('St./Saint and other abbreviation variants', () => {
  it('offers both spellings, because neither side is consistent', () => {
    // Census writes "St. Paul city"; the provider carries "Saint Paul". This one
    // rule recovered St. Paul (pop 307,465) -- the only US city over 250k that
    // failed to resolve.
    const c = nameCandidates('St. Paul city', 'MN')
    expect(c).toContain('St. Paul')
    expect(c).toContain('Saint Paul')
  })

  it('works in the other direction too', () => {
    const c = nameCandidates('Saint Cloud city', 'MN')
    expect(c).toContain('Saint Cloud')
    expect(c).toContain('St. Cloud')
  })

  it('covers Mount/Mt. and Fort/Ft.', () => {
    expect(nameCandidates('Mount Vernon city', 'NY')).toContain('Mt. Vernon')
    expect(nameCandidates('Mt. Pleasant city', 'SC')).toContain('Mount Pleasant')
    expect(nameCandidates('Fort Worth city', 'TX')).toContain('Ft. Worth')
    expect(nameCandidates('Ft. Collins city', 'CO')).toContain('Fort Collins')
  })

  it('leaves names without an abbreviation untouched', () => {
    expect(abbreviationVariants('Kenosha')).toEqual(['Kenosha'])
  })

  it('does not mangle a name merely containing "st"', () => {
    // A careless \bSt\b rule would hit these.
    expect(abbreviationVariants('Stonecrest')).toEqual(['Stonecrest'])
    expect(abbreviationVariants('Staunton')).toEqual(['Staunton'])
    expect(abbreviationVariants('Fortuna')).toEqual(['Fortuna'])
    expect(abbreviationVariants('Mountain View')).toEqual(['Mountain View'])
  })
})

describe('parentheticals', () => {
  it('offers the parenthetical first -- the provider carries Ventura', () => {
    expect(expandParenthetical('San Buenaventura (Ventura)')).toEqual([
      'Ventura',
      'San Buenaventura',
    ])
  })

  it('treats Census bookkeeping parentheticals as noise, not alternative names', () => {
    expect(expandParenthetical('Butte-Silver Bow (balance)')).toEqual(['Butte-Silver Bow'])
    expect(expandParenthetical('Athens-Clarke County (part)')).toEqual(['Athens-Clarke County'])
  })

  it('leaves plain names alone', () => {
    expect(expandParenthetical('Kenosha')).toEqual(['Kenosha'])
  })
})

describe('consolidated city-counties use a state-scoped alias table, not a hyphen rule', () => {
  it('resolves the closed set of consolidations', () => {
    expect(cleanCensusName('Indianapolis city (balance)', 'IN')).toBe('Indianapolis')
    expect(cleanCensusName('Nashville-Davidson metropolitan government (balance)', 'TN')).toBe(
      'Nashville',
    )
    expect(cleanCensusName('Louisville/Jefferson County metro government (balance)', 'KY')).toBe(
      'Louisville',
    )
    expect(cleanCensusName('Lexington-Fayette urban county', 'KY')).toBe('Lexington')
    expect(cleanCensusName('Augusta-Richmond County consolidated government (balance)', 'GA')).toBe(
      'Augusta',
    )
    expect(cleanCensusName('Macon-Bibb County', 'GA')).toBe('Macon')
    expect(cleanCensusName('Athens-Clarke County unified government (balance)', 'GA')).toBe('Athens')
    expect(cleanCensusName('Urban Honolulu', 'HI')).toBe('Honolulu')
    expect(cleanCensusName('Butte-Silver Bow (balance)', 'MT')).toBe('Butte')
  })

  it('aliases Boise City in IDAHO but not the unrelated Boise City in OKLAHOMA', () => {
    // A name-only alias table maps both to "Boise", sending Oklahoma's Boise
    // City (pop ~1,100) to Boise, Idaho -- a well-formed SERP for a city 1,000
    // miles away, with nothing downstream able to tell.
    expect(cleanCensusName('Boise City', 'ID')).toBe('Boise')
    expect(cleanCensusName('Boise City', 'OK')).toBe('Boise City')
  })

  it('does NOT split legitimately hyphenated names', () => {
    // The reason a hyphen-splitting rule was rejected in favour of a table.
    expect(cleanCensusName('Winston-Salem city', 'NC')).toBe('Winston-Salem')
    expect(cleanCensusName('Wilkes-Barre city', 'PA')).toBe('Wilkes-Barre')
    expect(cleanCensusName('Bethel-Tate', 'OH')).toBe('Bethel-Tate')
    expect(cleanCensusName('Ho-Ho-Kus borough', 'NJ')).toBe('Ho-Ho-Kus')
  })

  it('strips the legal suffix BEFORE expanding the parenthetical', () => {
    // Census writes 'San Buenaventura (Ventura) city'. With the suffix still
    // attached the parenthetical is not at the end of the string, so a
    // paren-first implementation never sees it.
    expect(cleanCensusName('San Buenaventura (Ventura) city', 'CA')).toBe('Ventura')
    expect(nameCandidates('San Buenaventura (Ventura) city', 'CA')).toContain('San Buenaventura')
  })

  it('generates candidates for a consolidated name including the alias', () => {
    const c = nameCandidates('Nashville-Davidson metropolitan government (balance)', 'TN')
    expect(c[0]).toBe('Nashville')
  })
})

// ---------------------------------------------------------------------------

describe('slugs disambiguate by FIPS, and do it order-independently', () => {
  const wilmingtonA = { kind: 'city' as const, name: 'Wilmington', stateCode: 'IL', fips: '1782921' }
  const wilmingtonB = { kind: 'city' as const, name: 'Wilmington', stateCode: 'IL', fips: '1782934' }
  const kenosha = { kind: 'city' as const, name: 'Kenosha', stateCode: 'WI', fips: '5539225' }

  it('leaves a unique name un-suffixed', () => {
    const [only] = assignSlugs([kenosha])
    expect(only!.slug).toBe('kenosha-wi')
  })

  it('suffixes BOTH Illinois Wilmingtons, not just the second one', () => {
    const slugs = assignSlugs([wilmingtonA, wilmingtonB]).map((l) => l.slug)
    expect(slugs).toEqual(['wilmington-il-1782921', 'wilmington-il-1782934'])
    // Neither gets the bare slug: if one did, which one would depend on row
    // order, so a re-ingest could silently move saved shortlist items and
    // outcome history onto a different city.
    expect(slugs).not.toContain('wilmington-il')
  })

  it('produces identical slugs regardless of input order', () => {
    const forward = assignSlugs([wilmingtonA, wilmingtonB, kenosha])
    const reverse = assignSlugs([kenosha, wilmingtonB, wilmingtonA])
    const key = (arr: typeof forward) =>
      Object.fromEntries(arr.map((l) => [l.fips, l.slug]))
    expect(key(forward)).toEqual(key(reverse))
  })

  it('distinguishes kinds so a city and its county never collide', () => {
    const out = assignSlugs([
      { kind: 'city', name: 'Kenosha', stateCode: 'WI', fips: '5539225' },
      { kind: 'county', name: 'Kenosha County', stateCode: 'WI', fips: '55059' },
      { kind: 'metro', name: 'Kenosha', stateCode: 'WI', fips: '29404' },
    ])
    expect(out.map((l) => l.slug)).toEqual([
      'kenosha-wi',
      'kenosha-county-wi-county',
      'kenosha-wi-metro',
    ])
  })

  it('handles three Oakwoods in Ohio', () => {
    const slugs = assignSlugs(
      ['3958730', '3958744', '3958758'].map((fips) => ({
        kind: 'city' as const,
        name: 'Oakwood',
        stateCode: 'OH',
        fips,
      })),
    ).map((l) => l.slug)
    expect(new Set(slugs).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------

const loc = (
  locationCode: number,
  locationName: string,
  locationType: string,
): ProviderLocation => ({ locationCode, locationName, locationType, countryIsoCode: 'US' })

describe('resolution NEVER widens', () => {
  const index = new ProviderLocationIndex([
    loc(1015254, 'Kenosha,Wisconsin,United States', 'City'),
    loc(21159, 'Wisconsin,United States', 'Region'),
    loc(1026339, 'McKinney,Collin County,Texas,United States', 'City'),
    loc(1013962, 'Orange,Orange,California,United States', 'City'),
    loc(1022342, 'Ventura,California,United States', 'City'),
    loc(9061103, 'Kenosha County,Wisconsin,United States', 'County'),
    loc(200555, 'Milwaukee WI,United States', 'DMA Region'),
    // Richmond exists ONLY as a City -- the trap that produced 23 permanently
    // unresolvable county duplicates.
    loc(1024533, 'Richmond,Virginia,United States', 'City'),
  ])

  it('resolves the straightforward case', () => {
    const r = resolveLocality(
      {
        kind: 'city',
        rawName: 'Kenosha city',
        stateName: 'Wisconsin',
        stateCode: 'WI',
        countyName: 'Kenosha County',
      },
      index,
    )
    expect(r.resolved).toBe(true)
    if (r.resolved) {
      expect(r.locationCode).toBe(1015254)
      expect(r.method).toBe('city:name-state')
    }
  })

  it('refuses a Region row even when the name matches exactly', () => {
    // THE widening guard, at the level it actually operates. The index holds
    // "Wisconsin,United States" as a Region; a city lookup must not take it. A
    // statewide SERP answering a city query is well-formed, completely wrong,
    // and undetectable downstream.
    expect(index.lookup('Wisconsin,United States', ['City'])).toBeNull()
    expect(index.lookup('Wisconsin,United States', ['Region'])?.locationCode).toBe(21159)
    // And a city lookup does not fall back to the county row either.
    expect(index.lookup('Kenosha County,Wisconsin,United States', ['City'])).toBeNull()
  })

  it('leaves a city unresolved and explains the type refusal', () => {
    // Georgia the city-shaped candidate collides with a Region row of the same
    // full name. Refusing it is correct; saying WHY is what keeps a good
    // refusal from looking like a resolver bug.
    const withCollision = new ProviderLocationIndex([
      loc(2213, 'Georgia,Georgia,United States', 'Region'),
    ])
    const r = resolveLocality(
      { kind: 'city', rawName: 'Georgia', stateName: 'Georgia', stateCode: 'GA', countyName: null },
      withCollision,
    )
    expect(r.resolved).toBe(false)
    if (!r.resolved) {
      expect(r.reason).toMatch(/refused because only City is acceptable/)
      expect(r.reason).toMatch(/type "Region"/)
    }
  })

  it('finds McKinney TX, which needs the county-qualified form', () => {
    // A city of 227,000 that was missing from the corpus entirely until form 2.
    const r = resolveLocality(
      {
        kind: 'city',
        rawName: 'McKinney city',
        stateName: 'Texas',
        stateCode: 'TX',
        countyName: 'Collin County',
      },
      index,
    )
    expect(r.resolved).toBe(true)
    if (r.resolved) {
      expect(r.locationCode).toBe(1026339)
      expect(r.method).toBe('city:with-county-word')
    }
  })

  it('finds Orange CA, whose county segment omits the word "County"', () => {
    const r = resolveLocality(
      {
        kind: 'city',
        rawName: 'Orange city',
        stateName: 'California',
        stateCode: 'CA',
        countyName: 'Orange County',
      },
      index,
    )
    expect(r.resolved).toBe(true)
    if (r.resolved) {
      expect(r.locationCode).toBe(1013962)
      expect(r.method).toBe('city:county-bare')
    }
  })

  it('finds San Buenaventura under its parenthetical name', () => {
    const r = resolveLocality(
      {
        kind: 'city',
        rawName: 'San Buenaventura (Ventura) city',
        stateName: 'California',
        stateCode: 'CA',
        countyName: 'Ventura County',
      },
      index,
    )
    expect(r.resolved).toBe(true)
    if (r.resolved) expect(r.locationCode).toBe(1022342)
  })

  it('leaves an independent city UNRESOLVED as a county rather than matching its City row', () => {
    // Richmond city is a county-equivalent in Census and a City to the provider.
    // Matching it would create a county locality scanning the city's SERP.
    const r = resolveLocality(
      {
        kind: 'county',
        rawName: 'Richmond city',
        stateName: 'Virginia',
        stateCode: 'VA',
        countyName: null,
      },
      index,
    )
    expect(r.resolved).toBe(false)
    if (!r.resolved) expect(r.reason).toMatch(/type "City"/)
  })

  it('resolves counties and metros with their own accepted types', () => {
    const county = resolveLocality(
      {
        kind: 'county',
        rawName: 'Kenosha County',
        stateName: 'Wisconsin',
        stateCode: 'WI',
        countyName: null,
      },
      index,
    )
    expect(county.resolved).toBe(true)

    const metro = resolveLocality(
      { kind: 'metro', rawName: 'Milwaukee', stateName: 'WI', stateCode: 'WI', countyName: null },
      index,
    )
    expect(metro.resolved).toBe(true)
  })

  it('declares its accepted types explicitly per kind', () => {
    expect(ACCEPT_TYPES.city).toEqual(['City'])
    expect(ACCEPT_TYPES.county).toEqual(['County'])
    expect(ACCEPT_TYPES.metro).toEqual(['DMA Region', 'City'])
  })

  it('tries all three county-qualification forms', () => {
    const forms = candidateProviderNames({
      kind: 'city',
      rawName: 'Orange city',
      stateName: 'California',
      stateCode: 'CA',
      countyName: 'Orange County',
    }).map((c) => c.fullName)
    expect(forms).toContain('Orange,California,United States')
    expect(forms).toContain('Orange,Orange County,California,United States')
    expect(forms).toContain('Orange,Orange,California,United States')
  })
})

// ---------------------------------------------------------------------------

describe('the 95% county rollup rule', () => {
  it('skips Richmond city VA, where the city IS the county', () => {
    const d = shouldRollUpCounty({
      countyName: 'Richmond city',
      countyPopulation: 226_610,
      members: [{ name: 'Richmond city', population: 226_610 }],
    })
    expect(d.create).toBe(false)
    expect(d.dominantShare).toBe(1)
    // Caught by the exact NAME rule rather than the population rule -- Census
    // writes the county-equivalent as "Richmond city", lowercase.
    expect(d.reason).toMatch(/how an independent city is marked/)
  })

  it('catches a consolidated city-county by population, since its name says County', () => {
    // San Francisco County is named like an ordinary county, so only the share
    // rule can see that it is the same market as the city.
    const d = shouldRollUpCounty({
      countyName: 'San Francisco County',
      countyPopulation: 827_526,
      members: [{ name: 'San Francisco city', population: 827_526 }],
    })
    expect(d.create).toBe(false)
    expect(d.reason).toMatch(/independent city or consolidated government/)
  })

  it('skips Baltimore city and St. Louis city too, with no hardcoded list', () => {
    for (const [name, pop] of [
      ['Baltimore city', 565_239],
      ['St. Louis city', 279_095],
    ] as const) {
      expect(
        shouldRollUpCounty({ countyName: name, countyPopulation: pop, members: [{ name, population: pop }] }).create,
      ).toBe(false)
    }
  })

  it('creates a normal county where the largest city is a minority', () => {
    const d = shouldRollUpCounty({
      countyName: 'Kenosha County',
      countyPopulation: 169_561,
      members: [
        { name: 'Kenosha city', population: 99_500 },
        { name: 'Pleasant Prairie village', population: 21_250 },
      ],
    })
    expect(d.create).toBe(true)
    expect(d.dominantShare).toBeCloseTo(0.587, 2)
  })

  it('catches independent cities by their Census county-equivalent NAME, exactly', () => {
    // Rule A: Census marks an independent city county-equivalent with a trailing
    // LOWERCASE " city". No population arithmetic, no misattribution risk.
    for (const name of ['Richmond city', 'Baltimore city', 'St. Louis city', 'Roanoke city']) {
      const d = shouldRollUpCounty({ countyName: name, countyPopulation: 100_000, members: [] })
      expect(d.create, name).toBe(false)
      expect(d.reason).toMatch(/how an independent city is marked/)
    }
    // Alaska's variants.
    expect(
      shouldRollUpCounty({
        countyName: 'Juneau City and Borough',
        countyPopulation: 32_000,
        members: [],
      }).create,
    ).toBe(false)
  })

  it('keeps a real county whose name merely CONTAINS City', () => {
    // "Carson City" has a capital C and is a genuine county-equivalent; it is
    // caught by the population rule, not by the name rule. And a county named
    // "Salt Lake County" must obviously survive.
    expect(
      shouldRollUpCounty({
        countyName: 'Salt Lake County',
        countyPopulation: 1_200_000,
        members: [{ name: 'Salt Lake City', population: 209_000 }],
      }).create,
    ).toBe(true)
  })

  it('does NOT delete a real county because a multi-county place was misattributed', () => {
    // THE BUG THIS RULE SHIPPED WITH. Dothan city spans Dale, Henry AND Houston
    // County, Alabama; the place->county file gives no population split, so any
    // single attribution is approximate. Attributing Dothan's full 71k to Dale
    // County (pop 49k) read as 143% and deleted Dale County outright -- 185
    // counties were being dropped this way, most of them legitimate.
    //
    // A share above 1.0 is arithmetically impossible for a place inside its
    // county, so it is proof of misattribution, not evidence of an independent
    // city.
    const d = shouldRollUpCounty({
      countyName: 'Dale County',
      countyPopulation: 49_326,
      members: [{ name: 'Dothan city', population: 71_072 }],
    })
    expect(d.create).toBe(true)
    expect(d.reason).toMatch(/span multiple counties and were misattributed/)
  })

  it('still applies the share rule to the members that plausibly belong', () => {
    // A misattributed giant must not mask a genuine dominant place.
    const d = shouldRollUpCounty({
      countyName: 'Somewhere County',
      countyPopulation: 100_000,
      members: [
        { name: 'Elsewhere city', population: 400_000 }, // misattributed, ignored
        { name: 'Dominant city', population: 97_000 }, // real, and 97%
      ],
    })
    expect(d.create).toBe(false)
    expect(d.dominantPlace).toBe('Dominant city')
  })

  it('refuses to create a county whose population is unknown', () => {
    // Not knowing is not permission. Without population we cannot tell an
    // independent city from a real county.
    expect(shouldRollUpCounty({ countyName: 'Somewhere County', countyPopulation: null, members: [] }).create).toBe(false)
  })

  it('sits just either side of the threshold predictably', () => {
    const at = shouldRollUpCounty({
      countyName: 'Test County',
      countyPopulation: 100_000,
      members: [{ name: 'X', population: 95_000 }],
    })
    const below = shouldRollUpCounty({
      countyName: 'Test County',
      countyPopulation: 100_000,
      members: [{ name: 'X', population: 94_000 }],
    })
    expect(at.create).toBe(false)
    expect(below.create).toBe(true)
  })
})

describe('metro creation', () => {
  it('creates Milwaukee metro from real CBSA population', () => {
    // The undercount case: summing incorporated places gave ~700k against a real
    // 1.57M metro. Reading the official CBSA estimate makes this trivially true.
    const d = shouldCreateMetro({ metroPopulation: 1_574_731, anchorCityPopulation: 561_385 })
    expect(d.create).toBe(true)
    expect(d.ratio).toBeGreaterThan(2.5)
  })

  it('skips a metro that is effectively just its anchor city', () => {
    expect(
      shouldCreateMetro({ metroPopulation: 105_000, anchorCityPopulation: 99_500 }).create,
    ).toBe(false)
  })

  it('would have deleted Milwaukee under the old undercounted population', () => {
    // Proof the low threshold matters: at the summed-places figure the ratio is
    // 1.25, which any threshold above ~1.3 would have discarded.
    const d = shouldCreateMetro({ metroPopulation: 700_000, anchorCityPopulation: 561_385 })
    expect(d.ratio).toBeCloseTo(1.25, 2)
    expect(d.create).toBe(true)
  })
})
