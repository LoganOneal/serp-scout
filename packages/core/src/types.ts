/**
 * Shared vocabulary. Plain data only -- no classes, no methods, nothing that
 * needs a database or a network to exist. Everything in @rnr/core operates on
 * these, which is what makes the scoring model testable without IO and safe to
 * import from a browser bundle.
 */

// --- Geography ---------------------------------------------------------------

export type LocalityKind = 'city' | 'county' | 'metro'

/** DataForSEO location types we are willing to accept, per locality kind. */
export type ProviderLocationType =
  | 'City'
  | 'County'
  | 'DMA Region'
  | 'Region'
  | 'State'
  | 'Country'
  | 'Municipality'
  | 'Neighborhood'
  | (string & {})

export interface ProviderLocation {
  locationCode: number
  locationName: string
  locationType: ProviderLocationType
  countryIsoCode: string
}

export interface Locality {
  /** The ONLY natural key. (kind, state, name) is NOT unique -- two Wilmingtons in Illinois. */
  slug: string
  kind: LocalityKind
  /** Cleaned for display and for provider lookup: "Kenosha", not "Kenosha city". */
  name: string
  /** Exactly as Census published it. Kept for audit when a resolution looks wrong. */
  rawName: string
  stateCode: string
  stateName: string
  /** Place FIPS (city), county FIPS (county), or CBSA code (metro). */
  fips: string
  countyFips: string | null
  countyName: string | null
  population: number | null
  lat: number | null
  lon: number | null
  landAreaSqMi: number | null
  /** null = unresolved. An unresolved locality is EXCLUDED from scanning, never widened to a broader code. */
  providerLocationCode: number | null
  providerLocationName: string | null
  /** Which candidate form matched, for audit. */
  resolutionMethod: string | null
  unmatchedReason: string | null
}

// --- Niches ------------------------------------------------------------------

export interface Niche {
  slug: string
  label: string
  /** The searched noun phrase: "tree service" -> "kenosha tree service". */
  keywordNoun: string
  /** Concatenated for the EMD: "treeservice" -> kenoshatreeservice.com */
  emdToken: string
  /**
   * Substrings that mean "this domain is about this niche". Explicit rather
   * than stemmed, because morphology guessing gets this wrong in both
   * directions: `plumber` and `plumbing` share no whole word (so the stem must
   * be `plumb`), while a naive 4-char prefix of `heating` would also match
   * `heater`, `heath`, and `heathrow`. Curated per niche, checked as substrings
   * of the domain label.
   */
  domainStems: string[]
  category: string
  /** PRIOR. Monthly searches per 1,000 residents. See demand.ts. */
  demandPerCapitaPer1k: number
  /** PRIOR. Modelled monthly rent contribution per monthly search, in micros. */
  valuePerSearchMicros: bigint
  rentFloorMicros: bigint
  rentCeilingMicros: bigint
  /** PRIOR / calibrated avg job ticket for lead-sell economics (micros USD). */
  avgTicketMicros?: bigint | null
  /** Lead commission rate in basis points (1000 = 10%). */
  leadCommissionRateBps?: number | null
  /** What we charge for a sold lead (micros). */
  leadValueMicros?: bigint | null
  /** Google Ads measured national avg monthly searches for keyword noun. */
  gadsAvgMonthlySearches?: number | null
  gadsCompetitionIndex?: number | null
  active: boolean
}

// --- SERP --------------------------------------------------------------------

export interface SerpItem {
  /** 1-based rank among ORGANIC results only. */
  position: number
  /** Lowercased registrable domain, no www. */
  domain: string
  url: string
  title: string
  description: string | null
  /** Path is empty or "/". Distinguishes a homepage defender from a deep page. */
  isHomepage: boolean
  breadcrumb: string | null
}

export interface SerpSnapshot {
  keyword: string
  locationCode: number
  items: SerpItem[]
  fetchedAt: string
  source: 'live' | 'fixture' | 'cache'
}

