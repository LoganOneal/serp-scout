import { describe, expect, it } from 'vitest'
import {
  buildHotelBlContentClusters,
  classifyHotelBlPageType,
  classifyHotelBlSiteControl,
  hotelBlBrandControlSegment,
  hotelBlSourceRelationshipType,
  hotelBlSourceKey,
  isFollowedHotelBlLink,
  normalizeHotelBlUrl,
  recommendHotelBlContent,
  scoreHotelBlFeasibility,
  scoreHotelBlLinkValue,
  scoreHotelBlPriority,
} from './hotel-backlink-scout.js'
import { validateHotelBlSourceUrl } from './hotel-backlink-validation.js'

describe('Hotel Backlink Scout normalization and classification', () => {
  it('normalizes protocol, www, tracking parameters, query order, and root domain', () => {
    expect(normalizeHotelBlUrl('http://WWW.Example.CO.UK//press/?utm_source=x&b=2&a=1#coverage')).toEqual({
      url: 'https://example.co.uk/press?a=1&b=2',
      hostname: 'example.co.uk',
      rootDomain: 'example.co.uk',
    })
    expect(normalizeHotelBlUrl('mailto:press@example.com')).toBeNull()
  })

  it('dedupes a hotel by name and geography even when its source URL changes', () => {
    const first = hotelBlSourceKey({ hotelName: 'The Cedar Hotel', city: 'Austin', state: 'TX', sourceUrl: 'https://old.example' })
    const second = hotelBlSourceKey({ hotelName: 'The Cedar Hotel', city: 'Austin', state: 'TX', sourceUrl: 'https://new.example' })
    expect(first).toBe(second)
  })

  it('classifies centralized brand paths without treating each hotel as an independent crawl target', () => {
    expect(classifyHotelBlSiteControl({
      hotelName: 'Hilton Austin',
      hostname: 'hilton.com',
      rootDomain: 'hilton.com',
      sourceUrl: 'https://hilton.com/en/hotels/auscvhh-hilton-austin',
      hotelCount: 1_200,
    })).toMatchObject({
      siteControlType: 'brand_property_page',
      brandName: 'Hilton',
      centralizedBrand: true,
      confidence: 0.98,
    })
  })

  it('treats a single hotel/domain match as a strong independent signal, not proof', () => {
    const result = classifyHotelBlSiteControl({
      hotelName: 'Cedar House Hotel',
      hostname: 'cedarhousehotel.com',
      rootDomain: 'cedarhousehotel.com',
      sourceUrl: 'https://cedarhousehotel.com/',
      hotelCount: 1,
    })
    expect(result.siteControlType).toBe('independent_property')
    expect(result.confidence).toBeLessThan(0.9)
  })

  it('uses source classifications as relationship and cohort signals without making them site-control truth', () => {
    expect(hotelBlSourceRelationshipType({
      sourceLinkType: 'Ownership company',
      siteControlType: 'unknown',
      centralizedBrand: false,
    })).toBe('owner')
    expect(hotelBlBrandControlSegment({
      sourceLinkType: 'Soft brand — Curio Collection',
      siteControlType: 'brand_property_page',
      centralizedBrand: true,
    })).toBe('soft_brand')
  })

  it('separates a locality tourism board from the hotel website it mentions', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Viking Motel',
      city: 'Ventura',
      state: 'California',
      sourceUrl: 'https://visitventuraca.com/',
      sourceLinkType: 'property_site',
      listingStatus: 200,
      listingProminentNames: ['Viking Motel'],
      candidateStatus: 200,
      candidateTitle: 'Visit Ventura CA | Official Visitor Guide',
      candidateHeadings: ['Things to do in Ventura'],
      candidateOrganizationNames: ['Visit Ventura'],
      candidateText: 'Plan your trip to Ventura, California.',
    })).toMatchObject({
      entityScope: 'locality',
      entityType: 'tourism_board',
      status: 'locality',
      listingMatched: true,
    })
  })

  it('confirms a matching property page using prominent identity and location evidence', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Mokara Hotel Spa San Antonio',
      city: 'San Antonio',
      state: 'Texas',
      sourceUrl: 'https://www.omnihotels.com/hotels/san-antonio-mokara',
      listingStatus: 200,
      listingProminentNames: ['Mokara Hotel & Spa'],
      candidateStatus: 200,
      candidateFinalUrl: 'https://www.omnihotels.com/hotels/san-antonio-mokara',
      candidateTitle: 'Mokara Hotel & Spa | San Antonio, TX',
      candidateHeadings: ['Mokara Hotel & Spa'],
      candidateLodgingNames: ['Mokara Hotel & Spa'],
      candidateText: '212 W Crockett St, San Antonio, Texas',
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_property',
      status: 'confirmed',
      listingMatched: true,
    })
  })

  it('flags a different lodging property instead of accepting the CSV label', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Franklin House',
      city: 'Boise',
      state: 'Idaho',
      sourceUrl: 'https://otherhotel.example/',
      sourceLinkType: 'property_site',
      listingStatus: 200,
      listingProminentNames: ['Franklin House'],
      candidateStatus: 200,
      candidateTitle: 'Riverside Lodge Hotel',
      candidateHeadings: ['Riverside Lodge Hotel'],
      candidateLodgingNames: ['Riverside Lodge Hotel'],
      candidateText: 'Portland, Oregon',
    })).toMatchObject({
      entityScope: 'hotel',
      status: 'mismatch',
    })
  })

  it('does not confuse a hotel brand containing “destinations” with a locality organization', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Club Wyndham La Cascada',
      city: 'San Antonio',
      state: 'Texas',
      sourceUrl: 'https://wyndhamdestinations.com/us/en/resorts/club-wyndham-la-cascada',
      sourceLinkType: 'brand_property_page',
      listingStatus: 200,
      listingProminentNames: ['Club Wyndham La Cascada'],
      candidateStatus: 200,
      candidateFinalUrl: 'https://www.wyndhamdestinations.com/',
      candidateTitle: 'Timeshares and Vacation Ownership — Wyndham Destinations',
      candidateOrganizationNames: ['Wyndham Destinations'],
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_brand',
      status: 'ambiguous',
    })
  })

  it('uses an official blocked brand path as hotel evidence without claiming page validation', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'The Emily Morgan a Doubletree by Hilton',
      city: 'San Antonio',
      state: 'Texas',
      sourceUrl: 'https://hilton.com/en/hotels/sataadt-the-emily-morgan-san-antonio-a-doubletree-by-hilton-hotel',
      candidateStatus: 403,
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_brand',
      status: 'ambiguous',
    })
  })

  it('rejects a same-city hotel URL when its state conflicts with the listing', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Wampler House Boutique Hotel',
      city: 'Bloomington',
      state: 'Minnesota',
      sourceUrl: 'https://wamplerhouse.com/',
      listingStatus: 200,
      listingProminentNames: [],
      candidateStatus: 200,
      candidateTitle: 'Wampler House Boutique Hotel | Bloomington Indiana Lodging',
      candidateHeadings: ['Wampler House Boutique Hotel', 'Bloomington, Indiana'],
      candidateText: 'Bloomington, Indiana',
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_property',
      status: 'mismatch',
      conflictingState: 'Indiana',
      listingMatched: false,
    })
  })

  it('does not treat a state word inside the city name as a conflicting state', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Microtel Inn & Suites by Wyndham Michigan City',
      city: 'Michigan City',
      state: 'Indiana',
      sourceUrl: 'https://wyndhamhotels.com/microtel/michigan-city-indiana/microtel-inn-and-suites-michigan-city/overview',
      listingStatus: 200,
      listingProminentNames: ['Microtel Inn & Suites by Wyndham Michigan City'],
      candidateStatus: 200,
      candidateTitle: 'Microtel Inn & Suites by Wyndham Michigan City | Michigan City, IN Hotels',
      candidateHeadings: ['Microtel Inn & Suites by Wyndham Michigan City'],
      candidateOrganizationNames: ['Wyndham Hotels & Resorts'],
      candidateText: 'Michigan City, IN Hotels',
    })).toMatchObject({
      entityScope: 'hotel',
      status: 'confirmed',
      conflictingState: null,
    })
  })

  it('does not classify normal hotel destination copy as a locality entity', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Wingate By Wyndham Little Rock',
      city: 'Little Rock',
      state: 'Arkansas',
      sourceUrl: 'https://wyndhamhotels.com/wingate/little-rock-arkansas/wingate-by-wyndham-little-rock/overview',
      listingStatus: 200,
      listingProminentNames: ['Wingate By Wyndham Little Rock'],
      candidateStatus: 200,
      candidateTitle: 'Wingate by Wyndham Little Rock | Little Rock, AR Hotels',
      candidateHeadings: ['Wingate by Wyndham Little Rock', 'Visit Little Rock', 'Explore the Area'],
      candidateOrganizationNames: ['Wyndham Hotels & Resorts'],
      candidateText: 'Little Rock Arkansas',
    })).toMatchObject({
      entityScope: 'hotel',
      status: 'confirmed',
    })
  })

  it('still identifies a locality guide that happens to list the hotel deeper on the page', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Beach Inn Motel',
      city: 'Long Beach',
      state: 'California',
      sourceUrl: 'https://longbeach-us.com/',
      listingStatus: 200,
      listingProminentNames: ['Beach Inn Motel'],
      candidateStatus: 200,
      candidateTitle: 'Long Beach - United States',
      candidateHeadings: ['Long Beach', 'Why Visit Long Beach', 'Things to do in Long Beach', 'Where to Stay in Long Beach'],
      candidateText: 'Long Beach California',
    })).toMatchObject({
      entityScope: 'locality',
      entityType: 'locality_guide',
      status: 'locality',
    })
  })

  it('does not mistake a hotel-owned “visit” domain for a tourism board', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'At the Craters Edge',
      city: 'Hawaii Volcanoes National Park',
      state: 'Hawaii',
      sourceUrl: 'https://visitthevolcano.com/',
      listingStatus: 200,
      listingProminentNames: ['At the Craters Edge'],
      candidateStatus: 200,
      candidateTitle: "At the Crater's Edge - Luxury Volcano Hawaii Accommodations",
      candidateHeadings: ['Home Page', 'At the Craters Edge', 'Our Rooms'],
      candidateOrganizationNames: ["At the Crater's Edge"],
      candidateText: 'Hawaii Volcanoes National Park Hawaii',
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_property',
      status: 'confirmed',
    })
  })

  it('does not mistake a hotel booking CTA for a third-party directory', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Casa Sedona Inn',
      city: 'Sedona',
      state: 'Arizona',
      sourceUrl: 'https://casasedona.com/',
      listingStatus: 200,
      listingProminentNames: ['Casa Sedona Inn'],
      candidateStatus: 200,
      candidateTitle: 'Casa Sedona Inn | Boutique Hotel in Sedona Arizona',
      candidateHeadings: ['Casa Sedona Inn', 'Book Your Room', 'Hotel Deals'],
      candidateLodgingNames: ['Casa Sedona Inn'],
      candidateText: 'Sedona Arizona',
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_property',
      status: 'confirmed',
    })
  })

  it('classifies a vacation-rental catalog separately from a locality guide', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Cove Lakefront Chalet',
      city: 'Big Bear Lake',
      state: 'California',
      sourceUrl: 'https://bigbearvacations.com/',
      listingStatus: 200,
      listingProminentNames: [],
      candidateStatus: 200,
      candidateTitle: 'Big Bear Cabins & Vacation Rentals | Experience Big Bear Lake',
      candidateHeadings: ['Hot Tub Cabins', 'Lake Front Cabin Rentals', 'Recommended Properties', 'Things To Do'],
      candidateText: 'Big Bear Lake California',
    })).toMatchObject({
      entityScope: 'other',
      entityType: 'vacation_rental_operator',
      status: 'non_hotel',
    })
  })

  it('does not let an operator name embedded in a rental title impersonate the property', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'All About Fun-1149 by Big Bear Vacations',
      city: 'CA',
      state: 'California',
      sourceUrl: 'https://bigbearvacations.com/',
      listingStatus: 200,
      listingProminentNames: ['All About Fun-1149 by Big Bear Vacations'],
      candidateStatus: 200,
      candidateTitle: 'Big Bear Cabins & Vacation Rentals | Experience Big Bear Lake',
      candidateHeadings: ['Hot Tub Cabins', 'Recommended Properties', 'Things To Do'],
      candidateText: 'Big Bear Lake California',
    })).toMatchObject({
      entityScope: 'other',
      entityType: 'vacation_rental_operator',
      status: 'non_hotel',
    })
  })

  it('keeps a named resort-lodging operator separate from its property listing', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'The Caledonian By All Seasons Resort Lodging',
      city: 'Park City',
      state: 'Utah',
      sourceUrl: 'https://allseasonsresortlodging.com/park-city/rentals/the-caledonian',
      listingStatus: 200,
      listingProminentNames: ['The Caledonian By All Seasons Resort Lodging'],
      candidateStatus: 200,
      candidateTitle: 'The Caledonian | Park City Vacation Rentals',
      candidateHeadings: ['The Caledonian', 'Recommended Properties'],
      candidateLodgingNames: ['The Caledonian'],
      candidateText: 'Park City Utah',
    })).toMatchObject({
      entityScope: 'other',
      entityType: 'vacation_rental_operator',
      status: 'non_hotel',
    })
  })

  it('keeps a matching property-owned vacation-rental site in the hotel bucket', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Gondola Lodge & Tahoe Beach Club',
      city: 'South Lake Tahoe',
      state: 'California',
      sourceUrl: 'https://gondolalodge.us/',
      listingStatus: 200,
      listingProminentNames: ['Gondola Lodge & Tahoe Beach Club'],
      candidateStatus: 200,
      candidateTitle: 'Vacation Rentals | Gondola Lodge + Free Beach Pass',
      candidateHeadings: ['Stay in Lake Tahoe at Gondola Lodge by Heavenly', 'Premiere location vacation rentals'],
      candidateText: 'South Lake Tahoe California',
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_property',
      status: 'confirmed',
    })
  })

  it('keeps an official resort-brand root separate from rental directories', () => {
    expect(validateHotelBlSourceUrl({
      hotelName: 'Margaritaville Island Hotel',
      city: 'Pigeon Forge',
      state: 'Tennessee',
      sourceUrl: 'https://margaritavilleresorts.com/',
      listingStatus: 200,
      listingProminentNames: ['Margaritaville Island Hotel'],
      candidateStatus: 200,
      candidateTitle: 'Home | Margaritaville Resorts & Hotels',
      candidateHeadings: ['Margaritaville Hotels & Resorts', 'Margaritaville Vacation Rental Resorts'],
      candidateOrganizationNames: ['Margaritaville Hotels & Resorts'],
      candidateText: 'Pigeon Forge Tennessee',
    })).toMatchObject({
      entityScope: 'hotel',
      entityType: 'hotel_brand',
      status: 'ambiguous',
    })
  })

  it('classifies relevant paths and normal links as followed', () => {
    expect(classifyHotelBlPageType('https://hotel.test/in-the-press')).toBe('press')
    expect(classifyHotelBlPageType('https://hotel.test/accolades')).toBe('accolades')
    expect(isFollowedHotelBlLink(null)).toBe(true)
    expect(isFollowedHotelBlLink('noopener nofollow')).toBe(false)
    expect(isFollowedHotelBlLink('sponsored')).toBe(false)
  })
})

