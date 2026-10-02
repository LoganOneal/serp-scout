import type { HhtPageType } from './types.js'

export interface ParsedSitemapUrl {
  url: string
  pageType: HhtPageType
  city: string | null
  state: string | null
  collection: string | null
}

const COLLECTIONS: Record<string, string> = {
  romantic: 'romantic',
  budget: 'budget',
  cheap: 'budget',
  motels: 'motels',
  motel: 'motels',
  suites: 'suites',
  suite: 'suites',
  'whirlpool-suites': 'whirlpool suites',
  whirlpool: 'whirlpool suites',
  'private-outdoor': 'private outdoor',
  outdoor: 'private outdoor',
}

export function parseSitemapUrls(xml: string, origin = 'https://www.hotelhottubs.com'): ParsedSitemapUrl[] {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => match[1]?.trim() ?? '')
  const pages: ParsedSitemapUrl[] = []
  for (const loc of locs) {
    if (!loc.startsWith(origin) && !loc.includes('hotelhottubs.com')) continue
    const parsed = classifyHhtUrl(loc)
    if (parsed) pages.push(parsed)
  }
  return pages
}

export function classifyHhtUrl(url: string): ParsedSitemapUrl | null {
  let pathname = '/'
  try {
    pathname = new URL(url).pathname.replace(/\/$/, '') || '/'
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '') {
    return { url, pageType: 'homepage', city: null, state: null, collection: null }
  }
  const parts = pathname.split('/').filter(Boolean)
  const head = (parts[0] ?? '').toLowerCase()
  if (head.includes('editor')) return { url, pageType: 'editors_choice', city: null, state: null, collection: null }
  if (head === 'blog' || head === 'guides' || head === 'guide') {
    return { url, pageType: 'blog_guide', city: null, state: null, collection: null }
  }
  if (COLLECTIONS[head] && parts.length === 1) {
    return { url, pageType: 'collection', city: null, state: null, collection: COLLECTIONS[head] ?? null }
  }
  if (parts.length === 1) return { url, pageType: 'state', city: null, state: titleCase(head), collection: null }
  if (parts.length === 2) return { url, pageType: 'city', city: titleCase(parts[1] ?? ''), state: titleCase(head), collection: null }
  return { url, pageType: 'property', city: titleCase(parts[1] ?? ''), state: titleCase(head), collection: null }
}

export function verifiedStayCountFromHtml(html: string): number | null {
  const match = html.match(/(\d[\d,]*)\s+verified\s+stays?/i)
  if (!match?.[1]) return null
  const count = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(count) ? count : null
}

function titleCase(slug: string): string {
  return slug.split('-').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}
