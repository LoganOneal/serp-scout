/**
 * Domains that can never be a guest-post prospect.
 *
 * ==================== A HAND-WRITTEN FILTER GOT THIS WRONG BEFORE ==========
 * `probe-wayback-directory` reported FIFTEEN "business websites" on a BBB page.
 * All fifteen were adtech and platform infrastructure — `doubleclick`,
 * `demdex`, `newrelic`, `bbbpromos.org`. A hand-rolled regex was doing work the
 * real normaliser should do (plan-step0-experiment.md §1.1).
 *
 * So this reuses `NON_ACQUIRABLE_HOSTS` and `INFRASTRUCTURE_HOSTS` rather than
 * restating them, and adds only what is specific to link prospecting: hosts
 * nobody guest-posts on.
 * =========================================================================
 */

import { INFRASTRUCTURE_HOSTS } from '../domains/infrastructure.js'
import { NON_ACQUIRABLE_HOSTS } from '../domains/normalize.js'

/**
 * Real, popular sites that are simply not outreach targets — you cannot email
 * Wikipedia and ask for a guest post.
 *
 * Deliberately separate from the two imported sets, which mean different
 * things: `NON_ACQUIRABLE_HOSTS` is "the business rents a page here",
 * `INFRASTRUCTURE_HOSTS` is "not a business at all". This one is "a real site
 * that does not sell or accept placements".
 */
export const NON_PROSPECT_HOSTS: ReadonlySet<string> = new Set([
  // Encyclopaedic / UGC — no editorial contact for this
  'wikipedia.org',
  'wikimedia.org',
  'wikidata.org',
  'fandom.com',
  'reddit.com',
  'quora.com',
  'stackexchange.com',
  'stackoverflow.com',
  'medium.com',
  'substack.com',
  'blogspot.com',
  'wordpress.com',
  'tumblr.com',
  // Social and video
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'pinterest.com',
  'tiktok.com',
  'youtube.com',
  'vimeo.com',
  'threads.net',
  // Marketplaces and platforms
  'amazon.com',
  'ebay.com',
  'etsy.com',
  'walmart.com',
  'booking.com',
  'expedia.com',
  'tripadvisor.com',
  'hotels.com',
  'agoda.com',
  'airbnb.com',
  'vrbo.com',
  // Government, education, standards — outreach is not the mechanism
  'europa.eu',
  'who.int',
  'nih.gov',
  'fda.gov',
  // News wires and aggregators that syndicate rather than commission
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'einpresswire.com',
  'issuu.com',
  'scribd.com',
  'slideshare.net',
])

export interface ExclusionResult {
  excluded: boolean
  /** Which set caught it, so a surprising exclusion is explainable. */
  reason: string | null
}

/**
 * Suffix-matched, so `m.reddit.com` and `en.wikipedia.org` are caught by their
 * registrable domain. Same matching convention as `domainMatches` in
 * platforms.ts.
 */
export function isExcludedProspect(
  domain: string,
  opts: { ownDomains?: Iterable<string>; competitorDomains?: Iterable<string> } = {},
): ExclusionResult {
  const d = domain.trim().toLowerCase().replace(/^www\./, '')
  if (!d) return { excluded: true, reason: 'empty domain' }

  for (const own of opts.ownDomains ?? []) {
    if (matches(d, own)) return { excluded: true, reason: 'one of our own sites' }
  }
  /**
   * The competitors are excluded too. Obvious once stated and easy to miss:
   * stage ① mines a competitor's referring domains, and competitors link to
   * each other.
   */
  for (const c of opts.competitorDomains ?? []) {
    if (matches(d, c)) return { excluded: true, reason: 'a competitor we mined' }
  }

  for (const host of NON_PROSPECT_HOSTS) {
    if (matches(d, host)) return { excluded: true, reason: `not an outreach target (${host})` }
  }
  for (const host of INFRASTRUCTURE_HOSTS) {
    if (matches(d, host)) return { excluded: true, reason: `infrastructure, not a business (${host})` }
  }
  for (const host of NON_ACQUIRABLE_HOSTS) {
    if (matches(d, host)) return { excluded: true, reason: `a page rented on a platform (${host})` }
  }

  /**
   * Country-code government and academic suffixes. Not in any host list because
   * they are a shape, not a name — and a `.gov` guest post is not a thing.
   */
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(d) || /\.ac\.[a-z]{2}$/.test(d) || d.endsWith('.edu')) {
    return { excluded: true, reason: 'government or academic domain' }
  }

  return { excluded: false, reason: null }
}

function matches(domain: string, host: string): boolean {
  const h = host.trim().toLowerCase()
  return domain === h || domain.endsWith(`.${h}`)
}
