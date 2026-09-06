import { HHT_SITE_URL } from './types.js'

const TRAVEL_RESOURCE = /hotel|travel|honeymoon|romantic|getaway|jacuzzi|hot.?tub|whirlpool|suite|destination|tourism|inn|resort/i
const SKIP_BROKEN = /doubleclick|googletag|facebook|instagram|twitter|linkedin|pinterest|tiktok|amazon\.|ebay\.|sentry|cloudflare|w3\.org|schema\.org/i

export interface BrokenLinkCandidate {
  url: string
  domain: string
  anchor: string
}

export function isBrokenLinkTarget(url: string, anchor = ''): boolean {
  if (SKIP_BROKEN.test(url)) return false
  return TRAVEL_RESOURCE.test(`${url} ${anchor}`)
}

export function brokenLinkRelevance(pageText: string, brokenUrl: string, anchor = ''): number {
  if (!isBrokenLinkTarget(brokenUrl, anchor)) return 0
  let score = 40
  const blob = `${pageText} ${brokenUrl} ${anchor}`.toLowerCase()
  for (const term of ['hotel', 'jacuzzi', 'hot tub', 'romantic', 'honeymoon', 'getaway', 'suite']) {
    if (blob.includes(term)) score += 8
  }
  return Math.min(100, score)
}

export function shouldCreateBrokenLinkOpportunity(relevance: number): boolean {
  return relevance >= 56
}

export function defaultHhtReplacementUrl(): string {
  return HHT_SITE_URL
}

export function isFailedFetchStatus(status: number | null, error: string | null): boolean {
  if (status === 404 || status === 410) return true
  if (error && /404|410|enotfound|getaddrinfo|nxdomain|no such host/i.test(error)) return true
  return false
}
