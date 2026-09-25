import type {
  HhtPxCluster,
  HhtPxCompetitorStrength,
  HhtPxPageType,
} from './types.js'
import { DESIRABLE_TYPE_SET } from './types.js'
import { hhtPxRootDomain } from './urls.js'

export const HHT_PX_OTA_DOMAINS: ReadonlySet<string> = new Set([
  'booking.com',
  'expedia.com',
  'hotels.com',
  'tripadvisor.com',
  'tripadvisor.co.uk',
  'kayak.com',
  'priceline.com',
  'agoda.com',
  'travelocity.com',
  'orbitz.com',
  'trivago.com',
  'hotwire.com',
  'cheapflights.com',
  'momondo.com',
  'hipmunk.com',
  'airbnb.com',
  'vrbo.com',
  'trip.com',
  'cozycozy.com',
  'dayuse.com',
  'daybreakhotels.com',
  'resortpass.com',
  'suiteness.com',
  'condo-world.com',
])

export const HHT_PX_HOTEL_CHAIN_DOMAINS: ReadonlySet<string> = new Set([
  'marriott.com',
  'hilton.com',
  'hyatt.com',
  'ihg.com',
  'wyndhamhotels.com',
  'choicehotels.com',
  'bestwestern.com',
  'accor.com',
  'radissonhotels.com',
  'omnihotels.com',
  'fairmont.com',
  'ritzcarlton.com',
  'fourseasons.com',
  'starwoodhotels.com',
  'kimptonhotels.com',
  'hotelindigo.com',
  'holidayinn.com',
  'hamptoninn.com',
  'courtyard.com',
  'mgmresorts.com',
  'hardrock.com',
  'westgateresorts.com',
  'kalahariresorts.com',
  'goldennugget.com',
  'treasureisland.com',
  'redrockresort.com',
  'nobuhotels.com',
  'sybaris.com',
  'ihg.com',
])

export const HHT_PX_COMPETITOR_DOMAINS: ReadonlySet<string> = new Set([
  'hotelhottubs.com',
  'jacuzzisuites.com',
  'hottubhotels.com',
  'hotelswithhottubs.com',
  'hotelwithhottub.com',
  'inroomhottub.com',
  'inroomhottubs.com',
  'romantichotels.com',
  'roomswithtubs.com',
  'tubstays.com',
  'tubhotels.com',
  'tubretreats.com',
  'travelmyth.com',
  'travelmyth.ie',
  'theworldofhotels.com',
  'topspahotel.com',
  'coupleshotels.org',
  'hotelswithhottub.info',
])

/** Never an outreach target. Social, search, UGC, and booking marketplaces. */
export const HHT_PX_EXCLUDED_DOMAINS: ReadonlySet<string> = new Set([
  ...HHT_PX_OTA_DOMAINS,
  'google.com',
  'google.ca',
  'yelp.com',
  'reddit.com',
  'pinterest.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'x.com',
  'twitter.com',
])

const SOCIAL = new Set([
  'facebook.com',
  'instagram.com',
  'pinterest.com',
  'tiktok.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
])

const SEARCH = new Set(['google.com', 'google.ca', 'bing.com', 'yahoo.com', 'duckduckgo.com'])

const COUPON = new Set(['groupon.com', 'retailmenot.com', 'slickdeals.net', 'couponcabin.com'])

const DIRECTORY = new Set([
  'yelp.com',
  'yellowpages.com',
  'bbb.org',
  'foursquare.com',
  'mapquest.com',
])

const MAGAZINE = new Set([
  'travelandleisure.com',
  'cntraveler.com',
  'cntraveller.com',
  'afarmedia.com',
  'lonelyplanet.com',
  'nationalgeographic.com',
  'forbes.com',
  'timeout.com',
  'fodors.com',
  'frommers.com',
  'afar.com',
  'smithsonianmag.com',
  'midwestliving.com',
  'southernliving.com',
  'ohiomagazine.com',
  'countryliving.com',
])

const NATIONAL_MEDIA = new Set([
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'usatoday.com',
  'latimes.com',
  'chicagotribune.com',
  'npr.org',
  'bbc.com',
  'theguardian.com',
])

const WEDDING = new Set(['theknot.com', 'weddingwire.com', 'brides.com', 'thespruce.com'])

const WELLNESS = new Set(['mindbodygreen.com', 'wellandgood.com', 'healthline.com', 'spaweek.com'])

