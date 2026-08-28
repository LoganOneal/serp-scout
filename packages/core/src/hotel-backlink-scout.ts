import { registrableDomain } from './domains/normalize.js'

export const HOTEL_BL_SITE_CONTROL_TYPES = [
  'independent_property',
  'property_microsite',
  'management_company_site',
  'brand_property_page',
  'brand_root',
  'non_hotel_or_bad_match',
  'unknown',
] as const

export type HotelBlSiteControlType = (typeof HOTEL_BL_SITE_CONTROL_TYPES)[number]

export const HOTEL_BL_RELATIONSHIP_TYPES = [
  'property',
  'brand',
  'locality',
  'management_company',
  'owner',
  'pr_agency',
  'other',
] as const

export type HotelBlRelationshipType = (typeof HOTEL_BL_RELATIONSHIP_TYPES)[number]

export const HOTEL_BL_BRAND_CONTROL_SEGMENTS = [
  'independent',
  'property_microsite',
  'soft_brand',
  'franchise',
  'hard_brand',
  'unknown',
] as const

export type HotelBlBrandControlSegment = (typeof HOTEL_BL_BRAND_CONTROL_SEGMENTS)[number]

export const HOTEL_BL_PAGE_TYPES = [
  'press',
  'media',
  'news',
  'awards',
  'accolades',
  'blog',
  'journal',
  'stories',
  'about',
  'contact',
  'other',
] as const

export type HotelBlPageType = (typeof HOTEL_BL_PAGE_TYPES)[number]

export const HOTEL_BL_CONTACT_TYPES = ['pr', 'media', 'marketing', 'general', 'management'] as const
export type HotelBlContactType = (typeof HOTEL_BL_CONTACT_TYPES)[number]

export const HOTEL_BL_CONTACT_CHANNELS = ['email', 'named', 'contact_page', 'none'] as const
export type HotelBlContactChannel = (typeof HOTEL_BL_CONTACT_CHANNELS)[number]

/** How an operator can actually reach this domain. Email beats a contact form. */
export function hotelBlContactChannel(input: {
  email?: string | null
  name?: string | null
  contactPageUrl?: string | null
}): HotelBlContactChannel {
  if (input.email?.trim()) return 'email'
  if (input.contactPageUrl?.trim()) return 'contact_page'
  if (input.name?.trim()) return 'named'
  return 'none'
}

export const HOTEL_BL_CONTENT_TYPES = [
  'existing_property_page',
  'city_roundup',
  'state_roundup',
  'regional_roundup',
  'category_roundup',
  'ranking_or_award',
  'original_research',
] as const

export type HotelBlContentType = (typeof HOTEL_BL_CONTENT_TYPES)[number]

export const HOTEL_BL_OPPORTUNITY_STATUSES = [
  'new',
  'reviewing',
  'approved',
  'content_needed',
  'ready_for_outreach',
  'contacted',
  'replied',
  'link_acquired',
  'rejected',
  'not_viable',
] as const

export type HotelBlOpportunityStatus = (typeof HOTEL_BL_OPPORTUNITY_STATUSES)[number]

export const HOTEL_BL_STAGES = [
  'import',
  'normalize',
  'domain_classify',
  'validate_urls',
  'crawl_homepage',
  'discover_editorial_pages',
  'analyze_link_behavior',
  'discover_contacts',
  'discover_alternate_entities',
  'crawl_alternate_entities',
  'calculate_feasibility',
  'semrush_enrichment',
  'calculate_link_value',
  'generate_content_opportunities',
  'calculate_priorities',
] as const

export type HotelBlStage = (typeof HOTEL_BL_STAGES)[number]

export interface HotelBlBrandRule {
  brandName: string
  rootDomains: readonly string[]
  centralized: boolean
}

/** One auditable configuration table; brand behavior must not leak into scattered branches. */
export const HOTEL_BL_BRAND_RULES: readonly HotelBlBrandRule[] = [
  { brandName: 'Hilton', rootDomains: ['hilton.com'], centralized: true },
  { brandName: 'Marriott', rootDomains: ['marriott.com'], centralized: true },
  { brandName: 'Choice Hotels', rootDomains: ['choicehotels.com'], centralized: true },
  { brandName: 'IHG', rootDomains: ['ihg.com'], centralized: true },
  { brandName: 'Hyatt', rootDomains: ['hyatt.com'], centralized: true },
  { brandName: 'Wyndham', rootDomains: ['wyndhamhotels.com', 'wyndhamdestinations.com'], centralized: true },
  { brandName: 'Best Western', rootDomains: ['bestwestern.com'], centralized: true },
  { brandName: 'Accor', rootDomains: ['all.accor.com', 'accor.com'], centralized: true },
  { brandName: 'Radisson', rootDomains: ['radissonhotels.com'], centralized: true },
  { brandName: 'Four Seasons', rootDomains: ['fourseasons.com'], centralized: true },
  { brandName: 'Margaritaville', rootDomains: ['margaritavilleresorts.com'], centralized: true },
] as const

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'msclkid',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
])

