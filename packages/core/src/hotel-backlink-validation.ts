import { HOTEL_BL_BRAND_RULES, normalizeHotelBlUrl } from './hotel-backlink-scout.js'

export const HOTEL_BL_ENTITY_SCOPES = ['hotel', 'locality', 'other', 'unknown'] as const
export type HotelBlEntityScope = (typeof HOTEL_BL_ENTITY_SCOPES)[number]

export const HOTEL_BL_ENTITY_TYPES = [
  'hotel_property',
  'hotel_brand',
  'management_company',
  'owner',
  'pr_agency',
  'tourism_board',
  'locality_guide',
  'vacation_rental_operator',
  'booking_directory',
  'travel_media',
  'other_non_hotel',
  'unknown',
] as const
export type HotelBlEntityType = (typeof HOTEL_BL_ENTITY_TYPES)[number]

export const HOTEL_BL_URL_VALIDATION_STATUSES = [
  'confirmed',
  'corrected_redirect',
  'locality',
  'non_hotel',
  'mismatch',
  'unreachable',
  'missing',
  'ambiguous',
] as const
export type HotelBlUrlValidationStatus = (typeof HOTEL_BL_URL_VALIDATION_STATUSES)[number]

const NAME_STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'hotel', 'hotels', 'inn', 'lodge', 'motel', 'of', 'resort', 'spa', 'suites', 'the',
])

function normalizedWords(value: string | null | undefined, removeGeneric = false): string[] {
  return (value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !removeGeneric || !NAME_STOP_WORDS.has(word))
}

export function hotelBlIdentitySimilarity(expected: string, observed: string): number {
  const expectedAll = normalizedWords(expected)
  const observedAll = normalizedWords(observed)
  if (expectedAll.length === 0 || observedAll.length === 0) return 0
  const exactExpected = expectedAll.join(' ')
  const exactObserved = observedAll.join(' ')
  if (exactObserved.includes(exactExpected) || exactExpected.includes(exactObserved)) return 1

  const expectedSpecific = normalizedWords(expected, true)
  const observedSpecific = normalizedWords(observed, true)
  const observedSet = new Set(observedSpecific)
  const tokens = expectedSpecific.length > 0 ? expectedSpecific : expectedAll
  const overlap = tokens.filter((word) => observedSet.has(word)).length
  const observedAllSet = new Set(observedAll)
  const allOverlap = expectedAll.filter((word) => observedAllSet.has(word)).length
  const recall = overlap / tokens.length
  const precision = overlap / Math.max(1, observedSpecific.length)
  const specificScore = tokens.length === 1 ? 0 : recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0
  return Math.round(Math.max(specificScore, allOverlap / expectedAll.length) * 1000) / 1000
}

function containsLocation(haystack: string, value: string | null | undefined): boolean {
  const location = normalizedWords(value).join(' ')
  if (!location) return false
  return ` ${normalizedWords(haystack).join(' ')} `.includes(` ${location} `)
}

function bestSimilarity(hotelName: string, values: readonly string[]): number {
  return values.reduce((best, value) => Math.max(best, hotelBlIdentitySimilarity(hotelName, value)), 0)
}

function hostnameIdentitySimilarity(hotelName: string, hostname: string): number {
  const lexical = hotelBlIdentitySimilarity(hotelName, hostname.replace(/\./g, ' '))
  const label = hostname.toLowerCase().replace(/^www\./, '').split('.')[0]?.replace(/[^a-z0-9]/g, '') ?? ''
  const meaningfulWords = normalizedWords(hotelName).filter((word) => word.length >= 4)
  const matches = meaningfulWords.filter((word) => label.includes(word)).length
  return matches >= 2 ? Math.max(lexical, matches / Math.min(3, meaningfulWords.length)) : lexical
}

