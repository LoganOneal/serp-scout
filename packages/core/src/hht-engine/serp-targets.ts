import { classifyByRules, siteTypeNeedsGuestPost, type SiteRules } from './sites.js'
import type { SiteType } from './types.js'

export type PageQuality = 'article' | 'commercial' | 'tourism' | 'unsure'
export type SerpTargetLane = 'both' | 'guest_post' | 'tourism' | 'skip'

export interface UrlTriage {
  quality: PageQuality
  siteType: SiteType | null
  reason: string
}

export interface PageSignals {
  schemaTypes: string[]
  ogType: string | null
  publishedTime: string | null
  hasAuthor: boolean
  wordCount: number
  outboundLinks: number
  outboundHotelOrOta: number
  hasBookingWidget: boolean
  hasAffiliate: boolean
  hasWriteForUs: boolean
}

export interface PageScore {
  quality: PageQuality
  affiliate: boolean
  score: number
  reason: string
}

export interface SerpLeadDecision {
  lane: SerpTargetLane
  siteType: SiteType | null
  affiliate: boolean
  reasons: string[]
}

const EDITORIAL_PATH = /\/(blog|blogs|article|articles|news|stories|story|guides|guide)\//i
const COMMERCIAL_PATH = /\/(hotel|hotels|rooms|book|booking|property|p)(\/|$)/i
const DATED_PATH = /\/20\d{2}\/\d{1,2}(\/|$)/
const ARTICLE_SLUG = /^(?:best|top|things-to-do|romantic-getaways)-[a-z0-9-]+$/
const LODGING_HOST = /hotel|inn|resort|suites/
const ARTICLE_SCHEMA = new Set(['Article', 'BlogPosting', 'NewsArticle'])
const COMMERCIAL_SCHEMA = new Set(['Hotel', 'LodgingBusiness', 'Product', 'Offer', 'Resort', 'BedAndBreakfast', 'Motel'])
const TOURISM_SCHEMA = new Set(['TouristInformationCenter', 'GovernmentOrganization', 'CivicStructure'])

export function triageSerpUrl(input: { url: string; rootDomain: string; rules: SiteRules }): UrlTriage {
  const ruled = classifyByRules(input.rootDomain, input.rules)
  if (ruled && !siteTypeNeedsGuestPost(ruled)) {
    return { quality: 'commercial', siteType: ruled, reason: ruled }
  }
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return { quality: 'unsure', siteType: ruled, reason: 'unparsed_url' }
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (isTourismHost(host)) return { quality: 'tourism', siteType: ruled, reason: 'tourism_domain' }
  const path = parsed.pathname.toLowerCase()
  const segments = path.split('/').filter(Boolean).map((segment) => segment.replace(/\.html?$/, ''))
  const slug = segments.at(-1) ?? ''
  if (EDITORIAL_PATH.test(path) || DATED_PATH.test(path) || ARTICLE_SLUG.test(slug)) {
    return { quality: 'article', siteType: ruled ?? 'editorial_blog', reason: 'article_url' }
  }
  if (
    path === '/' ||
    path === '' ||
    COMMERCIAL_PATH.test(path) ||
    parsed.searchParams.has('checkin') ||
    (lodgingHost(host) && shortPath(segments))
  ) {
    return { quality: 'commercial', siteType: ruled ?? (lodgingHost(host) ? 'hotel_property' : null), reason: 'commercial_url' }
  }
  return { quality: 'unsure', siteType: ruled, reason: 'ambiguous_url' }
}

export function scorePageSignals(signals: PageSignals): PageScore {
  const types = new Set(signals.schemaTypes)
  if ([...types].some((type) => TOURISM_SCHEMA.has(type)) && ![...types].some((type) => ARTICLE_SCHEMA.has(type))) {
    return { quality: 'tourism', affiliate: signals.hasAffiliate, score: 0, reason: 'tourism_schema' }
  }
  let score = 0
  if ([...types].some((type) => ARTICLE_SCHEMA.has(type))) score += 3
  if ([...types].some((type) => COMMERCIAL_SCHEMA.has(type))) score -= 3
  if (types.has('ItemList')) score += 1
  if (signals.ogType === 'article') score += 1
  if (signals.ogType === 'product') score -= 1
  if (signals.publishedTime) score += 1
  if (signals.hasAuthor) score += 1
  if (signals.wordCount > 800) score += 2
  else if (signals.wordCount > 0 && signals.wordCount < 400) score -= 1
  if (signals.outboundLinks >= 5) score += 1
  if (signals.outboundHotelOrOta >= 2) score += 1
  if (signals.hasBookingWidget) score -= 3
  if (signals.hasAffiliate) score += 3
  if (signals.hasWriteForUs) score += 1
  const quality: PageQuality = score >= 2 ? 'article' : score <= -2 ? 'commercial' : 'unsure'
  return { quality, affiliate: signals.hasAffiliate, score, reason: 'page_signals' }
}

export function serpLeadDecision(input: {
  position: number
  quality: PageQuality
  affiliate: boolean
  siteType: SiteType | null
  stage: string
}): SerpLeadDecision {
  const reasons = [`${input.stage}:${input.quality}`]
  if (input.affiliate) reasons.push('affiliate_listicle')
  if (input.position < 1 || input.position > 100 || input.quality === 'commercial' || input.quality === 'unsure') {
    return { lane: 'skip', siteType: input.siteType, affiliate: input.affiliate, reasons }
  }
  if (input.quality === 'tourism') {
    return { lane: 'tourism', siteType: input.siteType, affiliate: false, reasons }
  }
  const lane = input.position <= 10 || input.affiliate ? 'both' : 'guest_post'
  return {
    lane,
    siteType: input.siteType ?? 'editorial_blog',
    affiliate: input.affiliate,
    reasons,
  }
}

function isTourismHost(host: string): boolean {
  if (host.endsWith('.gov') || host.endsWith('.gov.uk')) return true
  if (/^visit[a-z0-9-]+\.(com|org|us)$/.test(host)) return true
  const compact = host.replace(/[^a-z]/g, '')
  return compact.includes('cvb') || compact.includes('visitorsbureau') || compact.includes('conventionandvisitors')
}

function lodgingHost(host: string): boolean {
  const name = host.split('.')[0] ?? ''
  return LODGING_HOST.test(name)
}

function shortPath(segments: string[]): boolean {
  if (segments.length === 0) return true
  if (segments.length > 1) return false
  const words = segments[0]?.split('-').filter((word) => word.length > 1) ?? []
  return words.length < 4
}
