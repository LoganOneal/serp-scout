import { parse } from 'tldts'

/**
 * Stage 2 — turn whatever a directory listing calls a "website" into a
 * registrable domain we could actually buy, or nothing at all.
 *
 * The unit of acquisition is the registrable domain (eTLD+1), not the host: you
 * cannot buy `www.joesplumbing.com` separately from `joesplumbing.com`, and a
 * business whose site is `joesplumbing.wixsite.com` has no domain to sell.
 */

/**
 * Hosts that are never an acquisition target, because the business does not own
 * the registrable domain — it rents a page inside someone else's.
 *
 * Two kinds are folded together deliberately:
 *   - directories and social profiles (yelp.com, facebook.com) — the listing is
 *     evidence the business existed, never a domain we could acquire;
 *   - free-subdomain site builders (wixsite.com, business.site) — the operator's
 *     "site" is a subdomain, and the parent is not for sale.
 *
 * Both collapse to the same eTLD+1 under a public-suffix parse, so one set
 * catches every business sitting on them.
 */
export const NON_ACQUIRABLE_HOSTS: ReadonlySet<string> = new Set([
  // Social
  'facebook.com',
  'fb.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'youtube.com',
  'pinterest.com',
  'nextdoor.com',
  // Directories / lead aggregators
  'yelp.com',
  'angi.com',
  'angieslist.com',
  'homeadvisor.com',
  'thumbtack.com',
  'porch.com',
  'houzz.com',
  'bbb.org',
  'yellowpages.com',
  'yp.com',
  'manta.com',
  'mapquest.com',
  'foursquare.com',
  'tripadvisor.com',
  // Link-in-bio
  'linktr.ee',
  'bio.link',
  'beacons.ai',
  // Free-subdomain site builders
  'business.site',
  'godaddysites.com',
  'wixsite.com',
  'wix.com',
  'weebly.com',
  'square.site',
  'squarespace.com',
  'sites.google.com',
  'google.com',
  'my-free.website',
  'webnode.com',
  'jimdosite.com',
  'wordpress.com',
  'blogspot.com',
  'tumblr.com',
  'shopify.com',
  'myshopify.com',
  'netlify.app',
  'vercel.app',
  'github.io',
  'herokuapp.com',
  'firebaseapp.com',
  'web.app',
  // National brands, retailers and reference sites. They rank for local
  // queries constantly and are never acquisition targets. Triage is free, so
  // these cost nothing to leave in -- they just waste ~20s each and clutter a
  // list an operator has to read.
  'wikipedia.org',
  'homedepot.com',
  'lowes.com',
  'amazon.com',
  'walmart.com',
  'reddit.com',
  'quora.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'craigslist.org',
  'usnews.com',
  'forbes.com',
  'nytimes.com',
  'servpro.com',
  'servicemaster.com',
  'rotorooter.com',
  'mrrooter.com',
  'benjaminfranklinplumbing.com',
  'energysage.com',
  'dumpsters.com',
  'consumeraffairs.com',
  'trustpilot.com',
  'expertise.com',
  'buildzoom.com',
  'networx.com',
  'homeguide.com',
  'thumbtack.com',
  'bark.com',
  // URL shorteners and QR redirectors. They appear as a business "website" on
  // map listings constantly and are never acquirable.
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'rebrand.ly',
  'linktr.ee',
  'lnk.bio',
  'qrco.de',
  'short.gy',
  'cutt.ly',
])

export interface NormalizedDomain {
  /** Registrable domain (eTLD+1), lowercased. */
  domain: string
  /** Host as given, minus scheme/path — kept so the row can be audited. */
  host: string
  /** True when the host sat on a platform we can never acquire. */
  nonAcquirable: boolean
}

/**
 * Extract the registrable domain from a website URL or bare host.
 *
 * Returns null for anything that is not a real registrable domain: IP
 * addresses, localhost, unknown TLDs, and garbage. Callers treat null as
 * "this listing has no domain", which is a different thing from "the domain is
 * dead" and must not be conflated with it.
 *
 * `allowPrivateDomains` stays OFF on purpose. With it on, `joe.wixsite.com`
 * parses to itself and would look like an acquirable domain; off, it collapses
 * to `wixsite.com` and gets caught by the platform set above.
 */