const LOCALITY_HOST_PATTERN = /(?:^|\.)(?:(?:visit|explore|discover|experience|destination)[a-z0-9-]*|(?:tourism|visitors?|convention|cvb|destination)[a-z0-9-]*)\./i
const LOCALITY_TEXT_PATTERN = /official (?:travel|tourism|visitor)|(?:convention|tourism) (?:and )?visitors? bureau|destination marketing organization|visitor(?:s|')? (?:bureau|center)/i
const LOCALITY_GUIDE_TEXT_PATTERN = /visitor guide|things to do|plan your (?:trip|visit)|explore (?:the )?(?:city|region|area)|where to stay/i
const DIRECTORY_HOST_PATTERN = /(?:^|\.)(?:booking|expedia|hotels|kayak|orbitz|priceline|travelocity|tripadvisor|trivago|yelp)\./i
const TRAVEL_MEDIA_HOST_PATTERN = /(?:^|\.)(?:audleytravel|travelpricedrops|lonelyplanet|fodors|frommers|travelandleisure|cntraveler)\./i
const DIRECTORY_TEXT_PATTERN = /compare (?:hotel )?prices|reviews and prices|search (?:hundreds|thousands) of (?:hotels|properties)|prices from multiple (?:booking )?sites/i
const VACATION_DIRECTORY_TEXT_PATTERN = /vacation rentals?|cabin rentals?|verified (?:and |& )?trusted listings|recommended properties/i
const VACATION_OPERATOR_HOST_PATTERN = /(?:^|\.)(?:allseasonsresortlodging)\./i

export interface HotelBlUrlValidationInput {
  hotelName: string
  city?: string | null
  state?: string | null
  sourceUrl?: string | null
  sourceLinkType?: string | null
  listingUrl?: string | null
  listingStatus?: number | null
  listingFinalUrl?: string | null
  listingProminentNames?: readonly string[]
  listingText?: string | null
  listingAddress?: string | null
  candidateStatus?: number | null
  candidateFinalUrl?: string | null
  candidateTitle?: string | null
  candidateHeadings?: readonly string[]
  candidateLodgingNames?: readonly string[]
  candidateOrganizationNames?: readonly string[]
  candidateText?: string | null
}

export interface HotelBlUrlValidationResult {
  entityScope: HotelBlEntityScope
  entityType: HotelBlEntityType
  status: HotelBlUrlValidationStatus
  confidence: number
  reason: string
  correctedUrl: string | null
  listingMatched: boolean
  listingNameScore: number
  candidateNameScore: number
  cityMatched: boolean
  stateMatched: boolean
  conflictingState: string | null
}

const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky',
  'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico',
  'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
] as const

const US_STATE_CODES: Record<(typeof US_STATE_NAMES)[number], string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO',
  Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
}

function conflictingState(prominentText: string, expected: string | null | undefined): string | null {
  const expectedName = normalizedWords(expected).join(' ')
  const normalized = ` ${normalizedWords(prominentText).join(' ')} `
  if (!expectedName || normalized.includes(` ${expectedName} `)) return null
  const expectedState = US_STATE_NAMES.find((state) => normalizedWords(state).join(' ') === expectedName)
  const expectedCode = expectedState ? US_STATE_CODES[expectedState] : null
  if (expectedCode) {
    const contextualCode = new RegExp(`(?:,\\s*${expectedCode}\\b|\\b${expectedCode}\\s+(?:hotels?|lodging|resorts?|motels?|inns?|\\d{5}\\b))`, 'i')
    if (contextualCode.test(prominentText)) return null
  }
  return US_STATE_NAMES.find((state) => normalized.includes(` ${normalizedWords(state).join(' ')} `)) ?? null
}

/**
 * Classifies the role of an imported URL and validates whether it identifies the
 * hotel represented by the source listing. CSV labels are deliberately excluded
 * from the strongest proof paths: they are hints, not ground truth.
 */