export interface HotelBlNormalizedUrl {
  url: string
  hostname: string
  rootDomain: string
}

export function normalizeHotelBlUrl(value: string | null | undefined): HotelBlNormalizedUrl | null {
  if (!value?.trim()) return null
  const raw = value.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return null
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const rootDomain = registrableDomain(parsed.hostname)?.domain
  if (!rootDomain) return null

  parsed.protocol = 'https:'
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  parsed.hash = ''
  if (parsed.port === '80' || parsed.port === '443') parsed.port = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key)
  }
  parsed.searchParams.sort()
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  return { url: parsed.toString(), hostname: parsed.hostname, rootDomain }
}

export function hotelBlSourceKey(input: {
  hotelName: string
  city?: string | null
  state?: string | null
  sourceUrl?: string | null
}): string {
  const part = (value: string | null | undefined) =>
    (value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const geography = [part(input.city), part(input.state)].filter(Boolean)
  // Name + geography is the hotel identity. A URL is only a fallback when the
  // source has no geography; otherwise changed/duplicate links would create a
  // second hotel instead of being recognized as another source row.
  return [part(input.hotelName), ...(geography.length > 0 ? geography : [part(input.sourceUrl)])].join('|')
}

function words(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 2 && !['hotel', 'hotels', 'resort', 'inn', 'the', 'and'].includes(word))
}

export interface HotelBlSiteControlClassification {
  siteControlType: HotelBlSiteControlType
  confidence: number
  reason: string
  brandName: string | null
  centralizedBrand: boolean
}

export function classifyHotelBlSiteControl(input: {
  hotelName: string
  hostname: string | null
  rootDomain: string | null
  sourceUrl: string | null
  sourceLinkType?: string | null
  hotelCount: number
  brandRules?: readonly HotelBlBrandRule[]
}): HotelBlSiteControlClassification {
  if (!input.hostname || !input.rootDomain || !input.sourceUrl) {
    return {
      siteControlType: 'non_hotel_or_bad_match',
      confidence: 0.95,
      reason: 'No valid public hotel website URL was available.',
      brandName: null,
      centralizedBrand: false,
    }
  }

  const rules = input.brandRules ?? HOTEL_BL_BRAND_RULES
  const brand = rules.find((rule) => rule.rootDomains.includes(input.rootDomain!))
  if (brand) {
    const path = new URL(input.sourceUrl).pathname.replace(/\/$/, '')
    const propertyPage = path.length > 1
    return {
      siteControlType: propertyPage ? 'brand_property_page' : 'brand_root',
      confidence: 0.98,
      reason: propertyPage
        ? `${brand.brandName} centrally controls this property-specific path.`
        : `${brand.brandName} centrally controls this root-domain URL.`,
      brandName: brand.brandName,
      centralizedBrand: brand.centralized,
    }
  }

  if (input.hotelCount >= 25) {
    return {
      siteControlType: new URL(input.sourceUrl).pathname === '/' ? 'brand_root' : 'brand_property_page',
      confidence: 0.88,
      reason: `${input.hotelCount} inventory hotels share this domain, a strong centralized-control signal.`,
      brandName: null,
      centralizedBrand: true,
    }
  }

  const domainStem = input.hostname.split('.')[0]?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? ''
  const domainWords = new Set(words(input.hostname.replace(/\.[^.]+$/, '')))
  const hotelWords = words(input.hotelName)
  const overlap = hotelWords.filter((word) => domainWords.has(word) || domainStem.includes(word)).length
  const nameMatch = hotelWords.length > 0 && overlap / hotelWords.length >= 0.5
  if (input.hotelCount === 1 && nameMatch) {
    return {
      siteControlType: 'independent_property',
      confidence: 0.84,
      reason: 'Only one inventory hotel uses this domain and the domain closely matches the property name.',
      brandName: null,
      centralizedBrand: false,
    }
  }

  if (input.hotelCount <= 3 && nameMatch) {
    return {
      siteControlType: 'property_microsite',
      confidence: 0.72,
      reason: `${input.hotelCount} closely related hotels share a domain that matches the property name.`,
      brandName: null,
      centralizedBrand: false,
    }
  }

  if (/hospitality|management|properties|lodging|group/i.test(input.hostname)) {
    return {
      siteControlType: 'management_company_site',
      confidence: 0.75,
      reason: 'The domain name signals a hospitality management or property group.',
      brandName: null,
      centralizedBrand: false,
    }
  }

  const sourceHint = input.sourceLinkType?.toLowerCase() ?? ''
  if (input.hotelCount === 1 && /independent|direct|property/.test(sourceHint)) {
    return {
      siteControlType: 'independent_property',
      confidence: 0.65,
      reason: 'A singleton domain and the source link classification both suggest property control, but the name match is weak.',
      brandName: null,
      centralizedBrand: false,
    }
  }
  if (/management|owner|operator/.test(sourceHint)) {
    return {
      siteControlType: 'management_company_site',
      confidence: 0.65,
      reason: 'The source classification suggests a management or ownership site; crawl evidence is still required.',
      brandName: null,
      centralizedBrand: false,
    }
  }
  if (/brand|chain/.test(sourceHint) && input.hotelCount > 1) {
    return {
      siteControlType: 'brand_property_page',
      confidence: 0.65,
      reason: 'The source classification and shared-domain count suggest centralized brand control.',
      brandName: null,
      centralizedBrand: true,
    }
  }

  if (input.hotelCount === 1) {
    return {
      siteControlType: 'unknown',
      confidence: 0.55,
      reason: 'A single-hotel domain is promising, but the domain/property match is not strong enough to prove control.',
      brandName: null,
      centralizedBrand: false,
    }
  }

  return {
    siteControlType: 'unknown',
    confidence: 0.45,
    reason: `${input.hotelCount} hotels share the domain without a recognized brand or ownership signal.`,
    brandName: null,
    centralizedBrand: false,
  }
}

