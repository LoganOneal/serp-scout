/**
 * Guest-post discovery frontier.
 *
 * Semrush is spent only when a keyword is likely to return a different SERP
 * from one already fetched. The thresholds match the HHT engine: a token
 * overlap of 0.92 is a near-duplicate, 0.72 is the same neighborhood, and a
 * result-URL Jaccard of 0.5 means that neighborhood is used up.
 */

import { serpJaccard, neighborhoodLabel, SERP_OVERLAP_SATURATED, type Neighborhood } from '../hht-engine/frontier.js'
import { normalizeFrontierKeyword, volumeIsZero } from '../hht-engine/keywords.js'
import { extractContacts, pickPrimaryContact } from './extract.js'

export const GUEST_NEAR_DUPLICATE_SIMILARITY = 0.92
export const GUEST_NEIGHBORHOOD_SIMILARITY = 0.72
export const GUEST_SERP_OVERLAP_SATURATED = SERP_OVERLAP_SATURATED

const TRAVEL_BLOG =
  /\b(travel|travell?ing|blog|hotel|honeymoon|tourism|tourist|getaway|destination|vacation|itinerary|resort|romantic|backpack|cruise|things to do|city guide|visitor)\b/i

const OFF_TOPIC =
  /\b(for sale|repair|repairs|install(?:ation|ers)?|chemicals?|parts|casino|crypto|porn|salary|login|coupon)\b/i

const FORM_PATH =
  /\/(?:write-for-us|write-for-me|guest-posts?|guest-blogs?|contact-us|contact|submissions?|submit|pitch)\/?$/i

const FORM_HOST = /(^|\.)((docs\.google\.com)|typeform\.com|forms\.gle)$/i

const MAILTO = /mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi

const NOREPLY = /^(noreply|no-reply)@/i

export interface FetchedGuestKeyword {
  keyword: string
  neighborhood: Neighborhood | null
}

export type GuestKeywordSkip = {
  fetch: false
  reason: 'near_duplicate' | 'neighborhood_saturated'
  matched: string
  similarity: number
}

export function isGuestFrontierKeyword(keyword: string): boolean {
  const text = keyword.replace(/\s+/g, ' ').trim()
  if (text.split(' ').length < 2) return false
  if (OFF_TOPIC.test(text)) return false
  return TRAVEL_BLOG.test(text)
}

export function guestKeywordSimilarity(left: string, right: string): number {
  return serpJaccard(keywordTokens(left), keywordTokens(right))
}

/** Skip a Semrush call when the phrase is a duplicate or sits in a used-up neighborhood. */
export function guestKeywordFetchDecision(
  candidate: string,
  fetched: readonly FetchedGuestKeyword[],
  thresholds: { nearDuplicate?: number; neighborhood?: number } = {},
): { fetch: true } | GuestKeywordSkip {
  const nearDuplicate = thresholds.nearDuplicate ?? GUEST_NEAR_DUPLICATE_SIMILARITY
  const neighborhood = thresholds.neighborhood ?? GUEST_NEIGHBORHOOD_SIMILARITY
  let best: { keyword: string; neighborhood: Neighborhood | null; similarity: number } | null = null
  for (const row of fetched) {
    const similarity = guestKeywordSimilarity(candidate, row.keyword)
    if (!best || similarity > best.similarity) best = { ...row, similarity }
  }
  if (!best || best.similarity <= 0) return { fetch: true }
  if (best.similarity >= nearDuplicate) {
    return { fetch: false, reason: 'near_duplicate', matched: best.keyword, similarity: best.similarity }
  }
  if (best.neighborhood === 'saturated' && best.similarity >= neighborhood) {
    return { fetch: false, reason: 'neighborhood_saturated', matched: best.keyword, similarity: best.similarity }
  }
  return { fetch: true }
}

/** Identity of a SERP hit for overlap. Tracking query strings do not make two URLs different. */
export function serpResultKey(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '') || '/'
    return `${host}${path}`
  } catch {
    return url.trim().toLowerCase()
  }
}

