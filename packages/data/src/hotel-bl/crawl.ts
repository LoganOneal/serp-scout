import 'server-only'
import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'
import {
  classifyHotelBlPageType,
  isFollowedHotelBlLink,
  isHotelBlEditorialPageType,
  isLikelyHotelBlEditorialLink,
  normalizeHotelBlUrl,
  type HotelBlContactType,
  type HotelBlPageType,
  type HotelBlRelationshipType,
} from '@rnr/core'

export const HOTEL_BL_CRAWL_CONFIG = {
  concurrency: 5,
  timeoutMs: 15_000,
  maxAttempts: 3,
  maxPagesPerDomain: 10,
  maxDepth: 1,
  maxSitemapUrls: 2_000,
  perDomainDelayMs: 250,
  maxHtmlBytes: 1_000_000,
} as const

export interface HotelBlExtractedEditorialLink {
  destinationUrl: string
  destinationDomain: string
  anchorText: string | null
  rel: string | null
  nofollow: boolean
  sponsored: boolean
  ugc: boolean
  followed: boolean
  publicationName: string | null
}

export interface HotelBlExtractedContact {
  name: string | null
  title: string | null
  email: string | null
  phone: string | null
  contactType: HotelBlContactType
  confidence: number
}

export interface HotelBlAlternateEntity {
  relationshipType: Exclude<HotelBlRelationshipType, 'property' | 'brand' | 'other'>
  entityName: string
  url: string
  domain: string
  rootDomain: string
  confidence: number
  evidence: string
}

export interface HotelBlExtractedPage {
  url: string
  pageType: HotelBlPageType
  title: string | null
  relevantInternalUrls: string[]
  editorialLinks: HotelBlExtractedEditorialLink[]
  contacts: HotelBlExtractedContact[]
  alternateEntities: HotelBlAlternateEntity[]
  externalLinkCount: number
  latestContentDate: Date | null
  dateConfidence: number | null
  hasPressKit: boolean
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function supportedDate(value: string | null | undefined): Date | null {
  if (!value?.trim()) return null
  const timestamp = Date.parse(value.trim())
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  const year = date.getUTCFullYear()
  if (year < 1990 || timestamp > Date.now() + 2 * 86_400_000) return null
  return date
}

function latestDate(values: Date[]): Date | null {
  let latest: Date | null = null
  for (const value of values) if (!latest || value > latest) latest = value
  return latest
}

function extractSupportedDates($: CheerioAPI): { date: Date | null; confidence: number | null } {
  const explicit: Date[] = []
  for (const selector of [
    'meta[property="article:published_time"]',
    'meta[property="article:modified_time"]',
    'meta[name="date"]',
    'meta[name="last-modified"]',
  ]) {
    $(selector).each((_, element) => {
      const date = supportedDate($(element).attr('content'))
      if (date) explicit.push(date)
    })
  }
  $('time[datetime]').each((_, element) => {
    const date = supportedDate($(element).attr('datetime'))
    if (date) explicit.push(date)
  })
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const value = JSON.parse($(element).text()) as unknown
      const queue: unknown[] = [value]
      let seen = 0
      while (queue.length > 0 && seen < 500) {
        const item = queue.shift()
        seen += 1
        if (!item || typeof item !== 'object') continue
        if (Array.isArray(item)) {
          queue.push(...item)
          continue
        }
        const row = item as Record<string, unknown>
        for (const key of ['datePublished', 'dateModified', 'uploadDate']) {
          if (typeof row[key] === 'string') {
            const date = supportedDate(row[key])
            if (date) explicit.push(date)
          }
        }
        for (const child of Object.values(row)) if (child && typeof child === 'object') queue.push(child)
      }
    } catch {
      // Invalid JSON-LD is not date evidence.
    }
  })
  return { date: latestDate(explicit), confidence: explicit.length > 0 ? 0.9 : null }
}

function contactType(text: string): HotelBlContactType {
  if (/public relations|\bpr\b|communications?/i.test(text)) return 'pr'
  if (/media|press/i.test(text)) return 'media'
  if (/marketing/i.test(text)) return 'marketing'
  if (/management|general manager|director of operations/i.test(text)) return 'management'
  return 'general'
}

