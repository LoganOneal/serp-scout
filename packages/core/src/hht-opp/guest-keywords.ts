/**
 * Travel guest-post keyword selection.
 *
 * The default frontier finds publications through topical travel SERPs.
 * Explicit contribution helpers below are retained for legacy URL research.
 */

import { selectGuestFrontierIdeas } from './guest-frontier.js'

/** Page 10 of a Google SERP is 100 organic results. */
export const HHT_OPP_GUEST_SERP_DEPTH = 100

export const HHT_OPP_GUEST_SEED_KEYWORDS = [
  'packing list for ecuador',
  'packing list for argentina',
  'packing list for chile',
  'packing list for a spa weekend',
  'packing list for a cabin getaway',
  'packing list for a honeymoon',
  'packing list for a couples getaway',
  'staycation ideas for married couples',
  'romantic staycation ideas at home',
  'anniversary staycation ideas for couples',
  'luxury staycation ideas for couples',
  'weekend staycation ideas for couples',
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
  return selectGuestFrontierIdeas({
    ideas: input.ideas,
    alreadyKnown: input.alreadySearched,
    limit: input.limit,
  })
}