export interface MapPackSnapshot {
  keyword: string
  locationCode: number
  /**
   * Whether Google returned a local pack at all. Combined with "is there any
   * local business in the top 10", this is how we detect a query that simply
   * is not local here -- a SERP that looks wide open on every structural
   * signal and is a guaranteed wasted build.
   */
  hasLocalPack: boolean
  entryCount: number
  domains: string[]
  fetchedAt: string
  source: 'live' | 'fixture' | 'cache'
}

// --- Link data ---------------------------------------------------------------

/**
 * Which of the three bulk endpoints actually answered for a given target.
 *
 * This exists because the three endpoints return DISJOINT field sets and are
 * called separately -- a target can have referring-domain data but no spam
 * score. Collapsing that into one boolean would erase the distinction between
 * "measured as low" and "not measured", and the 30-day verdict gate depends on
 * that distinction being real.
 */
export type AuthoritySource = 'ranks' | 'refdomains' | 'spam'

export interface DomainAuthority {
  /** Lowercased domain. The merge key across all three endpoints. */
  target: string
  /**
   * DataForSEO domain rank, 0-1000. From /backlinks/bulk_ranks/live, which
   * returns THIS AND NOTHING ELSE besides `target`. See backlinks.ts.
   */
  rank: number | null
  referringDomains: number | null
  referringDomainsNofollow: number | null
  /**
   * PREFERRED over referringDomains for every threshold and every component.
   * 400 referring domains that are 380 subdomains of one blog network is not
   * a 400-domain competitor.
   */
  referringMainDomains: number | null
  spamScore: number | null
  sources: AuthoritySource[]
}

/**
 * True only when we have a real link-count measurement. Used by the 30-day
 * gate, where absence of evidence must NOT read as evidence of weakness.
 */
export function hasLinkMeasurement(a: DomainAuthority | null | undefined): boolean {
  if (!a) return false
  return a.referringMainDomains !== null || a.referringDomains !== null
}

/** The count every threshold should use, falling back only within link data. */
export function refDomainCount(a: DomainAuthority | null | undefined): number | null {
  if (!a) return null
  return a.referringMainDomains ?? a.referringDomains ?? null
}

// --- Classification ----------------------------------------------------------

export type DomainClass =
  | 'platform_directory'
  | 'platform_marketplace'
  | 'platform_social'
  | 'platform_video'
  | 'forum'
  | 'media'
  | 'national_brand'
  | 'franchise_location'
  | 'franchise_homepage'
  | 'local_business'
  | 'government'
  | 'unknown'

export type PageType =
  | 'homepage'
  | 'city_page'
  | 'service_page'
  | 'listicle'
  | 'profile'
  | 'other'

export interface ClassifiedResult {
  item: SerpItem
  domainClass: DomainClass
  pageType: PageType
  /**
   * 0..1 -- how specifically this asset is built for {locality}+{niche}.
   * 0.95 = exact-match domain homepage. The generic-vs-exact-match split is
   * the single most decision-relevant thing on a local SERP and most models
   * collapse it.
   */
  dedication: number
  /** Ranks on generic domain power, not because it is defending this query. */
  isPlatform: boolean
  /** Exact-match: domain contains both the locality token and the niche token. */
  isExactMatch: boolean
  authority: DomainAuthority | null
}

// --- Difficulty --------------------------------------------------------------

export type ComponentName = 'authorityWall' | 'slotDefence' | 'intentLock' | 'linkQuality'

export interface ScoreComponent {
  /** 0..1, or null when UNMEASURED. Null is never coerced to 0. */
  value: number | null
  weight: number
  measured: boolean
  /** Human-readable reason, shown in the detail view for unmeasured components. */
  note: string | null
}

export interface DifficultyResult {
  /**
   * 0..100, or null when NOTHING could be measured. A null difficulty must
   * render as "--" and must never sort as easiest.
   */
  difficulty: number | null
  /** Fraction of total component weight that was actually measured, 0..1. */
  weightCovered: number
  components: Record<ComponentName, ScoreComponent>