function inferNameAndTitle(text: string): { name: string | null; title: string | null } {
  const titleMatch = text.match(/\b(?:director|manager|vice president|vp|head|chief|coordinator)\b[^|;,.]{0,70}/i)
  const nameMatch = text.match(/\b([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\b/)
  return { name: nameMatch?.[1] ?? null, title: titleMatch ? clean(titleMatch[0]) : null }
}

function extractContacts($: CheerioAPI): HotelBlExtractedContact[] {
  const results = new Map<string, HotelBlExtractedContact>()
  $('a[href^="mailto:"]').each((_, element) => {
    const email = decodeURIComponent(($(element).attr('href') ?? '').slice(7).split('?')[0] ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
    const context = clean($(element).closest('p, li, div, address').text()).slice(0, 500)
    const inferred = inferNameAndTitle(context)
    const type = contactType(context)
    results.set(`email:${email}`, {
      ...inferred,
      email,
      phone: null,
      contactType: type,
      confidence: type === 'general' ? 0.65 : 0.9,
    })
  })
  const bodyText = clean($('body').text())
  for (const match of bodyText.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const email = match[0].toLowerCase()
    if (results.has(`email:${email}`)) continue
    const start = Math.max(0, (match.index ?? 0) - 180)
    const context = bodyText.slice(start, (match.index ?? 0) + email.length + 180)
    const inferred = inferNameAndTitle(context)
    const type = contactType(context)
    results.set(`email:${email}`, {
      ...inferred,
      email,
      phone: null,
      contactType: type,
      confidence: type === 'general' ? 0.55 : 0.78,
    })
  }
  $('a[href^="tel:"]').each((_, element) => {
    const phone = clean(($(element).attr('href') ?? '').slice(4))
    if (!phone) return
    const context = clean($(element).closest('p, li, div, address').text()).slice(0, 500)
    const type = contactType(context)
    const key = `phone:${phone}`
    if (!results.has(key)) {
      results.set(key, {
        ...inferNameAndTitle(context),
        email: null,
        phone,
        contactType: type,
        confidence: type === 'general' ? 0.5 : 0.7,
      })
    }
  })
  return [...results.values()].slice(0, 20)
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function explicitAlternateRelationship(
  context: string,
  entityName: string,
): HotelBlAlternateEntity['relationshipType'] | null {
  const entity = clean(entityName)
  if (entity.length < 2) return null
  const escaped = regexEscape(entity)
  const suffix = `(?:the\\s+)?${escaped}`
  if (new RegExp(`(?:public relations|pr agency|communications agency|media contact|press contact)\\s*(?:by|:|–|-)\\s*${suffix}`, 'i').test(context)) return 'pr_agency'
  if (new RegExp(`(?:managed|operated)\\s+by\\s+${suffix}|(?:management company|management group|hotel operator|operator)\\s*(?:is|:|–|-)\\s*${suffix}`, 'i').test(context)) return 'management_company'
  if (new RegExp(`(?:owned|developed)\\s+by\\s+${suffix}|(?:owner|ownership group)\\s*(?:is|:|–|-)\\s*${suffix}`, 'i').test(context)) return 'owner'
  return null
}

function extractAlternateEntities($: CheerioAPI, pageUrl: string, sourceRootDomain: string): HotelBlAlternateEntity[] {
  const found = new Map<string, HotelBlAlternateEntity>()
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) return
    let normalized
    try {
      normalized = normalizeHotelBlUrl(new URL(href, pageUrl).toString())
    } catch {
      return
    }
    if (!normalized || normalized.rootDomain === sourceRootDomain) return
    const context = clean($(element).closest('p, li, div, footer, address').text()).slice(0, 600)
    const entityName = clean($(element).text()) || normalized.hostname
    const relationshipType = explicitAlternateRelationship(context, entityName)
    if (!relationshipType) return
    const key = `${relationshipType}:${normalized.hostname}`
    found.set(key, {
      relationshipType,
      entityName,
      url: normalized.url,
      domain: normalized.hostname,
      rootDomain: normalized.rootDomain,
      confidence: 0.82,
      evidence: context,
    })
  })
  return [...found.values()].slice(0, 10)
}

export function extractHotelBlPage(html: string, pageUrl: string): HotelBlExtractedPage {
  const $ = load(html)
  const normalizedPage = normalizeHotelBlUrl(pageUrl)
  if (!normalizedPage) throw new Error(`Cannot normalize crawled page URL: ${pageUrl}`)
  const title = clean($('title').first().text()) || null
  const pageType = classifyHotelBlPageType(pageUrl, title ?? '', clean($('h1').first().text()))
  const relevantInternalUrls = new Set<string>()
  const editorialLinks: HotelBlExtractedEditorialLink[] = []
  let externalLinkCount = 0
  $('a[href]').each((_, element) => {
    const rawHref = $(element).attr('href')
    if (!rawHref || /^(mailto|tel|javascript|data):/i.test(rawHref)) return
    let destination
    try {
      destination = normalizeHotelBlUrl(new URL(rawHref, pageUrl).toString())
    } catch {
      return
    }
    if (!destination) return
    const anchorText = clean($(element).text()) || null
    if (destination.hostname === normalizedPage.hostname) {
      if (classifyHotelBlPageType(destination.url, '', anchorText ?? '') !== 'other') {
        relevantInternalUrls.add(destination.url)
      }
      return
    }
    externalLinkCount += 1
    const context = clean($(element).closest('p, li, div, section, article, footer, address').text()).slice(0, 600)
    // An explicit manager/owner/agency attribution is relationship evidence,
    // not proof that the hotel republishes third-party editorial coverage.
    if (anchorText && explicitAlternateRelationship(context, anchorText)) return
    const editorialSourceType =
      pageType === 'other' && /featured[- ]?in|as seen in|in the press|press coverage|awards?|accolades?|recognition/i.test(context)
        ? ('press' as const)
        : pageType
    if (!isLikelyHotelBlEditorialLink({ destinationUrl: destination.url, anchorText, sourcePageType: editorialSourceType })) return
    const rel = $(element).attr('rel') ?? null
    const relValues = new Set((rel ?? '').toLowerCase().split(/\s+/).filter(Boolean))
    editorialLinks.push({
      destinationUrl: destination.url,
      destinationDomain: destination.rootDomain,
      anchorText,
      rel,
      nofollow: relValues.has('nofollow'),
      sponsored: relValues.has('sponsored'),
      ugc: relValues.has('ugc'),
      followed: isFollowedHotelBlLink(rel),
      publicationName: anchorText?.slice(0, 200) ?? destination.rootDomain,
    })
  })
  const dates = extractSupportedDates($)
  const bodyText = clean($('body').text())
  return {
    url: normalizedPage.url,
    pageType,
    title,
    relevantInternalUrls: [...relevantInternalUrls],
    editorialLinks,
    contacts: extractContacts($),
    alternateEntities: extractAlternateEntities($, pageUrl, normalizedPage.rootDomain),
    externalLinkCount,
    latestContentDate: dates.date,
    dateConfidence: dates.confidence,
    hasPressKit: /press kit|media kit/i.test(bodyText),
  }
}

export interface HotelBlFetchResult {
  url: string
  status: number | null
  html: string | null
  error: string | null
  lastModified: Date | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchHotelBlPage(
  url: string,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    maxAttempts?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<HotelBlFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? HOTEL_BL_CRAWL_CONFIG.timeoutMs
  const maxAttempts = options.maxAttempts ?? HOTEL_BL_CRAWL_CONFIG.maxAttempts
  const wait = options.sleep ?? sleep
  let lastError: string | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'HotelHotTubsBacklinkScout/0.1 (+https://hotelhottubs.com)',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.7',
        },
      })
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        lastError = `HTTP ${response.status}`
        await wait(300 * 2 ** (attempt - 1))
        continue
      }
      if (!response.ok) return { url: response.url || url, status: response.status, html: null, error: `HTTP ${response.status}`, lastModified: null }
      const contentType = response.headers.get('content-type') ?? ''
      if (!/html|xml|text/i.test(contentType)) return { url: response.url || url, status: response.status, html: null, error: `Unsupported content type ${contentType}`, lastModified: null }
      // PostgreSQL text rejects U+0000. A few legacy hotel servers leak NUL bytes
      // into otherwise valid HTML, so remove them once at the HTTP boundary before
      // parsing, hashing, or persisting any derived crawl evidence.
      const html = (await response.text()).replaceAll('\0', '').slice(0, HOTEL_BL_CRAWL_CONFIG.maxHtmlBytes)
      return {
        url: response.url || url,
        status: response.status,
        html,
        error: null,
        lastModified: supportedDate(response.headers.get('last-modified')),
      }
    } catch (error) {
      lastError = controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error)
      if (attempt < maxAttempts) await wait(300 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }
  return { url, status: null, html: null, error: lastError ?? 'Fetch failed', lastModified: null }
}