export function registrableDomain(input: string | null | undefined): NormalizedDomain | null {
  if (!input) return null
  const raw = input.trim()
  if (!raw) return null

  // tldts handles bare hosts, but a scheme-less "example.com/path" needs help.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(withScheme, { allowPrivateDomains: false })
  } catch {
    return null
  }

  const { domain, hostname, isIp } = parsed
  if (isIp) return null
  if (!domain || !hostname) return null

  const lower = domain.toLowerCase()
  return {
    domain: lower,
    host: hostname.toLowerCase(),
    nonAcquirable: NON_ACQUIRABLE_HOSTS.has(lower),
  }
}

export interface DomainOwner {
  /** Whatever the directory called this business. */
  name: string
  /** The website string the directory carried, before normalization. */
  website: string | null
  /**
   * Google identifiers, when the listing came from a map pack.
   *
   * These were being collected at 100% coverage and then dropped here, which
   * is why nothing downstream could ever link straight to a profile. A
   * place_id turns a guessed search into an exact link.
   */
  placeId?: string | null
  cid?: string | null
  address?: string | null
  phone?: string | null
  /**
   * ============ THE GBP FIELDS THAT WERE FETCHED AND THROWN AWAY ============
   * `collectBusinesses` reads `is_claimed`, `rating` and `votes_count` off every
   * map-pack listing, and every one was dropped here -- this function built its
   * owner record from six fields and silently discarded the rest.
   *
   * They are the whole of the Google Business Profile opportunity. Measured on
   * 979 Houston listings: 12.4% are UNCLAIMED and 41 of those carry 10+
   * reviews. An unclaimed profile with review history is an asset that ranks in
   * the map pack today, and the field identifying one was being deleted on
   * every run this project had ever done.
   * ========================================================================
   */
  isClaimed?: boolean | null
  rating?: number | null
  reviewCount?: number | null
}

export interface DedupedDomain {
  domain: string
  /**
   * Every business that pointed at this domain.
   *
   * More than one is a signal, not noise: it means either a roll-up (one owner,
   * several listings) or a shared agency template across independent
   * businesses. Both change what the domain is worth, so the count is kept
   * rather than collapsed away.
   */
  businesses: DomainOwner[]
}

/**
 * Collapse a list of businesses to unique acquirable domains.
 *
 * Platform hosts and unparseable websites are dropped here — they are counted
 * by the caller for reporting, but they never reach the triage stages, which
 * are the ones that cost time and money.
 */
export function dedupeDomains(
  businesses: Array<DomainOwner>,
): { domains: DedupedDomain[]; skippedPlatform: number; skippedNoDomain: number } {
  const byDomain = new Map<string, DomainOwner[]>()
  let skippedPlatform = 0
  let skippedNoDomain = 0

  for (const b of businesses) {
    const n = registrableDomain(b.website)
    if (!n) {
      skippedNoDomain += 1
      continue
    }
    if (n.nonAcquirable) {
      skippedPlatform += 1
      continue
    }
    const owner: DomainOwner = {
      name: b.name,
      website: b.website,
      placeId: b.placeId ?? null,
      cid: b.cid ?? null,
      address: b.address ?? null,
      phone: b.phone ?? null,
      isClaimed: b.isClaimed ?? null,
      rating: b.rating ?? null,
      reviewCount: b.reviewCount ?? null,
    }
    const owners = byDomain.get(n.domain)
    if (owners) owners.push(owner)
    else byDomain.set(n.domain, [owner])
  }

  const domains = [...byDomain.entries()]
    .map(([domain, owners]) => ({ domain, businesses: owners }))
    .sort((a, b) => a.domain.localeCompare(b.domain))

  return { domains, skippedPlatform, skippedNoDomain }
}
