import { describe, expect, it } from 'vitest'
import {
  HHT_PX_KEYWORD_TEMPLATES,
  HHT_PX_SERP_OVERLAP_THRESHOLD,
  classifyHhtPxSerpResult,
  estimatedNonduplicatedDemand,
  fillGeoTemplate,
  generateHhtPxKeywords,
  hhtPxArticleLabel,
  hhtPxGeographyKey,
  initialHhtPxGeographies,
  monthlyTrendSlope,
  normalizeHhtPxUrl,
  pickVariantRepresentatives,
  qualityAdjustedProspectsPerSerpCall,
  recommendHhtTargetUrl,
  scoreHhtPxKeyword,
  serpUrlOverlap,
  whyTheyCouldLink,
} from './index.js'

describe('HHT prospecting templates', () => {
  it('keeps unique templates and marks geographic vs national libraries', () => {
    const phrases = HHT_PX_KEYWORD_TEMPLATES.map((row) => row.template)
    expect(new Set(phrases).size).toBe(phrases.length)
    expect(HHT_PX_KEYWORD_TEMPLATES.some((row) => row.template.includes('[GEO]'))).toBe(true)
    expect(HHT_PX_KEYWORD_TEMPLATES.some((row) => row.template === 'best hotels with private hot tubs')).toBe(true)
    expect(HHT_PX_KEYWORD_TEMPLATES.filter((row) => row.variantGroup === 'private_hot_tub_room').length).toBeGreaterThan(1)
  })
})

