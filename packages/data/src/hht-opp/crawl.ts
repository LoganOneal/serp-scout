import 'server-only'
import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'
import { looksLikeOpportunityPath, normalizeHhtBlUrl, registrableDomain } from '@rnr/core'

const USER_AGENT = 'Mozilla/5.0 (compatible; HotelHotTubsOpportunityEngine/0.1; +https://hotelhottubs.com)'

export const HHT_OPP_CRAWL = {
  timeoutMs: 15_000,
  maxAttempts: 3,
  perDomainDelayMs: 250,
  maxHtmlBytes: 1_200_000,
  maxRelatedPages: 8,
} as const

const COMMON_PATHS = [
  '/write-for-us',
  '/contribute',
  '/guest-post',
  '/guest-posts',
  '/submissions',
  '/advertise',
  '/advertising',
  '/media-kit',
  '/mediakit',
  '/sponsorship',
  '/partners',
  '/partnerships',
  '/work-with-us',
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
  '/press',
]

const COMMERCIAL_HINT = /casino|crypto|cbd|loan|insurance|vpn|seo service|buy now|sponsored/i

export interface HhtOppCrawlResult {
  url: string
  finalUrl: string | null
  httpStatus: number | null
  title: string | null
  pageText: string | null
  rawHtml: string | null
  contentHash: string | null
  relatedUrls: string[]
  outbound: OutboundSample | null
  mentionsHht: boolean
  linksToHht: boolean
  error: string | null
}

export interface OutboundSample {
  externalLinks: number
  internalLinks: number
  uniqueExternalDomains: number
  commercialLinks: number
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function visibleText($: CheerioAPI): string {
  $('script, style, noscript, template, svg').remove()
  return $('body').text().replace(/\s+/g, ' ').trim()
}

export interface OutboundLink {
  url: string
  domain: string
  anchor: string
}

export function listOutboundLinks(html: string, pageUrl: string, limit = 80): OutboundLink[] {
  const $ = load(html)
  const pageDomain = registrableDomain(pageUrl)?.domain
  const out: OutboundLink[] = []
  const seen = new Set<string>()
  $('a[href]').each((_, el) => {
    if (out.length >= limit) return
    const href = $(el).attr('href')
    if (!href || /^(mailto|tel|javascript|#)/i.test(href)) return
    let dest: URL
    try {
      dest = new URL(href, pageUrl)
    } catch {
      return
    }
    if (!/^https?:$/.test(dest.protocol)) return
    const destDomain = registrableDomain(dest.hostname)?.domain
    if (!destDomain || !pageDomain || destDomain === pageDomain) return
    const url = dest.toString()
    if (seen.has(url)) return
    seen.add(url)
    out.push({ url, domain: destDomain, anchor: ($(el).text() || '').replace(/\s+/g, ' ').trim() })
  })
  return out
}

export function analyzeOutbound(html: string, pageUrl: string): OutboundSample {
  const $ = load(html)
  const pageDomain = registrableDomain(pageUrl)?.domain
  const external = new Set<string>()
  let externalLinks = 0
  let internalLinks = 0
  let commercialLinks = 0

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href || /^(mailto|tel|javascript|#)/i.test(href)) return
    let dest: URL
    try {
      dest = new URL(href, pageUrl)
    } catch {
      return
    }
    if (!/^https?:$/.test(dest.protocol)) return
    const destDomain = registrableDomain(dest.hostname)?.domain
    if (!destDomain || !pageDomain) return
    if (destDomain === pageDomain) {
      internalLinks += 1
      return
    }
    externalLinks += 1
    external.add(destDomain)
    const anchor = ($(el).text() || '') + ' ' + dest.hostname
    if (COMMERCIAL_HINT.test(anchor)) commercialLinks += 1
  })

  return {
    externalLinks,
    internalLinks,
    uniqueExternalDomains: external.size,
    commercialLinks,
  }
}

export function pageMentionsHht(text: string): boolean {
  return /hotel\s*hot\s*tubs|hotelhottubs(?:\.com)?/i.test(text)
}

export function pageLinksToHht(html: string, pageUrl: string): boolean {
  const $ = load(html)
  let found = false
  $('a[href]').each((_, el) => {
    if (found) return
    const href = $(el).attr('href')
    if (!href) return
    try {
      const dest = new URL(href, pageUrl)
      if (registrableDomain(dest.hostname)?.domain === 'hotelhottubs.com') found = true
    } catch {
      // ignore
    }
  })
  return found
}

export function extractRelatedUrls(html: string, pageUrl: string, limit = HHT_OPP_CRAWL.maxRelatedPages): string[] {
  const $ = load(html)
  const pageDomain = registrableDomain(pageUrl)?.domain
  const found = new Set<string>()
  const add = (raw: string | undefined) => {
    if (!raw || found.size >= limit) return
    try {
      const dest = new URL(raw, pageUrl)
      if (registrableDomain(dest.hostname)?.domain !== pageDomain) return
      const normalized = normalizeHhtBlUrl(dest.toString())
      if (normalized && looksLikeOpportunityPath(normalized)) found.add(normalized)
    } catch {
      // ignore
    }
  }

  $('a[href]').each((_, el) => add($(el).attr('href')))
  return [...found]
}

export async function crawlHhtOppPage(
  url: string,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    maxAttempts?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<HhtOppCrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? HHT_OPP_CRAWL.timeoutMs
  const maxAttempts = Math.max(1, options.maxAttempts ?? HHT_OPP_CRAWL.maxAttempts)
  const sleep = options.sleep ?? wait
  let lastError: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.8',
        },
      })
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        lastError = `HTTP ${response.status}`
        await sleep(250 * 2 ** (attempt - 1))
        continue
      }
      const finalUrl = normalizeHhtBlUrl(response.url || url) ?? url
      if (!response.ok) {
        return {
          url,
          finalUrl,
          httpStatus: response.status,
          title: null,
          pageText: null,
          rawHtml: null,
          contentHash: null,
          relatedUrls: [],
          outbound: null,
          mentionsHht: false,
          linksToHht: false,
          error: `HTTP ${response.status}`,
        }
      }
      const html = sanitizePageBytes((await response.text()).slice(0, HHT_OPP_CRAWL.maxHtmlBytes))
      const $ = load(html)
      const title = $('title').first().text().replace(/\s+/g, ' ').trim() || null
      const pageText = sanitizePageBytes(visibleText($))
      return {
        url,
        finalUrl,
        httpStatus: response.status,
        title,
        pageText,
        rawHtml: html,
        contentHash: createHash('sha256').update(html).digest('hex'),
        relatedUrls: extractRelatedUrls(html, finalUrl),
        outbound: analyzeOutbound(html, finalUrl),
        mentionsHht: pageMentionsHht(`${title ?? ''}\n${pageText}`),
        linksToHht: pageLinksToHht(html, finalUrl),
        error: null,
      }
    } catch (error) {
      lastError = controller.signal.aborted
        ? `Timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
      if (attempt < maxAttempts) await sleep(250 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    url,
    finalUrl: null,
    httpStatus: null,
    title: null,
    pageText: null,
    rawHtml: null,
    contentHash: null,
    relatedUrls: [],
    outbound: null,
    mentionsHht: false,
    linksToHht: false,
    error: lastError ?? 'crawl failed',
  }
}

export function sanitizePageBytes(value: string): string {
  return value.replace(/\u0000/g, '')
}

export function commonPathUrls(seedUrl: string): string[] {
  const domain = registrableDomain(seedUrl)?.domain
  if (!domain) return []
  return COMMON_PATHS.map((path) => `https://${domain}${path}`)
}
