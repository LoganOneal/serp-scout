/**
 * Travel guest-post keyword selection.
 *
 * SERP discovery stays on explicit "write for us" / guest-post phrases.
 * New phrases come from Google Ads Keyword Ideas, the same GenerateKeywordIdeas
 * call the HHT engine uses, then this filter keeps only travel guest-post intent.
 */

import { normalizeFrontierKeyword, volumeIsZero } from '../hht-engine/keywords.js'

/** Page 10 of a Google SERP is 100 organic results. */
export const HHT_OPP_GUEST_SERP_DEPTH = 100

export const HHT_OPP_GUEST_SEED_KEYWORDS = [
  'travel write for us',
  'write for us travel',
  'travel blogs that accept guest posts',
  'family travel write for us',
  'travel guest post',
  'travel submit guest post',
  'luxury travel write for us',
  'adventure travel write for us',
  'honeymoon write for us',
  'hotel write for us',
  'travel blog guest post',
  'couples travel write for us',
  'wellness travel write for us',
  'romantic travel write for us',
  'travel magazine write for us',
  'solo travel write for us',
] as const

const GUEST_INTENT =
  /\b(write for us|guest posts?|guest posting|guest contributors?|guest contributions?|guest blogs?|submit(?: a)? guest|become a contributor)\b/i

const TRAVEL_INTENT =
  /\b(travel|travelling|traveling|hotel|hotels|honeymoon|tourism|getaway|hospitality|destination|vacation|backpack|cruise)\b/i

const EXPLICIT_CONTRIBUTION_PATH =
  /(?:^|\/)(?:write-for-us|write-for-me|write-for-our-blog|guest-?posts?|guest-?blogs?|submissions?|become-a-contributor|contributor-guidelines|writers?-guidelines|pitch-us|contribute)(?:\/|$|\.|-)/i

const ROUNDUP_PATH =
  /blogs?-that-accept|accept-guest-posts?|guest-posting-sites|sites-that-accept|list-of-(?:travel-)?(?:blogs|sites)|blogs-accepting-guest/i

export interface GuestKeywordIdea {
  keyword: string
  avgMonthlySearches: number | null
  volumeLow: number | null
  volumeHigh: number | null
  volumeIsRange: boolean
}

export function isTravelGuestPostKeyword(keyword: string): boolean {
  return GUEST_INTENT.test(keyword) && TRAVEL_INTENT.test(keyword)
}

export function isExplicitContributionUrl(url: string): boolean {
  return EXPLICIT_CONTRIBUTION_PATH.test(url)
}

export function isGuestRoundupUrl(url: string): boolean {
  if (isExplicitContributionUrl(url)) return false
  return ROUNDUP_PATH.test(url)
}

export function pickGuestPostIdeas(input: {
  ideas: GuestKeywordIdea[]
  alreadySearched: Iterable<string>
  limit: number
}): string[] {
  const seen = new Set([...input.alreadySearched].map((keyword) => normalizeFrontierKeyword(keyword)).filter(Boolean))
  const ranked = input.ideas
    .filter((idea) => isTravelGuestPostKeyword(idea.keyword))
    .filter((idea) => !volumeIsZero(idea))
    .map((idea) => ({
      keyword: idea.keyword.replace(/\s+/g, ' ').trim(),
      volume: idea.avgMonthlySearches ?? idea.volumeHigh ?? 0,
    }))
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
