import type { DomainClass } from '../types.js'

/**
 * Domains that rank on generic domain power rather than by defending a specific
 * local query. Membership here routes a result to PLATFORM_AUTHORITY_CONSTANT
 * instead of its real link profile -- see priors.ts for the full argument.
 *
 * Matching is by suffix, so `m.yelp.com` and `biz.yelp.com` both hit `yelp.com`.
 *
 * This list is necessarily incomplete and that is a known, bounded weakness: a
 * missing platform is read as a local business, which makes a SERP look HARDER
 * than it is. That is the safe direction to be wrong in -- it costs the operator
 * a missed opportunity, not a wasted domain purchase. Adding to this list can
 * only ever make markets look easier, so additions deserve more scrutiny than
 * omissions.
 */
export const PLATFORM_DOMAINS: Record<string, DomainClass> = {
  // --- Local directories / lead-gen marketplaces ---------------------------
  'yelp.com': 'platform_directory',
  'angi.com': 'platform_directory',
  'angieslist.com': 'platform_directory',
  'homeadvisor.com': 'platform_directory',
  'thumbtack.com': 'platform_directory',
  'bbb.org': 'platform_directory',
  'yellowpages.com': 'platform_directory',
  'superpages.com': 'platform_directory',
  'whitepages.com': 'platform_directory',
  'dexknows.com': 'platform_directory',
  'manta.com': 'platform_directory',
  'chamberofcommerce.com': 'platform_directory',
  'houzz.com': 'platform_directory',
  'porch.com': 'platform_directory',
  'buildzoom.com': 'platform_directory',
  'expertise.com': 'platform_directory',
  'threebestrated.com': 'platform_directory',
  'three-best-rated.com': 'platform_directory',
  'bark.com': 'platform_directory',
  'networx.com': 'platform_directory',
  'mapquest.com': 'platform_directory',
  'foursquare.com': 'platform_directory',
  'citysearch.com': 'platform_directory',
  'local.com': 'platform_directory',
  'hotfrog.com': 'platform_directory',
  'brownbook.net': 'platform_directory',
  'cylex.us.com': 'platform_directory',
  'merchantcircle.com': 'platform_directory',
  'alignable.com': 'platform_directory',
  'ezlocal.com': 'platform_directory',
  'opendi.us': 'platform_directory',
  'bizapedia.com': 'platform_directory',
  'trustpilot.com': 'platform_directory',
  'birdeye.com': 'platform_directory',
  'sitejabber.com': 'platform_directory',
  'tripadvisor.com': 'platform_directory',
  'nicelocal.com': 'platform_directory',
  'bizhwy.com': 'platform_directory',
  'findglocal.com': 'platform_directory',
  'yellowbook.com': 'platform_directory',
  'insiderpages.com': 'platform_directory',
  'kudzu.com': 'platform_directory',
  'judysbook.com': 'platform_directory',
  'homeguide.com': 'platform_directory',
  'nextdoor.com': 'platform_directory',
  'care.com': 'platform_directory',
  'rover.com': 'platform_directory',
  'indeed.com': 'platform_directory',
  'glassdoor.com': 'platform_directory',
  'ziprecruiter.com': 'platform_directory',

  // --- Retail / marketplace ------------------------------------------------
  'amazon.com': 'platform_marketplace',
  'ebay.com': 'platform_marketplace',
  'homedepot.com': 'platform_marketplace',
  'lowes.com': 'platform_marketplace',
  'walmart.com': 'platform_marketplace',
  'menards.com': 'platform_marketplace',
  'acehardware.com': 'platform_marketplace',
  'etsy.com': 'platform_marketplace',
  'craigslist.org': 'platform_marketplace',
  'offerup.com': 'platform_marketplace',

  // --- Social --------------------------------------------------------------
  'facebook.com': 'platform_social',
  'instagram.com': 'platform_social',
  'linkedin.com': 'platform_social',
  'twitter.com': 'platform_social',
  'x.com': 'platform_social',
  'pinterest.com': 'platform_social',
  'tiktok.com': 'platform_social',
  'threads.net': 'platform_social',

  // --- Video ---------------------------------------------------------------
  'youtube.com': 'platform_video',
  'vimeo.com': 'platform_video',
  'dailymotion.com': 'platform_video',

  // --- Forums --------------------------------------------------------------
  'reddit.com': 'forum',
  'quora.com': 'forum',
  'stackexchange.com': 'forum',
  'city-data.com': 'forum',
  'diychatroom.com': 'forum',
  'contractortalk.com': 'forum',
  'houzz.co.uk': 'forum',

  // --- Reference / media / cost-guide content -----------------------------
  // These hold slots on local service SERPs constantly ("How much does tree
  // removal cost in Wisconsin?") and are not local defenders either.
  'wikipedia.org': 'media',
  'wikihow.com': 'media',
  'forbes.com': 'media',
  'nytimes.com': 'media',
  'usnews.com': 'media',
  'bobvila.com': 'media',
  'thisoldhouse.com': 'media',
  'familyhandyman.com': 'media',
  'fixr.com': 'media',
  'homewyse.com': 'media',
  'hgtv.com': 'media',
  'architecturaldigest.com': 'media',
  'consumeraffairs.com': 'media',
  'zillow.com': 'media',
  'realtor.com': 'media',
  'redfin.com': 'media',
  'trulia.com': 'media',
  'apartments.com': 'media',
  'niche.com': 'media',
  'areavibes.com': 'media',
  'neighborhoodscout.com': 'media',
}

