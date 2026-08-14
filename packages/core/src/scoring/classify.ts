import type { ClassifiedResult, DomainAuthority, DomainClass, PageType, SerpItem } from '../types.js'
import {
  DEDICATION_DEDICATED_PAGE,
  DEDICATION_EXACT_MATCH_DOMAIN,
  DEDICATION_GENERIC_LOCAL,
  DEDICATION_PARTIAL_MATCH_DOMAIN,
  DEDICATION_PLATFORM,
} from './priors.js'
import {
  domainLabel,
  isFranchise,
  isGovernment,
  isNationalBrand,
  isPlatformClass,
  lookupPlatform,
  normaliseDomain,
} from './platforms.js'

/**
 * Everything needed to decide whether a result is "about" this locality and
 * this niche. Derived once per (locality, niche) cell.
 */
export interface MatchContext {
  /** Locality name reduced to a domain-comparable token: `kenosha`. */
  localityToken: string
  /**
   * Additional accepted forms -- multi-word localities also match on their
   * distinctive word, since `sanbuenaventuraplumbing.com` is rare but
   * `venturaplumbing.com` is not.
   */
  localityAliases: string[]
  /** `treeservice` */
  nicheToken: string
  /** Curated substrings from Niche.domainStems: `['tree']`, `['plumb']`. */
  nicheStems: string[]
  /**
   * Slot holders specific to this keyword space, consulted before the global
   * list. Undefined on every local-services call, which is why their behaviour
   * is byte-identical to before this existed.
   *
   * Without it, an affiliate SERP held by `booking.com` and `expedia.com`
   * classifies both as `local_business` — the most optimistic error available,
   * on the heaviest-weighted component of the difficulty model.
   */
  extraPlatforms?: Readonly<Record<string, DomainClass>> | undefined
}

export function buildMatchContext(args: {
  localityName: string
  nicheEmdToken: string
  nicheDomainStems: string[]
  extraPlatforms?: Readonly<Record<string, DomainClass>> | undefined
}): MatchContext {
  const token = tokenise(args.localityName)
  const words = args.localityName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !LOCALITY_STOPWORDS.has(w))
  const aliases = new Set<string>([token])
  // The last word is usually the distinctive one ("Ventura", "Beach" excepted
  // by the stopword list; "Saint Paul" -> "paul" is a real domain pattern).
  for (const w of words) aliases.add(w)
  return {
    localityToken: token,
    localityAliases: [...aliases].filter(Boolean),
    nicheToken: tokenise(args.nicheEmdToken),
    nicheStems: args.nicheDomainStems.map(tokenise).filter(Boolean),
    extraPlatforms: args.extraPlatforms,
  }
}

const LOCALITY_STOPWORDS = new Set([
  'city',
  'town',
  'village',
  'saint',
  'north',
  'south',
  'east',
  'west',
  'lake',
  'beach',
  'park',
  'heights',
  'falls',
  'springs',
  'grove',
  'mount',
  'fort',
  'port',
  'new',
])

export function tokenise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function domainHasLocality(label: string, ctx: MatchContext): boolean {
  return ctx.localityAliases.some((a) => a.length >= 4 && label.includes(a))
}

export function domainHasNiche(label: string, ctx: MatchContext): boolean {
  if (ctx.nicheToken.length >= 4 && label.includes(ctx.nicheToken)) return true
  return ctx.nicheStems.some((s) => s.length >= 3 && label.includes(s))
}

// ---------------------------------------------------------------------------

/** Words in a title that mark an aggregation/listicle page rather than a business. */
const LISTICLE_PATTERNS: RegExp[] = [
  /\b(?:top|best)\s+\d+\b/i,
  /\b\d+\s+(?:best|top|greatest)\b/i,
  /\bbest\s+\w+(?:\s+\w+)?\s+(?:in|near)\b/i,
  /\b(?:reviews?|ratings?)\s+(?:of|for)\b/i,
  /\bcompare\s+\w+\s+(?:quotes|prices|costs)\b/i,
  /\bhow much does\b/i,
  /\bcost\s+(?:guide|calculator)\b/i,
]