export function hotelBlBrandControlSegment(input: {
  sourceLinkType?: string | null
  siteControlType: HotelBlSiteControlType
  centralizedBrand: boolean
}): HotelBlBrandControlSegment {
  const hint = input.sourceLinkType?.toLowerCase() ?? ''
  if (/soft[ -]?brand|autograph|curio|tapestry|tribute|unbound|luxury collection/.test(hint)) return 'soft_brand'
  if (/franchis/.test(hint)) return 'franchise'
  if (input.siteControlType === 'independent_property') return 'independent'
  if (input.siteControlType === 'property_microsite') return 'property_microsite'
  if (input.centralizedBrand || input.siteControlType === 'brand_property_page' || input.siteControlType === 'brand_root') return 'hard_brand'
  return 'unknown'
}

export function hotelBlSourceRelationshipType(input: {
  sourceLinkType?: string | null
  siteControlType: HotelBlSiteControlType
  centralizedBrand: boolean
}): HotelBlRelationshipType {
  const hint = input.sourceLinkType?.toLowerCase() ?? ''
  if (/\bpr\b|public relations|communications agency|pr agency/.test(hint)) return 'pr_agency'
  if (/owner|ownership/.test(hint)) return 'owner'
  if (/management|manager|managed|operator|operated/.test(hint)) return 'management_company'
  if (/brand|chain/.test(hint) || input.centralizedBrand) return 'brand'
  if (input.siteControlType === 'management_company_site') return 'management_company'
  return 'property'
}

const PAGE_TYPE_RULES: ReadonlyArray<[HotelBlPageType, RegExp]> = [
  ['press', /\b(in[- ]the[- ]press|press)\b/i],
  ['media', /\b(media room|media)\b/i],
  ['news', /\b(newsroom|news)\b/i],
  ['awards', /\b(awards?|recognition|featured[- ]in|as[- ]seen[- ]in)\b/i],
  ['accolades', /\baccolades?\b/i],
  ['blog', /\bblog\b/i],
  ['journal', /\bjournal\b/i],
  ['stories', /\bstories\b/i],
  ['about', /\babout\b/i],
  ['contact', /\b(contact|connect)\b/i],
]

export function classifyHotelBlPageType(url: string, title = '', anchor = ''): HotelBlPageType {
  const haystack = `${new URL(url).pathname.replace(/[-_/]+/g, ' ')} ${title} ${anchor}`
  return PAGE_TYPE_RULES.find(([, pattern]) => pattern.test(haystack))?.[0] ?? 'other'
}