/**
 * National franchise brands. A franchise gets a HIGHER defence score than a
 * platform (0.55 location page / 0.65 homepage) because there is a real
 * marketing budget behind the query -- but lower than an exact-match local
 * operator, because the page is templated and the brand is not fighting for
 * this one city specifically.
 */
export const FRANCHISE_DOMAINS = new Set([
  'rotorooter.com',
  'mrrooter.com',
  'benjaminfranklinplumbing.com',
  'arsrescuerooter.com',
  'rescuerooter.com',
  'servicemaster.com',
  'servicemasterrestore.com',
  'servpro.com',
  'rainbowintl.com',
  'pauldavis.com',
  'mollymaid.com',
  'chemdry.com',
  'stanleysteemer.com',
  'zerorez.com',
  'terminix.com',
  'orkin.com',
  'rentokil.com',
  'trugreen.com',
  'aptive.com',
  'mosquitojoe.com',
  'precisiongaragedoor.com',
  'overheaddoor.com',
  'clopaydoor.com',
  '1800gotjunk.com',
  'junk-king.com',
  'collegehunkshaulingjunk.com',
  'twomenandatruck.com',
  'pods.com',
  'uhaul.com',
  'mrhandyman.com',
  'aireserv.com',
  'onehourheatandair.com',
  'mrelectric.com',
  'mrappliance.com',
  'wingsupply.com',
  'thegroutmedic.com',
  'budgetblinds.com',
  'closetsbydesign.com',
  'renewalbyandersen.com',
  'championwindow.com',
  'leaffilter.com',
  'lawndoctor.com',
  'weedman.com',
  'safelite.com',
  'midas.com',
  'jiffylube.com',
  'valvoline.com',
  'aamco.com',
  'meineke.com',
  'firestonecompleteautocare.com',
  'discounttire.com',
  'lesschwab.com',
])

/** Non-franchise national brands / manufacturers that show up as slot-holders. */
export const NATIONAL_BRAND_DOMAINS = new Set([
  'carrier.com',
  'trane.com',
  'lennox.com',
  'rheem.com',
  'goodmanmfg.com',
  'americanstandardair.com',
  'kohler.com',
  'moen.com',
  'gafroofing.com',
  'owenscorning.com',
  'certainteed.com',
  'jameshardie.com',
  'andersenwindows.com',
  'pella.com',
  'generac.com',
  'sunrun.com',
  'tesla.com',
])

const MULTIPART_SUFFIXES = ['co.uk', 'com.au', 'us.com', 'co.nz', 'com.br']

/** Lowercase, strip a leading `www.`, drop any port or trailing dot. */
export function normaliseDomain(raw: string): string {
  let d = raw.trim().toLowerCase()
  d = d.replace(/^https?:\/\//, '')
  d = d.split('/')[0] ?? d
  d = d.split(':')[0] ?? d
  d = d.replace(/\.$/, '')
  d = d.replace(/^www\./, '')
  return d
}

/** True when `domain` is, or is a subdomain of, `platform`. */
export function domainMatches(domain: string, platform: string): boolean {
  return domain === platform || domain.endsWith(`.${platform}`)
}

/**
 * The label part of a domain, with punctuation removed, for token matching:
 * `kenosha-tree-service.com` -> `kenoshatreeservice`.
 */
export function domainLabel(domain: string): string {
  let host = domain
  for (const suffix of MULTIPART_SUFFIXES) {
    if (host.endsWith(`.${suffix}`)) {
      host = host.slice(0, -(suffix.length + 1))
      return host.replace(/[^a-z0-9]/g, '')
    }
  }
  const parts = host.split('.')
  // Drop the TLD only. Keep any subdomain labels: `kenosha.treeservice.com`
  // still reads as an exact match, and dropping them would hide that.
  const withoutTld = parts.length > 1 ? parts.slice(0, -1) : parts
  return withoutTld.join('').replace(/[^a-z0-9]/g, '')
}

export function lookupPlatform(domain: string): DomainClass | null {
  for (const [platform, cls] of Object.entries(PLATFORM_DOMAINS)) {
    if (domainMatches(domain, platform)) return cls
  }
  return null
}

export function isFranchise(domain: string): boolean {
  for (const f of FRANCHISE_DOMAINS) if (domainMatches(domain, f)) return true
  return false
}

export function isNationalBrand(domain: string): boolean {
  for (const b of NATIONAL_BRAND_DOMAINS) if (domainMatches(domain, b)) return true
  return false
}

export function isGovernment(domain: string): boolean {
  return (
    domain.endsWith('.gov') ||
    domain.endsWith('.mil') ||
    /\.(?:[a-z]{2})\.us$/.test(domain) ||
    domain.endsWith('.state.us')
  )
}

/** True for any class that ranks on generic domain power, not query defence. */
export function isPlatformClass(cls: DomainClass): boolean {
  return (
    cls === 'platform_directory' ||
    cls === 'platform_marketplace' ||
    cls === 'platform_social' ||
    cls === 'platform_video' ||
    cls === 'forum' ||
    cls === 'media'
  )
}