function classifyPageType(item: SerpItem, ctx: MatchContext, isPlatform: boolean): PageType {
  if (LISTICLE_PATTERNS.some((re) => re.test(item.title))) return 'listicle'
  if (item.isHomepage) return 'homepage'

  const path = pathOf(item.url)
  const pathToken = tokenise(path)

  if (isPlatform) {
    // yelp.com/biz/..., facebook.com/pages/..., bbb.org/us/wi/kenosha/profile/...
    if (/\/(?:biz|profile|pages|company|listing|business)\b/.test(path)) return 'profile'
  }

  const hasLocality = domainHasLocality(pathToken, ctx)
  const hasNiche = domainHasNiche(pathToken, ctx)
  if (hasLocality && hasNiche) return 'city_page'
  if (hasLocality) return 'city_page'
  if (hasNiche) return 'service_page'
  return 'other'
}

function pathOf(url: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(url)
  return m?.[1] ?? '/'
}

function classifyDomain(domain: string, item: SerpItem, ctx: MatchContext): DomainClass {
  const platform = lookupPlatform(domain, ctx.extraPlatforms)
  if (platform) return platform
  if (isGovernment(domain)) return 'government'
  if (isFranchise(domain)) {
    return item.isHomepage ? 'franchise_homepage' : 'franchise_location'
  }
  if (isNationalBrand(domain)) return 'national_brand'

  const label = domainLabel(domain)
  if (!label) return 'unknown'

  // Everything left on a local service SERP is treated as a local business.
  //
  // WHY this default rather than `unknown`: on "kenosha tree service", an
  // unrecognised small .com is overwhelmingly a local operator. Defaulting to
  // `unknown` (defence 0.5) would understate real defenders and make markets
  // look easier than they are -- wrong in the direction that costs money.
  // `unknown` is reserved for domains we genuinely cannot parse.
  return 'local_business'
}

/**
 * How specifically this asset is built for {locality}+{niche}, 0..1.
 * The exact-match vs generic split here is the most decision-relevant signal on
 * the page, and most difficulty models collapse it.
 */
function computeDedication(args: {
  domainClass: DomainClass
  pageType: PageType
  hasLocality: boolean
  hasNiche: boolean
}): number {
  const { domainClass, pageType, hasLocality, hasNiche } = args
  if (isPlatformClass(domainClass)) return DEDICATION_PLATFORM
  if (hasLocality && hasNiche) return DEDICATION_EXACT_MATCH_DOMAIN
  if (hasLocality || hasNiche) return DEDICATION_PARTIAL_MATCH_DOMAIN
  if (pageType === 'city_page') return DEDICATION_DEDICATED_PAGE
  return DEDICATION_GENERIC_LOCAL
}

export function classifyResult(
  item: SerpItem,
  ctx: MatchContext,
  authority: DomainAuthority | null,
): ClassifiedResult {
  const domain = normaliseDomain(item.domain)
  const label = domainLabel(domain)
  const domainClass = classifyDomain(domain, item, ctx)
  const platform = isPlatformClass(domainClass)
  const pageType = classifyPageType(item, ctx, platform)

  const hasLocality = !platform && domainHasLocality(label, ctx)
  const hasNiche = !platform && domainHasNiche(label, ctx)
  const isExactMatch = hasLocality && hasNiche

  return {
    item: { ...item, domain },
    domainClass,
    pageType,
    dedication: computeDedication({ domainClass, pageType, hasLocality, hasNiche }),
    isPlatform: platform,
    isExactMatch,
    authority,
  }
}

/**
 * The key into SLOT_DEFENCE. Local businesses split on exact-match vs generic,
 * which is why this is a function rather than a direct DomainClass lookup.
 */
export function slotDefenceKey(r: ClassifiedResult): string {
  if (r.domainClass === 'local_business') {
    return r.isExactMatch && r.item.isHomepage
      ? 'local_business_exact_match'
      : 'local_business_generic'
  }
  return r.domainClass
}