describe('geography seed', () => {
  it('prioritizes states, HHT cities, regions, and metros without neighborhoods', () => {
    const geos = initialHhtPxGeographies()
    expect(geos.every((row) => row.type !== 'neighborhood')).toBe(true)
    expect(geos.some((row) => row.type === 'state' && row.name === 'Vermont')).toBe(true)
    expect(geos.some((row) => row.type === 'city' && row.name === 'Charleston' && row.hhtSlug === 'south-carolina/charleston')).toBe(true)
    expect(geos.some((row) => row.type === 'destination_region' && row.name === 'Napa Valley')).toBe(true)
    expect(geos.some((row) => row.type === 'metro' && row.name === 'Bay Area')).toBe(true)
    const keys = geos.map(hhtPxGeographyKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('keyword generation', () => {
  it('replaces destination geography and keeps national phrases unscoped', () => {
    const geos = initialHhtPxGeographies().filter((row) => row.name === 'Austin' && row.type === 'city')
    const templates = HHT_PX_KEYWORD_TEMPLATES.filter(
      (row) => row.template === 'romantic hotels in [GEO]' || row.template === 'best hotels with private hot tubs',
    )
    const keywords = generateHhtPxKeywords(templates, geos)
    expect(keywords.some((row) => row.keyword === 'romantic hotels in austin')).toBe(true)
    expect(fillGeoTemplate('romantic hotels in [GEO]', 'New York State')).toBe('romantic hotels in new york state')
    expect(keywords.some((row) => row.keyword === 'best hotels with private hot tubs' && row.geographyKey === null)).toBe(true)
    expect(fillGeoTemplate('romantic trip to [GEO]', 'Napa Valley')).toBe('romantic trip to napa valley')
  })

  it('picks the highest-volume keyword in a geography × variant group', () => {
    const selected = pickVariantRepresentatives([
      { keywordId: 1, geographyId: 9, variantGroup: 'private_hot_tub_room', volume: 300, priorityScore: 80 },
      { keywordId: 2, geographyId: 9, variantGroup: 'private_hot_tub_room', volume: 1000, priorityScore: 80 },
      { keywordId: 3, geographyId: 9, variantGroup: 'private_hot_tub_room', volume: 200, priorityScore: 80 },
      { keywordId: 4, geographyId: 9, variantGroup: 'romantic_hotels', volume: 50, priorityScore: 95 },
    ])
    expect(selected).toEqual(new Set([2, 4]))
  })
})

describe('URL normalization', () => {
  it('drops tracking params, fragments, and trailing slashes', () => {
    expect(
      normalizeHhtPxUrl('HTTP://WWW.Example.com/Path/?utm_source=x&city=austin#section'),
    ).toBe('https://example.com/Path?city=austin')
  })
})

describe('SERP classification', () => {
  it('marks OTAs and social platforms as not prospectable without deleting the raw result', () => {
    const booking = classifyHhtPxSerpResult({
      url: 'https://www.booking.com/hotels/us/austin.html?utm_source=google',
      title: 'Hotels in Austin',
    })
    expect(booking.pageType).toBe('ota')
    expect(booking.isProspectable).toBe(false)
    expect(booking.excludedByRule).toBe(true)

    const editorial = classifyHhtPxSerpResult({
      url: 'https://www.travelandleisure.com/hotels-motels/romantic-hotels-in-austin',
      title: 'The Most Romantic Hotels in Austin',
    })
    expect(editorial.pageType).toBe('national_magazine')
    expect(editorial.isProspectable).toBe(true)
  })

  it('rejects jacuzzi directories, OTAs, and hotel sites that previously defaulted to editorial', () => {
    expect(classifyHhtPxSerpResult({ url: 'https://www.cozycozy.com/us/houston-hotel-jacuzzi' })).toMatchObject({
      pageType: 'ota',
      isProspectable: false,
    })
    expect(classifyHhtPxSerpResult({ url: 'https://roomswithtubs.com/houston-tx/' })).toMatchObject({
      pageType: 'direct_hht_competitor',
      isProspectable: false,
    })
    expect(classifyHhtPxSerpResult({ url: 'https://www.travelmyth.com/Houston/Hotels/jacuzzi_hot_tub' })).toMatchObject({
      pageType: 'direct_hht_competitor',
      isProspectable: false,
    })
    expect(classifyHhtPxSerpResult({ url: 'https://www.tubstays.com/texas/houston' })).toMatchObject({
      pageType: 'direct_hht_competitor',
      isProspectable: false,
    })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://www.hotelzaza.com/houston-museum-district/rooms-suites/magseven/blacklabel',
      }),
    ).toMatchObject({ pageType: 'hotel', isProspectable: false })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://www.crownreef.com/accommodations/oceanfront-whirlpool-king-1-bedroom-suite-sleeps-6/',
      }),
    ).toMatchObject({ pageType: 'hotel', isProspectable: false })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://brasstownvalley.com/romantic-getaway-to-brasstown-valley-resort-spa/',
      }),
    ).toMatchObject({ pageType: 'hotel', isProspectable: false })
  })

  it('keeps blogs and magazine articles as prospectable', () => {
    expect(
      classifyHhtPxSerpResult({
        url: 'https://jessieonajourney.com/hotels-with-private-hot-tubs-in-room-in-san-diego/',
      }),
    ).toMatchObject({ pageType: 'travel_blog', isProspectable: true })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://www.cntraveler.com/story/hotels-with-jacuzzi-in-room',
      }),
    ).toMatchObject({ pageType: 'national_magazine', isProspectable: true })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://www.tripinn.com/blog/romantic-hotels-in-michigan/',
      }),
    ).toMatchObject({ pageType: 'travel_blog', isProspectable: true })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://www.midwestliving.com/romantic-getaways-in-ohio-8426869',
      }),
    ).toMatchObject({ pageType: 'national_magazine', isProspectable: true })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://localloveandwanderlust.com/romantic-adventure-getaways-ohio/',
      }),
    ).toMatchObject({ pageType: 'travel_blog', isProspectable: true })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://ohio.org/travel-inspiration/articles/romantic-winter-getaways-in-ohio',
      }),
    ).toMatchObject({ pageType: 'tourism_board', isProspectable: true })
    expect(
      classifyHhtPxSerpResult({
        url: 'https://www.cntraveler.com/gallery/romantic-getaways-new-york',
      }),
    ).toMatchObject({ pageType: 'national_magazine', isProspectable: true })
  })
})