export function hotelBlContentHash(html: string): string {
  return createHash('sha256').update(html).digest('hex')
}

export function parseHotelBlRobots(body: string, pathname: string): boolean {
  let applies = false
  const disallowed: string[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const [rawKey, ...parts] = line.split(':')
    const key = rawKey?.trim().toLowerCase()
    const value = parts.join(':').trim()
    if (key === 'user-agent') applies = value === '*'
    if (key === 'disallow' && applies && value) disallowed.push(value)
  }
  return !disallowed.some((path) => pathname.startsWith(path))
}

export function extractHotelBlSitemapUrls(xml: string, limit = HOTEL_BL_CRAWL_CONFIG.maxSitemapUrls): Array<{ url: string; lastModified: Date | null }> {
  const $ = load(xml, { xmlMode: true })
  const results: Array<{ url: string; lastModified: Date | null }> = []
  $('url').each((_, element) => {
    if (results.length >= limit) return
    const url = clean($(element).find('loc').first().text())
    if (!url) return
    results.push({ url, lastModified: supportedDate($(element).find('lastmod').first().text()) })
  })
  return results
}

export function extractHotelBlSitemapIndexUrls(xml: string, limit = 2): string[] {
  const $ = load(xml, { xmlMode: true })
  return $('sitemap > loc')
    .map((_, element) => clean($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, limit)
}

export function conventionalHotelBlPaths(origin: string): string[] {
  return ['/press', '/media', '/news', '/awards', '/blog', '/about', '/contact'].map(
    (path) => new URL(path, origin).toString(),
  )
}