/** Highest Jaccard overlap between this SERP and any SERP already paid for. */
export function maxSerpResultOverlap(mine: readonly string[], others: readonly (readonly string[])[]): number {
  const left = unique(mine)
  if (left.length === 0) return 0
  let max = 0
  for (const other of others) {
    max = Math.max(max, serpJaccard(left, unique(other)))
  }
  return max
}

export function guestSerpNeighborhood(overlap: number, pitchableDomains: number): Neighborhood {
  return neighborhoodLabel(overlap, pitchableDomains, GUEST_SERP_OVERLAP_SATURATED)
}

export interface GuestFrontierIdea {
  keyword: string
  avgMonthlySearches: number | null
  volumeLow: number | null
  volumeHigh: number | null
  volumeIsRange: boolean
}

export function selectGuestFrontierIdeas(input: {
  ideas: readonly GuestFrontierIdea[]
  alreadyKnown: Iterable<string>
  limit: number
}): string[] {
  const seen = new Set([...input.alreadyKnown].map((keyword) => normalizeFrontierKeyword(keyword)).filter(Boolean))
  const ranked = input.ideas
    .filter((idea) => isGuestFrontierKeyword(idea.keyword) && !volumeIsZero(idea))
    .map((idea) => ({ keyword: idea.keyword.replace(/\s+/g, ' ').trim(), volume: idea.avgMonthlySearches ?? idea.volumeHigh ?? 0 }))
    .sort((a, b) => b.volume - a.volume || a.keyword.localeCompare(b.keyword))
  const out: string[] = []
  for (const row of ranked) {
    const key = normalizeFrontierKeyword(row.keyword)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(row.keyword)
    if (out.length >= input.limit) break
  }
  return out
}

export interface GuestContactMethod {
  method: 'email' | 'form'
  value: string
  sourceUrl: string
}

export function guestContactMethod(
  pages: ReadonlyArray<{ url: string; text: string; html?: string | null }>,
): GuestContactMethod | null {
  const extracted = pages.flatMap((page) => extractContacts(page.url, page.text, page.html))
  const primary = pickPrimaryContact(extracted)
  if (primary?.email) return { method: 'email', value: primary.email, sourceUrl: primary.sourceUrl }
  for (const page of pages) {
    const email = publishedEmail(page.html) ?? publishedEmail(page.text)
    if (email) return { method: 'email', value: email, sourceUrl: page.url }
  }
  if (primary?.formUrl) return { method: 'form', value: primary.formUrl, sourceUrl: primary.sourceUrl }
  for (const page of pages) {
    const form = formTarget(page.url, page.html)
    if (form) return { method: 'form', value: form, sourceUrl: page.url }
  }
  return null
}

function keywordTokens(keyword: string): string[] {
  const normalized = normalizeFrontierKeyword(keyword)
  return normalized ? normalized.split(' ').filter(Boolean) : []
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function publishedEmail(source: string | null | undefined): string | null {
  if (!source) return null
  MAILTO.lastIndex = 0
  for (const match of source.matchAll(MAILTO)) {
    const email = match[1]?.toLowerCase()
    if (email && !NOREPLY.test(email)) return email
  }
  return null
}

function formTarget(pageUrl: string, html: string | null | undefined): string | null {
  if (!html) return null
  const action = html.match(/<form\b[^>]*\baction=["']([^"']+)["']/i)?.[1]
  if (action && !/^javascript:/i.test(action)) {
    const resolved = resolveUrl(action, pageUrl)
    if (resolved && isFormUrl(resolved)) return resolved
  }
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const resolved = resolveUrl(match[1] ?? '', pageUrl)
    if (resolved && isFormUrl(resolved)) return resolved
  }
  if (/<form\b/i.test(html) && isFormUrl(pageUrl)) return pageUrl
  return null
}

function isFormUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (FORM_HOST.test(parsed.hostname)) return true
    return FORM_PATH.test(parsed.pathname)
  } catch {
    return false
  }
}

function resolveUrl(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).href
  } catch {
    return null
  }
}