  // Structural facts, surfaced separately because the EMD gates need them and
  // because the operator reads them directly.
  /** Slots held by platforms/directories -- real estate no local operator has claimed. */
  platformHeldSlots: number
  /** platformHeldSlots plus slots held by nothing local. Displayed as n/10. */
  slotsOpen: number
  medianNonPlatformRefDomains: number | null
  minNonPlatformRefDomains: number | null
  /** Refdomains of a non-platform result at position 1, if there is one and it was measured. */
  pos1NonPlatformRefDomains: number | null
  exactMatchHomepagesTop5: number
  localBusinessesTop5Dedicated: number
  hasLocalBusinessTop10: boolean
  /** True when at least one non-platform result had a link measurement. */
  linkDataMeasured: boolean
}

// --- EMD verdict -------------------------------------------------------------

export type Verdict = 'likely_30d' | 'likely_90d' | 'likely_6m' | 'not_winnable' | 'unknown'

export interface Blocker {
  code: string
  message: string
  /** The prior that produced this, e.g. "min refdomains top-5 >= 250". */
  threshold: string | null
}

export interface Gate {
  code: string
  label: string
  /** null = could not be evaluated. For the 30-day band, null fails the gate. */
  passed: boolean | null
  detail: string
}

export interface EmdAssessment {
  domain: string
  verdict: Verdict
  /** Every reason this is not a better band, named. Never an opaque score. */
  blockers: Blocker[]
  /** All six 30-day gates, pass or fail, for the audit view. */
  gates: Gate[]
}

// --- Modelled outputs --------------------------------------------------------

export interface DemandEstimate {
  monthlySearches: number
  /** Literal `true`, not `boolean`: this can never be constructed as unflagged. */
  estimated: true
  basis: string
}

export interface RentModel {
  rentMicros: bigint
  /** Literal `true`, same reason as DemandEstimate.estimated. */
  modelled: true
  basis: string
}

// --- Calibration -------------------------------------------------------------

export type BuildState = 'watching' | 'building' | 'ranking' | 'rented'

// --- Sites & CRM -------------------------------------------------------------

/**
 * A site's lifecycle.
 *
 * ==================== AUTHORITATIVE OVER BuildState ====================
 * `shortlist_items.state` (BuildState, above) is research-side bookkeeping and
 * predates this. Once a `sites` row exists it is the authority, and the shortlist
 * UI renders this instead of offering its own selector.
 *
 * Two state machines that both claim to describe the same asset diverge silently.
 * Creating a site sets the linked shortlist item to 'building' exactly once and
 * never touches it again -- a deliberate one-way sync, written down here because
 * a reader of either enum needs to know which one wins.
 * ======================================================================
 */
export type SiteStatus = 'parked' | 'building' | 'live' | 'rented' | 'dropped'

export const SITE_STATUSES: readonly SiteStatus[] = [
  'parked',
  'building',
  'live',
  'rented',
  'dropped',
]

/**
 * What kind of property this is, and therefore which models may run on it.
 *
 * ==================== A GATE, NOT A LABEL ====================
 * `local_lead_gen` is a (locality, niche) cell earning from phone calls.
 * `affiliate` is a directory site earning per referred purchase, spanning many
 * localities or none.
 *
 * The distinction is load-bearing because three models are correct for the first
 * and return confident, OPTIMISTIC nonsense for the second:
 *
 *   assessEmd / assessAcquiredDomain -- `not_a_local_query` fires on every
 *       affiliate keyword by construction, and reads as a hard negative verdict
 *       rather than "this model does not apply here".
 *   demand.ts -- models a number that is free to measure at national scope.
 *   PLATFORM_DOMAINS -- knows Yelp, not Booking.com, so the giants holding an
 *       affiliate SERP classify as beatable independent businesses.
 *
 * See `localModelsApply`, which is keyed on the keyword space's geoMode rather
 * than on this enum: the monetisation model and the geography model are separate
 * axes and a future site may cross them.
 * =============================================================
 */
export type SiteKind = 'local_lead_gen' | 'affiliate'

export const SITE_KINDS: readonly SiteKind[] = ['local_lead_gen', 'affiliate']

// --- Paid search -------------------------------------------------------------

