import 'server-only'
import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'
import { normalizeHhtBlUrl } from '@rnr/core'

const USER_AGENT = 'Mozilla/5.0 (compatible; HotelHotTubsResearch/0.1; +backlink-research)'

export interface HhtBlCrawlResult {
  url: string
  httpStatus: number | null
  canonicalUrl: string | null
  title: string | null
  pageText: string | null
  rawHtml: string | null
  contentHash: string | null
  attempts: number
  error: string | null
}

export interface HhtBlCrawlOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function visiblePageText($: CheerioAPI): string {
  $('script, style, noscript, template, svg').remove()
  return $('body').text().replace(/\s+/g, ' ').trim()
}

export async function crawlHhtBlPage(
  url: string,
  options: HhtBlCrawlOptions = {},
): Promise<HhtBlCrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
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
      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < maxAttempts) {
        lastError = `HTTP ${response.status}`
        await sleep(250 * 2 ** (attempt - 1))
        continue
      }
      if (!response.ok) {
        return {
          url,
          httpStatus: response.status,
          canonicalUrl: normalizeHhtBlUrl(response.url || url),
          title: null,
          pageText: null,
          rawHtml: null,
          contentHash: null,
          attempts: attempt,
          error: `HTTP ${response.status}`,
        }
      }

      const html = await response.text()
      const $ = load(html)
      const canonicalHref = $('link[rel="canonical"]').first().attr('href')
      const finalUrl = response.url || url
      const canonicalUrl = normalizeHhtBlUrl(
        canonicalHref ? new URL(canonicalHref, finalUrl).toString() : finalUrl,
      )
      const title = $('title').first().text().replace(/\s+/g, ' ').trim() || null
      const pageText = visiblePageText($)
      return {
        url,
        httpStatus: response.status,
        canonicalUrl,
        title,
        pageText,
        rawHtml: html,
        contentHash: createHash('sha256').update(html).digest('hex'),
        attempts: attempt,
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
    httpStatus: null,
    canonicalUrl: null,
    title: null,
    pageText: null,
    rawHtml: null,
    contentHash: null,
    attempts: maxAttempts,
    error: lastError ?? 'crawl failed',
  }
}

export interface HhtBlLinkContextResult {
  located: boolean
  anchor: string | null
  surroundingParagraph: string | null
  surroundingSection: string | null
  headingHierarchy: string[]
  nearbyOutboundLinks: Array<{ href: string; text: string }>
  domContext: string | null
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function extractHhtBlLinkContext(
  html: string,
  pageUrl: string,
  targetUrl: string,
): HhtBlLinkContextResult {
  const $ = load(html)
  const normalizedTarget = normalizeHhtBlUrl(targetUrl)
  const links = $('a[href]')
  let matchIndex = -1

  links.each((index, element) => {
    if (matchIndex >= 0) return
    const href = $(element).attr('href')
    if (!href) return
    try {
      if (normalizeHhtBlUrl(new URL(href, pageUrl).toString()) === normalizedTarget) {
        matchIndex = index
      }
    } catch {
      // Invalid hrefs are evidence of nothing and are ignored.
    }
  })

  if (matchIndex < 0) {
    return {
      located: false,
      anchor: null,
      surroundingParagraph: null,
      surroundingSection: null,
      headingHierarchy: [],
      nearbyOutboundLinks: [],
      domContext: null,
    }
  }

  const link = links.eq(matchIndex)
  const paragraph = link.closest('p, li, blockquote, figcaption, dd').first()
  const section = link.closest('section, article, main, div').first()
  const scope = section.length > 0 ? section : paragraph
  const headings: string[] = []
  const headingSelector = 'h1, h2, h3, h4, h5, h6'
  const priorHeadings = link.parents().addBack().prevAll(headingSelector).toArray().reverse()
  for (const heading of priorHeadings) {
    const text = cleanText($(heading).text())
    if (text && !headings.includes(text)) headings.push(text)
  }

  const nearbyOutboundLinks: Array<{ href: string; text: string }> = []
  scope.find('a[href]').slice(0, 20).each((_, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      nearbyOutboundLinks.push({
        href: new URL(href, pageUrl).toString(),
        text: cleanText($(element).text()),
      })
    } catch {
      // Keep only absolute, inspectable link evidence.
    }
  })

  return {
    located: true,
    anchor: cleanText(link.text()) || null,
    surroundingParagraph: cleanText(paragraph.text()) || null,
    surroundingSection: cleanText(scope.text()).slice(0, 12_000) || null,
    headingHierarchy: headings.slice(-6),
    nearbyOutboundLinks,
    domContext: $.html(link.parent()).slice(0, 12_000) || null,
  }
}
