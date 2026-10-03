import { load } from 'cheerio'
import type { PageSignals } from '@rnr/core'

const OTA_HOST = /(?:^|\.)(booking|expedia|hotels|tripadvisor|kayak|orbitz|travelocity|priceline|agoda|hotwire|trivago)\./i
const AFFILIATE_HREF = /(?:[?&](?:aid|tag|affid|affiliate|irclickid)=|shareasale|anrdoezrs|tkqlhce|jdoqocy|dpbolvw|pjtra|pntra|pntrs)/i
const WRITE_FOR_US = /write-for-us|write-for-me|guest-post|guestpost|contribute|submission-guidelines|writers?-guidelines/i

export interface ParsedPage {
  signals: PageSignals
  title: string
  h1: string
  headings: string[]
  metaDescription: string
  excerpt: string
}

export function parsePageSignals(html: string, pageUrl: string): ParsedPage {
  const $ = load(html)
  const schemaTypes = new Set<string>()
  let publishedTime = $('meta[property="article:published_time"]').attr('content')?.trim() || null
  let schemaAuthor = false
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      walkJsonLd(JSON.parse($(element).text()) as unknown, schemaTypes, (node) => {
        if (!publishedTime && typeof node['datePublished'] === 'string') publishedTime = node['datePublished']
        const types = schemaTypeList(node['@type'])
        if (types.includes('Person') || typeof node['author'] === 'string' || (node['author'] && typeof node['author'] === 'object')) {
          schemaAuthor = true
        }
      })
    } catch {
      // Ignore broken JSON-LD from the page.
    }
  })
  const title = $('title').first().text().replace(/\s+/g, ' ').trim()
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim()
  const metaDescription = (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    ''
  ).replace(/\s+/g, ' ').trim()
  const ogType = $('meta[property="og:type"]').attr('content')?.trim().toLowerCase() || null
  const hasAuthor = schemaAuthor || $('[rel="author"], .author, .byline').length > 0
  const headings: string[] = []
  $('h2').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim()
    if (text.length >= 8 && headings.length < 6) headings.push(text)
  })
  $('script, style, noscript, svg').remove()
  const mainText = ($('article').text() || $('main').text() || $('body').text()).replace(/\s+/g, ' ').trim()
  const words = mainText ? mainText.split(' ').filter(Boolean) : []
  let pageHost = ''
  try {
    pageHost = new URL(pageUrl).hostname.replace(/^www\./, '')
  } catch {
    pageHost = ''
  }
  let outboundLinks = 0
  let outboundHotelOrOta = 0
  let hasAffiliate = false
  let hasWriteForUs = false
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') ?? ''
    const linkText = $(element).text()
    if (AFFILIATE_HREF.test(href)) hasAffiliate = true
    if (WRITE_FOR_US.test(href) || WRITE_FOR_US.test(linkText)) hasWriteForUs = true
    let host = ''
    try {
      host = new URL(href, pageUrl).hostname.replace(/^www\./, '')
    } catch {
      return
    }
    if (!host || host === pageHost) return
    outboundLinks += 1
    if (OTA_HOST.test(host) || /hotel|inn|resort/.test(host.split('.')[0] ?? '')) outboundHotelOrOta += 1
  })
  const visible = `${title} ${h1} ${mainText.slice(0, 4_000)}`
  const hasBookingWidget = $('input[type="date"]').length > 0 || /book now|check availability|check-in|check in/i.test(visible)
  return {
    signals: {
      schemaTypes: [...schemaTypes],
      ogType,
      publishedTime,
      hasAuthor,
      wordCount: words.length,
      outboundLinks,
      outboundHotelOrOta,
      hasBookingWidget,
      hasAffiliate,
      hasWriteForUs,
    },
    title,
    h1,
    headings,
    metaDescription,
    excerpt: words.slice(0, 300).join(' '),
  }
}

function walkJsonLd(value: unknown, types: Set<string>, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJsonLd(item, types, visit)
    return
  }
  if (!value || typeof value !== 'object') return
  const node = value as Record<string, unknown>
  visit(node)
  for (const type of schemaTypeList(node['@type'])) types.add(type)
  if (Array.isArray(node['@graph'])) walkJsonLd(node['@graph'], types, visit)
}

function schemaTypeList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}