/**
 * A paid-search plan's lifecycle.
 *
 * `validated` means Google's own validate-only mutate accepted it and applied
 * nothing — a real checkpoint, not a self-assessment. `launched` is the only
 * state that implies money can be spent, and nothing in this repo currently
 * produces it.
 */
export type AdsPlanStatus = 'draft' | 'validated' | 'launched' | 'abandoned'

export const ADS_PLAN_STATUSES: readonly AdsPlanStatus[] = [
  'draft',
  'validated',
  'launched',
  'abandoned',
]

/**
 * Google Ads keyword match type.
 *
 * EXACT is the default here and it is a deliberate choice, not an inherited
 * one: the break-even model is computed for a SPECIFIC query, with a specific
 * organic rank and therefore a specific incrementality band. BROAD match spends
 * that keyword's budget on queries whose rank we never measured, which silently
 * breaks the one coefficient the whole model is keyed on.
 */
export type AdsMatchType = 'EXACT' | 'PHRASE' | 'BROAD'

/** How far the Retell webhook sequence got. Not a call outcome. */
export type CallIngestState = 'started' | 'ended' | 'analyzed'

/** Where a lead came from. `form` is the site contact form, not yet built. */
export type LeadSource = 'call' | 'form'

/**
 * Which path produced a lead field.
 *
 * `tool` is the mid-call custom function and is AUTHORITATIVE. `analysis` is
 * Retell's post-call extraction and is backfill only -- it lands seconds late, it
 * produces nothing for an abandoned call, and it can disagree with what the agent
 * actually confirmed with the caller.
 */
export type LeadCapturedVia = 'tool' | 'analysis'

export type VoiceJobKind = 'fetch_recording' | 'deliver_lead' | 'backfill_call'

export type VoiceJobStatus = 'pending' | 'claimed' | 'done' | 'failed'

/**
 * What became of a lead.
 *
 * There is deliberately no 'unknown' member. Absence of a `lead_outcomes` row IS
 * "nobody has followed up" -- adding an explicit unknown would let a real disposition
 * column default to it, and then "not followed up" and "we looked and it went nowhere"
 * become the same value. Same reason `outcomes.position` is nullable while
 * `checked_at` is not: the row existing is the measurement.
 */
export type LeadDisposition =
  | 'booked'
  | 'quoted'
  | 'no_answer'
  | 'not_qualified'
  | 'spam'
  | 'duplicate'
  | 'lost'

export const LEAD_DISPOSITIONS: readonly LeadDisposition[] = [
  'booked',
  'quoted',
  'no_answer',
  'not_qualified',
  'spam',
  'duplicate',
  'lost',
]

/** Only these count as revenue. `quoted` is a maybe, not a sale. */
export const WON_DISPOSITIONS: readonly LeadDisposition[] = ['booked']

/**
 * Dispositions that mean "this was never a real lead".
 *
 * Excluded from the close-rate DENOMINATOR: spam and duplicates are not opportunities
 * you failed to convert, and leaving them in makes a good month look like a bad one.
 */
export const NON_OPPORTUNITY_DISPOSITIONS: readonly LeadDisposition[] = ['spam', 'duplicate']

export type DeliveryChannel = 'sms' | 'webhook'

/**
 * `suppressed` is not a failure.
 *
 * A simulated call must never text a real contractor, but recording the attempt as
 * 'failed' would put a red row in the reconciliation view for something that worked
 * exactly as designed -- and hide real failures among the noise.
 */
export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'suppressed'

export const OUTCOME_DAY_OFFSETS = [7, 14, 30, 60, 90] as const
export type OutcomeDayOffset = (typeof OUTCOME_DAY_OFFSETS)[number]

export interface OutcomeRow {
  shortlistItemId: number
  dayOffset: OutcomeDayOffset
  /** Always set. The row existing IS the measurement. */
  checkedAt: string
  /**
   * NULL means CHECKED AND NOWHERE -- a measurement, not a gap. Treating it as
   * missing data drops every failed build from the denominator and makes every
   * band look excellent.
   */
  position: number | null
  /** Frozen at save time, not joined live. See calibration.ts. */
  verdictAtSave: Verdict
  difficultyAtSave: number | null
}