const COMPETITOR_HOST =
  /(?:tubstays|tubhotels|tubretreats|roomswithtubs|inroomhottubs?|hotelswithhottubs?|hotelwithhottub|jacuzzisuites|worldofhotels|travelmyth|cozycozy|dayuse|daybreakhotels|topspahotel|coupleshotels|hotelswithhottub)/i

const PROGRAMMATIC_PATH =
  /\/(?:us|uk)\/[a-z0-9-]+-hotel-jacuzzi|\/l\/hotels-with-jacuzzi-in-room-|\/hotels\/jacuzzi|\/jacuzzi\/(?:city|region|hotel)\/|\/jacuzzi-hotels\/?$/i

const EDITORIAL_PATH =
  /\/(?:blog|blogs|story|stories|article|articles|news|magazine|features?|guides?|gallery|roundup|post|trip-ideas|travel-ideas|trip-inspiration|travel-inspiration)(?:\/|$)|-articles(?:\/|$)/i

const PROPERTY_HOST_WORD = /^(?:hotel|hotels|inn|inns|resort|resorts|lodge|lodges|motel|motels|suites)$/i

export interface SerpClassifyInput {
  url: string
  title?: string | null
  snippet?: string | null
  domain?: string | null
}

export interface SerpClassification {
  pageType: HhtPxPageType
  isProspectable: boolean
  competitorStrength: HhtPxCompetitorStrength
  excludedByRule: boolean
  reason: string
}

function hostPath(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(/^https?:/i.test(url) ? url : `https://${url}`)
    return { host: parsed.hostname.toLowerCase().replace(/^www\./, ''), path: parsed.pathname.toLowerCase() }
  } catch {
    return { host: '', path: '' }
  }
}

export function classifyHhtPxSerpResult(input: SerpClassifyInput): SerpClassification {
  const root = (input.domain ?? hhtPxRootDomain(input.url) ?? '').toLowerCase()
  const { host, path } = hostPath(input.url)
  const text = `${input.title ?? ''} ${input.snippet ?? ''} ${path}`.toLowerCase()

  if (!root) {
    return {
      pageType: 'irrelevant',
      isProspectable: false,
      competitorStrength: 'none',
      excludedByRule: false,
      reason: 'URL could not be parsed.',
    }
  }

  if (root === 'reddit.com' || host.endsWith('.reddit.com')) {
    return done('reddit', false, 'none', true, 'Reddit is UGC, not an outreach target.')
  }
  if (host.includes('google.') && (path.includes('/maps') || path.includes('/travel'))) {
    return done('maps', false, 'none', true, 'Maps / Google Travel pack.')
  }
  if (SEARCH.has(root)) return done('search_engine', false, 'none', true, 'Search engine result.')
  if (SOCIAL.has(root)) return done('social_media', false, 'none', true, 'Social network.')
  if (HHT_PX_OTA_DOMAINS.has(root)) return done('ota', false, 'none', true, 'OTA / booking marketplace.')
  if (HHT_PX_HOTEL_CHAIN_DOMAINS.has(root)) return done('hotel_chain', false, 'none', true, 'Hotel-brand domain.')
  if (root === 'hotelhottubs.com') {
    return done('direct_hht_competitor', false, 'none', true, 'Own property.')
  }
  if (HHT_PX_COMPETITOR_DOMAINS.has(root) || COMPETITOR_HOST.test(root) || COMPETITOR_HOST.test(host)) {
    return done('direct_hht_competitor', false, 'direct', true, 'Hot-tub hotel directory / aggregator.')
  }
  if (isGeoHotelDirectory(root)) {
    return done('direct_hht_competitor', false, 'direct', true, 'Geo hotel-listing domain.')
  }
  if (PROGRAMMATIC_PATH.test(path) || PROGRAMMATIC_PATH.test(root.replaceAll('.', '-'))) {
    return done('direct_hht_competitor', false, 'direct', true, 'Programmatic jacuzzi/hot-tub hotel directory.')
  }
  if (COUPON.has(root)) return done('coupon_site', false, 'none', true, 'Coupon / deal site.')
  if (DIRECTORY.has(root)) return done('directory', false, 'none', true, 'Local directory.')
  if (isHotelSite(root, host, path, text)) {
    return done('hotel', false, 'none', true, 'Hotel or property website.')
  }

  const competitorStrength = competitorFromSignals(root, path, text)

  if (WEDDING.has(root) || /wedding|honeymoon|bride/.test(host)) {
    return done('wedding_honeymoon_site', true, competitorStrength, false, 'Wedding / honeymoon publisher.')
  }
  if (WELLNESS.has(root) || (/spa|wellness/.test(host) && EDITORIAL_PATH.test(path))) {
    return done('wellness_spa_site', true, competitorStrength, false, 'Wellness / spa publisher.')
  }
  if (MAGAZINE.has(root)) {
    return done('national_magazine', true, competitorStrength, false, 'National travel magazine.')
  }
  if (NATIONAL_MEDIA.has(root)) {
    return done('newspaper_travel', true, competitorStrength, false, 'Newspaper travel desk.')
  }
  if (isTourism(host, path, text)) {
    return done('tourism_board', true, 'none', false, 'Destination marketing / tourism organization.')
  }
  if (isLocalMedia(host, path)) {
    return done('local_media', true, competitorStrength, false, 'Local or regional publication.')
  }
  if (isTravelBlog(host, path)) {
    return done('travel_blog', true, competitorStrength, false, 'Travel blog / editorial article.')
  }
  if (isDestinationGuide(host, path, text) && hasEditorialSignal(host, path)) {
    return done('destination_guide', true, competitorStrength, false, 'Destination guide article.')
  }
  if (hasEditorialSignal(host, path) && /lifestyle|couples|relationship/.test(host + path)) {
    return done('lifestyle_blog', true, competitorStrength, false, 'Lifestyle publisher.')
  }
  if (hasEditorialSignal(host, path) && /couples|relationship/.test(text)) {
    return done('couples_relationship_site', true, competitorStrength, false, 'Couples / relationship article.')
  }
  if (hasEditorialSignal(host, path)) {
    return done('editorial_travel_site', true, competitorStrength, false, 'Editorial article path.')
  }

  return done('irrelevant', false, competitorStrength, false, 'No blog/article publisher signal.')
}