export function isHotelBlEditorialPageType(type: HotelBlPageType): boolean {
  return ['press', 'media', 'news', 'awards', 'accolades', 'blog', 'journal', 'stories'].includes(type)
}

const NON_EDITORIAL_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
  'google.com',
  'googleapis.com',
  'googleusercontent.com',
  'tripadvisor.com',
  'opentable.com',
  'booking.com',
  'expedia.com',
  'maps.apple.com',
])

export function isLikelyHotelBlEditorialLink(input: {
  destinationUrl: string
  anchorText?: string | null
  sourcePageType: HotelBlPageType
}): boolean {
  const normalized = normalizeHotelBlUrl(input.destinationUrl)
  if (!normalized || NON_EDITORIAL_DOMAINS.has(normalized.rootDomain)) return false
  if (!isHotelBlEditorialPageType(input.sourcePageType)) return false
  const text = (input.anchorText ?? '').toLowerCase()
  if (/book now|reservations?|directions?|map|facebook|instagram|linkedin|youtube|privacy|terms/.test(text)) {
    return false
  }
  return true
}

export function isFollowedHotelBlLink(rel: string | null | undefined): boolean {
  const values = new Set((rel ?? '').toLowerCase().split(/\s+/).filter(Boolean))
  return !values.has('nofollow') && !values.has('sponsored') && !values.has('ugc')
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.round(Math.min(maximum, Math.max(minimum, value)) * 10) / 10
}

export interface HotelBlFeasibilityInput {
  siteControlType: HotelBlSiteControlType
  entityScope?: 'hotel' | 'locality' | 'other' | 'unknown'
  externalPressLinkCount: number
  dofollowExternalPressLinkCount: number
  hasPressPage: boolean
  hasAwardsPage: boolean
  hasBlogOrNews: boolean
  hasNamedPrContact: boolean
  hasPrEmail: boolean
  freshnessDays: number | null
}

export interface HotelBlFeasibilityScore {
  score: number
  components: {
    editorialLinkBehavior: number
    siteControlAutonomy: number
    editorialSurface: number
    contactability: number
    freshness: number
  }
}

export function scoreHotelBlFeasibility(input: HotelBlFeasibilityInput): HotelBlFeasibilityScore {
  const editorialLinkBehavior = clamp(
    Math.min(18, input.externalPressLinkCount * 3) +
      Math.min(10, input.dofollowExternalPressLinkCount * 2) +
      (input.dofollowExternalPressLinkCount > 0 ? 2 : 0),
    0,
    30,
  )
  const autonomy: Record<HotelBlSiteControlType, number> = {
    independent_property: 25,
    property_microsite: 21,
    management_company_site: 20,
    brand_property_page: 7,
    brand_root: 2,
    non_hotel_or_bad_match: 0,
    unknown: 10,
  }
  const editorialSurface = clamp(
    (input.hasPressPage ? 10 : 0) +
      (input.hasAwardsPage ? 6 : 0) +
      (input.hasBlogOrNews ? 4 : 0),
    0,
    20,
  )
  const contactability = clamp(
    (input.hasNamedPrContact ? 8 : 0) + (input.hasPrEmail ? 7 : 0),
    0,
    15,
  )
  const freshness =
    input.freshnessDays === null
      ? 0
      : input.freshnessDays <= 180
        ? 10
        : input.freshnessDays <= 365
          ? 8
          : input.freshnessDays <= 730
            ? 5
            : input.freshnessDays <= 1_825
              ? 2
              : 0
  const entityAutonomy =
    input.entityScope === 'locality'
      ? 23
      : input.entityScope === 'other' && input.siteControlType === 'non_hotel_or_bad_match'
        ? 12
        : autonomy[input.siteControlType]
  const components = {
    editorialLinkBehavior,
    siteControlAutonomy: entityAutonomy,
    editorialSurface,
    contactability,
    freshness,
  }
  return { score: clamp(Object.values(components).reduce((sum, value) => sum + value, 0)), components }
}

export interface HotelBlLinkValueScore {
  score: number
  components: {
    authority: number
    organicTraffic: number
    topicalRelevance: number
    expectedPlacement: number
    newReferringDomain: number
  }
}