export function validateHotelBlSourceUrl(input: HotelBlUrlValidationInput): HotelBlUrlValidationResult {
  const source = normalizeHotelBlUrl(input.sourceUrl)
  const candidate = normalizeHotelBlUrl(input.candidateFinalUrl ?? input.sourceUrl)
  const listingNames = input.listingProminentNames ?? []
  const listingNameScore = Math.max(
    bestSimilarity(input.hotelName, listingNames),
    hotelBlIdentitySimilarity(input.hotelName, input.listingText ?? ''),
  )
  // Listings often shorten a property name by dropping a city/brand suffix.
  const listingMatched = Boolean(input.listingStatus && input.listingStatus < 400 && listingNameScore >= 0.6)
  const base = {
    correctedUrl: null,
    listingMatched,
    listingNameScore,
    candidateNameScore: 0,
    cityMatched: false,
    stateMatched: false,
    conflictingState: null,
  }
  if (!source) {
    return {
      ...base,
      entityScope: 'unknown',
      entityType: 'unknown',
      status: 'missing',
      confidence: 1,
      reason: 'The inventory row has no valid candidate website URL.',
    }
  }
  const sourcePath = new URL(source.url).pathname.replace(/[-_/]+/g, ' ')
  const pathNameScore = hotelBlIdentitySimilarity(input.hotelName, sourcePath)
  const sourceBrand = HOTEL_BL_BRAND_RULES.find((rule) => rule.rootDomains.includes(source.rootDomain))
  if (!input.candidateStatus || input.candidateStatus >= 400 || !candidate) {
    const sourceCallsItBrandPage = /brand_property_page|brand property page/i.test(input.sourceLinkType ?? '')
    if ((sourceBrand || sourceCallsItBrandPage) && pathNameScore >= 0.6 && new URL(source.url).pathname !== '/') {
      return {
        ...base,
        entityScope: 'hotel',
        entityType: 'hotel_brand',
        status: 'ambiguous',
        confidence: 0.78,
        candidateNameScore: pathNameScore,
        reason: `The ${sourceBrand ? `official ${sourceBrand.brandName}` : 'brand-classified'} property path matches the hotel name, but bot protection prevented page-content validation.`,
      }
    }
    return {
      ...base,
      entityScope: 'unknown',
      entityType: 'unknown',
      status: 'unreachable',
      confidence: 0.9,
      reason: input.candidateStatus
        ? `The candidate website returned HTTP ${input.candidateStatus}.`
        : 'The candidate website could not be reached.',
    }
  }

  // Candidate identity must come from the page's primary identity, not from an
  // arbitrary hotel card buried deep on a directory or destination page.
  const primaryHeadings = (input.candidateHeadings ?? []).slice(0, 8)
  const prominent = [
    input.candidateTitle ?? '',
    ...primaryHeadings,
    ...(input.candidateLodgingNames ?? []),
    ...(input.candidateOrganizationNames ?? []),
  ].filter(Boolean)
  const candidateNameScore = bestSimilarity(input.hotelName, prominent)
  const candidateText = [
    ...prominent,
    ...(input.candidateOrganizationNames ?? []),
    input.candidateText ?? '',
  ].join(' ')
  const cityMatched = containsLocation(candidateText, input.city)
  const stateMatched = containsLocation(candidateText, input.state)
  const hostname = candidate.hostname
  const organizationText = [
    input.candidateTitle ?? '',
    ...(input.candidateHeadings ?? []).slice(0, 8),
    ...(input.candidateOrganizationNames ?? []),
  ].join(' ')
  const stateConflict = conflictingState(organizationText, input.state)
  const finalBase = { ...base, candidateNameScore, cityMatched, stateMatched, conflictingState: stateConflict }
  const knownBrand = HOTEL_BL_BRAND_RULES.find((rule) => rule.rootDomains.includes(candidate.rootDomain))
  const hostnameIdentityScore = hostnameIdentitySimilarity(input.hotelName, hostname)

  const localityHost = LOCALITY_HOST_PATTERN.test(`${hostname}.`)
  const strongLocalityText = LOCALITY_TEXT_PATTERN.test(organizationText) && candidateNameScore < 0.55
  const localityGuide = LOCALITY_GUIDE_TEXT_PATTERN.test(organizationText) && candidateNameScore < 0.35
  const structuredHotelIdentity = bestSimilarity(input.hotelName, [
    ...(input.candidateLodgingNames ?? []),
    ...(input.candidateOrganizationNames ?? []),
  ]) >= 0.6
  const hotelIdentityOverridesHost = listingMatched && !stateConflict && (
    structuredHotelIdentity || (candidateNameScore >= 0.88 && (cityMatched || stateMatched))
  )
  const propertyIdentityOverridesCatalog = listingMatched && !stateConflict && (cityMatched || stateMatched) && candidateNameScore >= 0.5 && hostnameIdentityScore >= 0.6
  const vacationDirectory = !knownBrand && (
    VACATION_OPERATOR_HOST_PATTERN.test(`${hostname}.`) ||
    (!propertyIdentityOverridesCatalog && VACATION_DIRECTORY_TEXT_PATTERN.test(organizationText) && candidateNameScore < 0.55 && !structuredHotelIdentity)
  )
  if (vacationDirectory) {
    return {
      ...finalBase,
      entityScope: 'other',
      entityType: 'vacation_rental_operator',
      status: 'non_hotel',
      confidence: 0.93,
      reason: 'The candidate is a vacation-rental catalog or operator rather than the listed hotel website.',
    }
  }
  if ((localityHost && !hotelIdentityOverridesHost) || strongLocalityText || localityGuide) {
    const tourismBoard = /tourism|visitor|convention|cvb|destination/i.test(`${hostname} ${organizationText}`)
    return {
      ...finalBase,
      entityScope: 'locality',
      entityType: tourismBoard ? 'tourism_board' : 'locality_guide',
      status: 'locality',
      confidence: tourismBoard ? 0.96 : 0.88,
      reason: tourismBoard
        ? 'The candidate is a tourism or destination organization for the locality, not the hotel website.'
        : 'The candidate is a locality travel guide, not the hotel website.',
    }
  }

  if (DIRECTORY_HOST_PATTERN.test(`${hostname}.`) || (DIRECTORY_TEXT_PATTERN.test(organizationText) && candidateNameScore < 0.55 && !structuredHotelIdentity)) {
    return {
      ...finalBase,
      entityScope: 'other',
      entityType: 'booking_directory',
      status: 'non_hotel',
      confidence: 0.95,
      reason: 'The candidate is a booking/review directory rather than a hotel-controlled website.',
    }
  }
  if (TRAVEL_MEDIA_HOST_PATTERN.test(`${hostname}.`)) {
    return {
      ...finalBase,
      entityScope: 'other',
      entityType: 'travel_media',
      status: 'non_hotel',
      confidence: 0.95,
      reason: 'The candidate is a third-party travel publisher or agency rather than the hotel website.',
    }
  }

  const hasLodgingSchema = (input.candidateLodgingNames?.length ?? 0) > 0
  const locationMatched = cityMatched || stateMatched
  const confirmed =
    listingMatched && !stateConflict && (
      candidateNameScore >= 0.88 ||
      (candidateNameScore >= 0.65 && locationMatched) ||
      (candidateNameScore >= 0.6 && cityMatched && stateMatched) ||
      (candidateNameScore >= 0.62 && hasLodgingSchema) ||
      (candidateNameScore >= 0.5 && hostnameIdentityScore >= 0.6 && locationMatched)
    )
  if (confirmed) {
    const redirected = source.url !== candidate.url
    return {
      ...finalBase,
      entityScope: 'hotel',
      entityType: knownBrand ? 'hotel_brand' : 'hotel_property',
      status: redirected ? 'corrected_redirect' : 'confirmed',
      confidence: Math.min(0.99, 0.74 + candidateNameScore * 0.2 + (locationMatched ? 0.04 : 0)),
      reason: `${knownBrand ? 'Official brand' : 'Property'} page identity matches the listed hotel${locationMatched ? ' and location' : ''}.`,
      correctedUrl: redirected ? candidate.url : null,
    }
  }

  if (stateConflict && candidateNameScore >= 0.6) {
    return {
      ...finalBase,
      entityScope: 'hotel',
      entityType: knownBrand ? 'hotel_brand' : 'hotel_property',
      status: 'mismatch',
      confidence: 0.96,
      reason: `The candidate identifies the hotel in ${stateConflict}, conflicting with the HotelHotTubs listing location ${input.state}.`,
    }
  }

  const hint = input.sourceLinkType?.toLowerCase() ?? ''
  if (knownBrand || /brand_property_page|brand domain/.test(hint)) {
    return {
      ...finalBase,
      entityScope: 'hotel',
      entityType: 'hotel_brand',
      status: 'ambiguous',
      confidence: 0.62,
      reason: 'The domain is hotel-brand controlled, but this page does not clearly identify the listed property.',
    }
  }

  const otherLodgingName = hasLodgingSchema || prominent.some((value) => /\b(?:hotel|motel|resort|inn|lodge|suites?)\b/i.test(value))
  if (otherLodgingName && candidateNameScore < 0.5) {
    return {
      ...finalBase,
      entityScope: 'hotel',
      entityType: knownBrand ? 'hotel_brand' : 'hotel_property',
      status: 'mismatch',
      confidence: 0.9,
      reason: 'The destination appears to describe a different lodging property than the HotelHotTubs listing.',
    }
  }

  return {
    ...finalBase,
    entityScope: 'unknown',
    entityType: 'unknown',
    status: 'ambiguous',
    confidence: listingMatched ? 0.68 : 0.55,
    reason: 'The destination did not provide enough prominent hotel and location evidence to confirm the match.',
  }
}