function done(
  pageType: HhtPxPageType,
  isProspectable: boolean,
  competitorStrength: HhtPxCompetitorStrength,
  excludedByRule: boolean,
  reason: string,
): SerpClassification {
  const prospectable = isProspectable && DESIRABLE_TYPE_SET.has(pageType) && competitorStrength !== 'direct'
  return { pageType, isProspectable: prospectable, competitorStrength, excludedByRule, reason }
}

function competitorFromSignals(root: string, path: string, text: string): HhtPxCompetitorStrength {
  if (HHT_PX_COMPETITOR_DOMAINS.has(root) || COMPETITOR_HOST.test(root)) return 'direct'
  if (PROGRAMMATIC_PATH.test(path)) return 'direct'
  if (/\b(?:book now|check availability|from \$\d+)\b/.test(text) && /\bhotels? with (?:hot tubs?|jacuzzis?)\b/.test(text)) {
    return 'moderate'
  }
  if (/\baffiliate\b|\bsponsored listing\b/.test(text)) return 'weak'
  return 'none'
}

function isGeoHotelDirectory(root: string): boolean {
  if (HHT_PX_OTA_DOMAINS.has(root) || MAGAZINE.has(root)) return false
  return /(?:^|\.)(?:top)?hotels?(?:-?in|-?with|-)/.test(root) || /[a-z0-9-]+hotels?\.(?:com|net|info)$/.test(root)
}

function isPropertyHost(host: string): boolean {
  const labels = host.replaceAll('.', '-').split('-').filter(Boolean)
  return labels.some((part) => PROPERTY_HOST_WORD.test(part) || part.startsWith('hotel'))
}

function isHotelSite(root: string, host: string, path: string, text: string): boolean {
  if (HHT_PX_HOTEL_CHAIN_DOMAINS.has(root)) return true
  if (hasEditorialSignal(host, path)) return false
  const bookingPath = /\/(rooms?|suites?|accommodations?|stay|reservations?|guest-rooms?|lodging|offers?|packages?|specials?)(?:\/|$)/.test(
    path,
  )
  if (bookingPath) return true
  if (isOwnPropertyPage(host, path)) return true
  if (isPropertyHost(host) && /\/[a-z0-9-]+\/rooms?(?:-|\/|$)/.test(path)) return true
  if (
    /\b(book (?:a )?room|check (?:in|availability)|guest rooms?)\b/.test(text) &&
    isPropertyHost(host) &&
    !/\b(best|top \d+|guide|list)\b/.test(text)
  ) {
    return true
  }
  return false
}