export function scoreHotelBlLinkValue(input: {
  authorityScore: number | null
  organicTraffic: number | null
  topicalRelevance: number
  recommendedContentType: HotelBlContentType
  alreadyLinksToHht: boolean | null
}): HotelBlLinkValueScore {
  const authority = clamp(((input.authorityScore ?? 0) / 100) * 35, 0, 35)
  const organicTraffic = clamp(
    (Math.log10(Math.max(0, input.organicTraffic ?? 0) + 1) / 6) * 25,
    0,
    25,
  )
  const topicalRelevance = clamp((input.topicalRelevance / 100) * 15, 0, 15)
  const placement: Record<HotelBlContentType, number> = {
    existing_property_page: 11,
    city_roundup: 14,
    state_roundup: 13,
    regional_roundup: 12,
    category_roundup: 13,
    ranking_or_award: 15,
    original_research: 15,
  }
  const newReferringDomain = input.alreadyLinksToHht === false ? 10 : input.alreadyLinksToHht === null ? 5 : 0
  const components = {
    authority,
    organicTraffic,
    topicalRelevance,
    expectedPlacement: placement[input.recommendedContentType],
    newReferringDomain,
  }
  return { score: clamp(Object.values(components).reduce((sum, value) => sum + value, 0)), components }
}

export interface HotelBlContentRecommendation {
  contentType: HotelBlContentType
  score: number
  targetPage: string | null
  pitchAngle: string
  alternatives: Record<HotelBlContentType, number>
}

export function recommendHotelBlContent(input: {
  hotelName: string
  city: string | null
  state: string | null
  existingHhtUrl: string | null
  hasPressPage: boolean
  hasAwardsPage: boolean
  hasBlogOrNews: boolean
}): HotelBlContentRecommendation {
  const alternatives: Record<HotelBlContentType, number> = {
    existing_property_page: input.existingHhtUrl ? 74 : 25,
    city_roundup: input.city ? 78 + (input.hasPressPage ? 5 : 0) : 25,
    state_roundup: input.state ? 68 + (input.hasPressPage ? 5 : 0) : 25,
    regional_roundup: input.state ? 58 : 30,
    category_roundup: 64 + (input.hasBlogOrNews ? 4 : 0),
    ranking_or_award: input.hasAwardsPage ? 94 : 48,
    original_research: input.hasPressPage || input.hasBlogOrNews ? 72 : 55,
  }
  const [contentType, score] = (Object.entries(alternatives) as Array<[HotelBlContentType, number]>).reduce(
    (best, candidate) => (candidate[1] > best[1] ? candidate : best),
  )
  const place = input.city || input.state || 'its destination'
  const pitchByType: Record<HotelBlContentType, string> = {
    existing_property_page: `Suggest the existing HotelHotTubs profile as a useful planning resource for ${input.hotelName}.`,
    city_roundup: `Pitch inclusion in an evidence-based guide to hot-tub hotels in ${place}.`,
    state_roundup: `Pitch inclusion in a statewide HotelHotTubs guide covering ${place}.`,
    regional_roundup: `Pitch a regional comparison that gives travelers clear amenity criteria.`,
    category_roundup: `Pitch a relevant hotel-category roundup with transparent inclusion criteria.`,
    ranking_or_award: `Pitch an editorial ranking only after publishing transparent, verifiable criteria.`,
    original_research: `Pitch original HotelHotTubs research that the property can cite as third-party evidence.`,
  }
  return {
    contentType,
    score: clamp(score),
    targetPage: input.existingHhtUrl,
    pitchAngle: pitchByType[contentType],
    alternatives,
  }
}

export function scoreHotelBlEffort(input: {
  hasSuitableHhtPage: boolean
  hasPressPage: boolean
  hasPrEmail: boolean
  relationshipType: HotelBlRelationshipType
  contentType: HotelBlContentType
  needsReview: boolean
}): number {
  let effort = 55
  if (input.hasSuitableHhtPage) effort -= 20
  if (input.hasPressPage) effort -= 10
  if (input.hasPrEmail) effort -= 15
  if (['management_company', 'owner', 'pr_agency'].includes(input.relationshipType)) effort += 10
  if (['ranking_or_award', 'original_research'].includes(input.contentType)) effort += 20
  if (input.needsReview) effort += 10
  return clamp(effort, 1, 100)
}

export function scoreHotelBlPriority(input: {
  feasibility: number
  linkValue: number
  contentFit: number
  effort: number
}): number {
  const geometricMean = Math.cbrt(
    (clamp(input.feasibility) / 100) *
      (clamp(input.linkValue) / 100) *
      (clamp(input.contentFit) / 100),
  ) * 100
  const effortMultiplier = 1 - clamp(input.effort, 1, 100) / 200
  return clamp(geometricMean * effortMultiplier)
}