describe('Hotel Backlink Scout scoring', () => {
  it('keeps the five feasibility components visible and capped at their documented weights', () => {
    const result = scoreHotelBlFeasibility({
      siteControlType: 'independent_property',
      externalPressLinkCount: 14,
      dofollowExternalPressLinkCount: 11,
      hasPressPage: true,
      hasAwardsPage: true,
      hasBlogOrNews: true,
      hasNamedPrContact: true,
      hasPrEmail: true,
      freshnessDays: 120,
    })
    expect(result).toEqual({
      score: 100,
      components: {
        editorialLinkBehavior: 30,
        siteControlAutonomy: 25,
        editorialSurface: 20,
        contactability: 15,
        freshness: 10,
      },
    })
  })

  it('normalizes traffic logarithmically and rewards a genuinely new referring domain', () => {
    const low = scoreHotelBlLinkValue({ authorityScore: 40, organicTraffic: 1_000, topicalRelevance: 100, recommendedContentType: 'city_roundup', alreadyLinksToHht: true })
    const high = scoreHotelBlLinkValue({ authorityScore: 40, organicTraffic: 1_000_000, topicalRelevance: 100, recommendedContentType: 'city_roundup', alreadyLinksToHht: false })
    expect(high.components.organicTraffic).toBe(25)
    expect(high.components.newReferringDomain).toBe(10)
    expect(high.score).toBeGreaterThan(low.score)
  })

  it('penalizes effort after combining feasibility, value, and fit', () => {
    expect(scoreHotelBlPriority({ feasibility: 80, linkValue: 80, contentFit: 80, effort: 20 })).toBe(72)
    expect(scoreHotelBlPriority({ feasibility: 80, linkValue: 80, contentFit: 80, effort: 80 })).toBe(48)
  })

  it('recommends a real-criteria ranking for an awards-active hotel', () => {
    expect(recommendHotelBlContent({ hotelName: 'Cedar House', city: 'Austin', state: 'TX', existingHhtUrl: 'https://hotelhottubs.com/cedar', hasPressPage: true, hasAwardsPage: true, hasBlogOrNews: true })).toMatchObject({
      contentType: 'ranking_or_award',
      score: 94,
    })
  })

  it('clusters multi-hotel geographies and ranks them by aggregate opportunity', () => {
    const clusters = buildHotelBlContentClusters([
      { hotelId: 1, hotelName: 'A', city: 'Austin', state: 'TX', feasibilityScore: 80, priorityScore: 70, rootDomain: 'a.test' },
      { hotelId: 2, hotelName: 'B', city: 'Austin', state: 'TX', feasibilityScore: 75, priorityScore: 60, rootDomain: 'b.test' },
      { hotelId: 3, hotelName: 'C', city: 'Dallas', state: 'TX', feasibilityScore: 40, priorityScore: 30, rootDomain: 'c.test' },
    ])
    expect(clusters.some((cluster) => cluster.contentType === 'city_roundup' && cluster.hotelCount === 2)).toBe(true)
    expect(clusters.some((cluster) => cluster.contentType === 'state_roundup' && cluster.hotelCount === 3)).toBe(true)
  })

  it('merges punctuation variants before generating a unique content slug', () => {
    const clusters = buildHotelBlContentClusters([
      { hotelId: 1, hotelName: 'A', city: 'St. Augustine', state: 'Florida', feasibilityScore: 80, priorityScore: 70, rootDomain: 'a.test' },
      { hotelId: 2, hotelName: 'B', city: 'St Augustine', state: 'Florida', feasibilityScore: 75, priorityScore: 60, rootDomain: 'b.test' },
    ])
    const cityClusters = clusters.filter((cluster) => cluster.contentType === 'city_roundup')

    expect(cityClusters).toHaveLength(1)
    expect(cityClusters[0]).toMatchObject({
      hotelCount: 2,
      suggestedSlug: 'best-hotels-with-private-hot-tubs-st-augustine-florida',
    })
  })

  it('does not invent a roundup from multiple entity relationships for one hotel', () => {
    const clusters = buildHotelBlContentClusters([
      { hotelId: 1, hotelName: 'Cedar House', city: 'Austin', state: 'TX', feasibilityScore: 80, priorityScore: 70, rootDomain: 'hotel.test' },
      { hotelId: 1, hotelName: 'Cedar House', city: 'Austin', state: 'TX', feasibilityScore: 75, priorityScore: 60, rootDomain: 'manager.test' },
    ])

    expect(clusters).toEqual([])
  })
})
