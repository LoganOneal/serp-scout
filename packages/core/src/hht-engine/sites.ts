import type { SiteType } from './types.js'

export interface SiteRules {
  otas: string[]
  hotelChains: string[]
  competitors: string[]
  forums: string[]
  marketplaces: string[]
  searchEngines: string[]
  hht: string[]
}

export const DEFAULT_SITE_RULES: SiteRules = {
  otas: ['booking.com', 'expedia.com', 'hotels.com', 'tripadvisor.com', 'kayak.com', 'agoda.com'],
  hotelChains: ['marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com'],
  competitors: [],
  forums: ['reddit.com', 'pinterest.com', 'facebook.com', 'quora.com', 'x.com', 'twitter.com'],
  marketplaces: ['amazon.com', 'ebay.com'],
  searchEngines: ['google.com', 'bing.com', 'duckduckgo.com'],
  hht: ['hotelhottubs.com'],
}

export function classifyByRules(rootDomain: string, rules: SiteRules): SiteType | null {
  const domain = rootDomain.toLowerCase().replace(/^www\./, '')
  const hit = (list: string[]) => list.some((item) => domain === item || domain.endsWith(`.${item}`))
  if (hit(rules.hht)) return 'hht'
  if (hit(rules.otas)) return 'ota_booking'
  if (hit(rules.hotelChains)) return 'hotel_chain'
  if (hit(rules.competitors)) return 'competitor_directory'
  if (hit(rules.forums)) return 'forum_social_ugc'
  if (hit(rules.marketplaces)) return 'marketplace'
  if (hit(rules.searchEngines)) return 'search_engine'
  return null
}

export function siteTypeNeedsGuestPost(siteType: SiteType): boolean {
  return siteType === 'editorial_blog' || siteType === 'news_media' || siteType === 'travel_guide'
}

export function editorialPage(pageType: string | null): boolean {
  if (!pageType) return true
  return !['search', 'social', 'forum', 'marketplace', 'product', 'booking'].includes(pageType)
}