function isOwnPropertyPage(host: string, path: string): boolean {
  if (hasEditorialSignal(host, path)) return false
  const hostKey = host.replace(/^www\./, '').replace(/\.(com|org|net|io)$/, '').replace(/-/g, '')
  const slugKey = (path.split('/').filter(Boolean).at(-1) ?? '').replace(/-/g, '')
  return hostKey.length >= 8 && slugKey.includes(hostKey)
}

function looksLikeArticleSlug(path: string): boolean {
  const slug = path.split('/').filter(Boolean).at(-1)?.replace(/\.html?$/, '') ?? ''
  const words = slug.split('-').filter((word) => word.length > 1)
  if (words.length >= 6) return true
  return words.length >= 4 && /(?:romantic|getaways?|couples|honeymoon|anniversary)/.test(slug)
}

function hasEditorialSignal(host: string, path: string): boolean {
  if (EDITORIAL_PATH.test(path)) return true
  if (/blog/.test(host)) return true
  return false
}

function isTourism(host: string, path: string, text: string): boolean {
  if (host.endsWith('.gov') || host.endsWith('.gov.uk')) return true
  if (/^visit[a-z]/.test(host) || (host.startsWith('travel') && host.endsWith('.org'))) return true
  if (/convention|visitors|tourism|chamber|cvb/.test(host + path + text)) return true
  if (/(?:^|\.)(?:visit|explore)[a-z0-9-]+\.(?:com|org)$/.test(host)) return true
  if (
    /^[a-z]+\.org$/.test(host) &&
    (EDITORIAL_PATH.test(path) || /travel-inspiration|trip-ideas|experiences|couples-escapes/.test(path))
  ) {
    return true
  }
  return false
}

function isLocalMedia(host: string, path: string): boolean {
  return (
    (/\.(com|org)$/.test(host) &&
      /(times|tribune|herald|gazette|journal|dispatch|post|news|observer|sentinel|record|press|sun|star|pilot|courier)/.test(
        host,
      )) ||
    (/(times|tribune|herald|gazette|journal|dispatch|post|news)/.test(host) && EDITORIAL_PATH.test(path))
  )
}

function isDestinationGuide(host: string, path: string, text: string): boolean {
  if (/lonelyplanet|fodors|frommers/.test(host)) return true
  return /\b(travel guide|destination guide|visitor guide|where to stay)\b/.test(text + path)
}

function isTravelBlog(host: string, path: string): boolean {
  if (/blog/.test(host) || /\/blog\//.test(path)) return true
  if (/\/story\//.test(path)) return true
  if (looksLikeArticleSlug(path) && !isPropertyHost(host) && !isGeoHotelDirectory(host)) return true
  return false
}

export function isProspectablePageType(type: HhtPxPageType, competitor: HhtPxCompetitorStrength): boolean {
  return DESIRABLE_TYPE_SET.has(type) && competitor !== 'direct'
}

export function editorialDensity(types: readonly HhtPxPageType[]): number {
  if (types.length === 0) return 0
  return types.filter((type) => DESIRABLE_TYPE_SET.has(type)).length / types.length
}

export function prospectableDensity(
  rows: ReadonlyArray<{ pageType: HhtPxPageType; isProspectable: boolean }>,
): number {
  if (rows.length === 0) return 0
  return rows.filter((row) => row.isProspectable).length / rows.length
}

export function defaultClusterPrior(cluster: HhtPxCluster, observedYield: number | null): number {
  if (observedYield == null) {
    const priors: Record<HhtPxCluster, number> = {
      hotel_hot_tubs: 40,
      romantic_hotels: 80,
      romantic_getaways: 90,
      honeymoon_anniversary: 75,
      spa_wellness: 70,
      unique_boutique_luxury: 65,
      adjacent_amenities: 85,
      cabins_lodges: 55,
      seasonal: 60,
      ski_beach_mountain_lake: 60,
      destination_planning: 70,
      occasion: 50,
      hot_springs: 35,
      national_editorial: 75,
      near_queries: 20,
    }
    return priors[cluster]
  }
  return Math.max(0, Math.min(100, observedYield * 10))
}