export function explainHotelBlOpportunity(input: {
  siteControlType: HotelBlSiteControlType
  externalPressLinkCount: number
  dofollowExternalPressLinkCount: number
  hasPressPage: boolean
  latestPressDate: string | null
  hasPrContact: boolean
  recommendedContentType: HotelBlContentType
  city: string | null
}): string {
  const facts: string[] = []
  if (input.siteControlType === 'independent_property') facts.push('the hotel appears to control its own domain')
  else if (input.siteControlType === 'management_company_site') facts.push('the target is an editable management-company site')
  else facts.push(`site control is classified as ${input.siteControlType.replaceAll('_', ' ')}`)
  if (input.hasPressPage) facts.push('a press or media surface was found')
  if (input.externalPressLinkCount > 0) {
    facts.push(
      `${input.externalPressLinkCount} external editorial link${input.externalPressLinkCount === 1 ? '' : 's'} were observed, ${input.dofollowExternalPressLinkCount} followed`,
    )
  }
  if (input.latestPressDate) facts.push(`the latest supported press date is ${input.latestPressDate}`)
  if (input.hasPrContact) facts.push('a public PR or marketing contact is available')
  const treatment = input.recommendedContentType.replaceAll('_', ' ')
  return `${facts.join('; ')}. Recommend a ${treatment}${input.city ? ` treatment for ${input.city}` : ''}.`
}

export interface HotelBlClusterInput {
  hotelId: number
  hotelName: string
  city: string | null
  state: string | null
  feasibilityScore: number
  priorityScore: number
  rootDomain: string
}

export interface HotelBlContentCluster {
  contentType: 'city_roundup' | 'state_roundup'
  topic: string
  geography: string
  hotelCount: number
  highFeasibilityHotelCount: number
  aggregateOpportunityValue: number
  newReferringDomains: number
  estimatedEffort: number
  contentRoiScore: number
  suggestedSlug: string
}

function slug(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function buildHotelBlContentClusters(rows: HotelBlClusterInput[]): HotelBlContentCluster[] {
  const groups = new Map<string, { type: 'city_roundup' | 'state_roundup'; geography: string; rows: HotelBlClusterInput[] }>()
  for (const row of rows) {
    if (row.city && row.state) {
      const key = `city:${slug(row.city)}:${slug(row.state)}`
      const group = groups.get(key) ?? { type: 'city_roundup' as const, geography: `${row.city}, ${row.state}`, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }
    if (row.state) {
      const key = `state:${slug(row.state)}`
      const group = groups.get(key) ?? { type: 'state_roundup' as const, geography: row.state, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }
  }
  return [...groups.values()]
    .filter((group) => new Set(group.rows.map((row) => row.hotelId)).size >= 2)
    .map((group) => {
      const hotelIds = new Set(group.rows.map((row) => row.hotelId))
      const domains = new Set(group.rows.map((row) => row.rootDomain))
      const aggregateOpportunityValue = clamp(
        group.rows.reduce((sum, row) => sum + row.priorityScore, 0),
        0,
        100_000,
      )
      const highFeasibilityHotelCount = new Set(
        group.rows.filter((row) => row.feasibilityScore >= 70).map((row) => row.hotelId),
      ).size
      const estimatedEffort = clamp(group.type === 'city_roundup' ? 35 + hotelIds.size * 3 : 50 + hotelIds.size * 2, 1, 100)
      const contentRoiScore = clamp(
        (aggregateOpportunityValue / Math.max(1, hotelIds.size)) *
          (0.5 + highFeasibilityHotelCount / Math.max(1, hotelIds.size)) *
          Math.log2(domains.size + 1) *
          (1 - estimatedEffort / 200),
      )
      const topic = `Best Hotels With Private Hot Tubs in ${group.geography}`
      return {
        contentType: group.type,
        topic,
        geography: group.geography,
        hotelCount: hotelIds.size,
        highFeasibilityHotelCount,
        aggregateOpportunityValue,
        newReferringDomains: domains.size,
        estimatedEffort,
        contentRoiScore,
        suggestedSlug: `best-hotels-with-private-hot-tubs-${slug(group.geography)}`,
      }
    })
    .sort((a, b) => b.contentRoiScore - a.contentRoiScore)
}