describe('scoring', () => {
  it('prefers prospect density over raw search volume', () => {
    const highVolumeJunk = scoreHhtPxKeyword({
      prospectableDensity: 2 / 20,
      editorialDensity: 2 / 20,
      avgMonthlySearches: 30_000,
      cluster: 'hotel_hot_tubs',
      inventoryFit: 80,
      uniqueProspectDomains: 2,
      resultCount: 20,
      clusterYield: null,
      serpChecked: true,
    })
    const lowerVolumeEditorial = scoreHhtPxKeyword({
      prospectableDensity: 13 / 20,
      editorialDensity: 15 / 20,
      avgMonthlySearches: 2_000,
      cluster: 'romantic_getaways',
      inventoryFit: 80,
      uniqueProspectDomains: 12,
      resultCount: 20,
      clusterYield: null,
      serpChecked: true,
    })
    expect(highVolumeJunk).not.toBeNull()
    expect(lowerVolumeEditorial).not.toBeNull()
    expect(lowerVolumeEditorial!).toBeGreaterThan(highVolumeJunk!)
  })

  it('does not sum synonymous keyword volumes', () => {
    expect(estimatedNonduplicatedDemand([1000, 300, 200])).toBe(1000)
  })

  it('treats overlapping SERPs as equivalent above the 70% threshold', () => {
    const overlap = serpUrlOverlap(
      ['https://a.com/1', 'https://b.com/1', 'https://c.com/1'],
      ['https://a.com/1', 'https://b.com/1', 'https://c.com/1', 'https://d.com/1'],
    )
    expect(overlap).toBeGreaterThan(HHT_PX_SERP_OVERLAP_THRESHOLD - 0.01)
    expect(overlap).toBeLessThan(1)
  })
})

describe('article labels', () => {
  it('falls back to the URL slug when Semrush omits a title', () => {
    expect(hhtPxArticleLabel(null, 'https://www.cntraveler.com/gallery/best-hotels-with-hot-tubs')).toBe(
      'best hotels with hot tubs',
    )
    expect(hhtPxArticleLabel('Editors’ pick', 'https://www.cntraveler.com/gallery/best-hotels-with-hot-tubs')).toBe(
      'Editors’ pick',
    )
  })
})

describe('HHT targeting', () => {
  it('recommends the city page before the state page', () => {
    const target = recommendHhtTargetUrl({
      cluster: 'romantic_hotels',
      geographies: [
        { name: 'South Carolina', type: 'state', state: 'South Carolina', hhtSlug: 'south-carolina' },
        { name: 'Charleston', type: 'city', state: 'South Carolina', hhtSlug: 'south-carolina/charleston' },
      ],
    })
    expect(target.url).toBe('https://hotelhottubs.com/south-carolina/charleston')
    expect(whyTheyCouldLink({ cluster: 'adjacent_amenities', geographyName: 'Vermont', pageTitle: 'Hotels With Fireplaces in Vermont' }).category).toBe(
      'amenity_extension',
    )
  })
})

describe('seasonality', () => {
  it('stores a 12-month slope instead of treating seasonal demand as a single number', () => {
    const slope = monthlyTrendSlope([
      { year: 2025, month: 1, searchVolume: 100 },
      { year: 2025, month: 2, searchVolume: 110 },
      { year: 2025, month: 3, searchVolume: 90 },
      { year: 2025, month: 10, searchVolume: 400 },
      { year: 2025, month: 11, searchVolume: 420 },
      { year: 2025, month: 12, searchVolume: 380 },
    ])
    expect(slope).toBeGreaterThan(1)
    expect(qualityAdjustedProspectsPerSerpCall({ serpCount: 10, prospectablePages: 80, avgPageScore: 50 })).toBe(4)
  })
})
