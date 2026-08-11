/**
 * EVERY tunable constant in the scoring model, in one file, each annotated with
 * where it came from.
 *
 * Read this first: none of these were measured on this operator's builds. They
 * are lifted from published research and from structural reasoning about local
 * SERPs. They are PRIORS AWAITING CALIBRATION. The `outcomes` table and
 * calibration.ts exist to replace them with measurements; until then, the
 * 30-day verdict is a claim about a model, not a claim about the world, and the
 * UI says so on screen.
 *
 * When calibration data arrives, change numbers HERE and nowhere else.
 */

// ---------------------------------------------------------------------------
// CTR curve
// ---------------------------------------------------------------------------

/**
 * PRIOR. Projected organic click share by position, 1-10.
 *
 * Source: composite of published Google organic CTR studies (Advanced Web
 * Ranking / Sistrix aggregate shape). Borrowed FROM Moz's Keyword Difficulty,
 * which weights page authority by projected CTR -- the one part of Moz KD worth
 * stealing.
 *
 * WHY NOT 1/position or 1/sqrt(position): both understate how brutally
 * front-loaded real click distribution is. Position 1 takes ~2x position 2 and
 * ~15x position 10. A competitor at #1 and a competitor at #10 are not "10x"
 * apart in how much they matter -- and for a rank-and-rent build, what matters
 * is the traffic actually defended, not the ordinal.
 */
export const CTR_CURVE = [
  0.276, 0.151, 0.1, 0.07, 0.052, 0.04, 0.031, 0.025, 0.021, 0.018,
] as const

// ---------------------------------------------------------------------------
// Component weights
// ---------------------------------------------------------------------------

/**
 * PRIOR. Difficulty component weights. Must sum to 1.
 *
 * Unmeasured components are OMITTED and these renormalise over what remains.
 * They are never defaulted to zero -- see difficulty.ts.
 */
export const COMPONENT_WEIGHTS = {
  /** CTR-weighted link strength of the actual defenders. */
  authorityWall: 0.4,
  /** What KIND of result holds each slot. The thing no commercial KD models. */
  slotDefence: 0.3,
  /** Has anyone built a city+niche-dedicated asset here at all? */
  intentLock: 0.15,
  /** Dofollow ratio + spam score of the top-5 non-platform defenders. */
  linkQuality: 0.15,
} as const

// ---------------------------------------------------------------------------
// The platform authority discount -- the single most important constant here
// ---------------------------------------------------------------------------

/**
 * PRIOR. Authority contributed by a platform domain, on the same 0..1 scale as
 * a real defender's normalised link strength.
 *
 * ===================== READ THIS BEFORE "FIXING" IT ======================
 * This deliberately IGNORES the platform's real link profile. Yelp has ~4M
 * referring domains. Facebook has more. Fed through the same log curve as a
 * local plumber, either one scores ~1.0 and single-handedly walls off the SERP.
 *
 * That is the wrong reading, and it is wrong in the most expensive possible
 * direction. A Yelp "Best Plumbers in Kenosha" page at #2 is ranking on
 * generic domain power applied to a templated aggregation page. Nobody at Yelp
 * is defending the query "kenosha plumber". No one is building links to that
 * URL, refreshing its content, or watching its rankings. For a local operator
 * with a dedicated site, that slot is the EASIEST thing on the page to take.
 *
 * Without this discount, every directory-stuffed SERP -- which is to say every
 * genuinely winnable market, which is to say the entire reason this tool
 * exists -- scores as unwinnable. The tool then systematically rejects exactly
 * what it was built to find, and does so while looking perfectly calibrated,
 * because the arithmetic is all correct. It is the input that is wrong.
 *
 * 0.12 is low but nonzero: a directory page does occupy the slot and does
 * absorb some clicks, so taking it is not free.
 * ========================================================================
 */
export const PLATFORM_AUTHORITY_CONSTANT = 0.12

/**
 * PRIOR. The intentLock floor multiplier for a result at position 10.
 *
 * An exact-match operator at #1 has locked the query's intent; the identical
 * domain sitting at #9 has not. The floor keeps a bottom-of-page exact match
 * from reading as harmless (it is still evidence somebody is building here)
 * without letting it read as a wall.
 */
export const INTENT_LOCK_POSITION_FLOOR = 0.2

/**
 * PRIOR. Referring-main-domain count at which a defender counts as fully
 * walled (normalised authority 1.0). Log-scaled below that.
 *
 * Source: shape borrowed from Ahrefs KD (referring domains to top 10, log
 * scale). The CEILING is set for local service SERPs specifically -- 500
 * referring main domains is an extremely well-linked local business. Ahrefs
 * uses a national-scale ceiling, which is why it reads local SERPs so badly.
 */
export const AUTHORITY_SATURATION_REF_DOMAINS = 500

/**
 * PRIOR. Minimum share of the page's total CTR weight that must be evaluable
 * before `authorityWall` counts as measured at all.
 *
 * WHY THIS EXISTS (found by test, and it was a live bug): platform results
 * contribute a KNOWN constant, so they are always "evaluable". On a SERP where
 * five real operators hold positions 1-5 and five directories hold 6-10, losing
 * the operators' link data still leaves the five directories -- and the
 * component would happily report itself measured, with a value of ~0.12,
 * because 0.12 is all that remained to average. A page walled by five
 * exact-match operators with hundreds of referring domains would score as
 * having almost no authority defending it.
 *
 * The five directories represent only ~17% of the page's click weight. Below
 * this threshold the component is not a weak reading of the defenders, it is
 * no reading of them, and it must say so.
 */
export const AUTHORITY_WALL_MIN_CTR_COVERAGE = 0.5

// ---------------------------------------------------------------------------
// Slot defence table
// ---------------------------------------------------------------------------

/**
 * PRIOR. How hard each kind of slot-holder is to displace, 0..1.
 *
 * The generic-vs-exact-match split at the bottom is the important part and
 * most models collapse it. `kenoshatreeservice.com` at #1 is a committed
 * operator who will notice you and respond. `bobsyardwork.com` at #1 ranking
 * for "kenosha tree service" is not defending that query on purpose.
 */
export const SLOT_DEFENCE: Record<string, number> = {
  platform_directory: 0.15,
  platform_marketplace: 0.15,
  platform_social: 0.2,
  platform_video: 0.2,
  forum: 0.25,
  media: 0.3,
  national_brand: 0.3,
  franchise_location: 0.55,
  franchise_homepage: 0.65,
  /** Local business on a generic domain. Real, but not query-dedicated. */
  local_business_generic: 0.6,
  /** Local business on an exact-match domain. The hardest realistic defender. */
  local_business_exact_match: 0.95,
  /** Municipal pages effectively cannot be displaced, but rarely hold slot 1-3. */
  government: 0.9,
  /** Unknown is NOT treated as easy. Mid-range, and flagged. */
  unknown: 0.5,
}

// ---------------------------------------------------------------------------
// Dedication -- how purpose-built an asset is for {locality}+{niche}
// ---------------------------------------------------------------------------

/** PRIOR. Domain contains both the locality token and the niche token. */
export const DEDICATION_EXACT_MATCH_DOMAIN = 0.95
/** PRIOR. Domain contains the niche token but not the locality (or vice versa). */
export const DEDICATION_PARTIAL_MATCH_DOMAIN = 0.75
/** PRIOR. Generic domain, but a page built specifically for city+niche. */
export const DEDICATION_DEDICATED_PAGE = 0.6
/** PRIOR. Generic local business, generic page. */
export const DEDICATION_GENERIC_LOCAL = 0.35
/** PRIOR. Platform/directory listing. Occupies the slot, defends nothing. */
export const DEDICATION_PLATFORM = 0.1

/**
 * PRIOR. Dedication at/above which a top-5 local business counts as a
 * "committed operator" for the not_winnable hard blocker.
 */
export const COMMITTED_OPERATOR_DEDICATION = 0.7

// ---------------------------------------------------------------------------
// EMD verdict thresholds
// ---------------------------------------------------------------------------

/**
 * Base rates behind the BANDS. Kept as documentation, deliberately NOT used as
 * arithmetic.
 *
 * Source: Ahrefs study of 2M+ pages -- only 1.74% of new pages reach the top 10
 * within a year, and new domains typically sit in a 3-9 month trust phase. But
 * of the pages that DO reach the top 10, ~40.8% get there within a month, and
 * those are overwhelmingly low-competition queries -- which is the only kind
 * this tool recommends.
 *
 * So the unconditional base rate is brutal and the rate conditional on a
 * genuinely soft SERP is not. Multiplying these together to emit "72% chance"
 * would be invention dressed as measurement: we have no measured conditional
 * distribution, only a plausible story about one. Hence bands with named
 * blockers, never a probability. See emd.ts.
 */
export const BASE_RATES = {
  newPagesReachingTop10WithinAYear: 0.0174,
  ofThoseArrivingWithinAMonth: 0.408,
  trustPhaseMonths: [3, 9] as const,
  source: 'Ahrefs, 2M+ page longitudinal study',
} as const

// --- Hard blockers -> not_winnable ---

/** PRIOR. This many of the top 5 being committed local operators kills it. */
export const NOT_WINNABLE_COMMITTED_TOP5_COUNT = 4
/**
 * PRIOR. If even the WEAKEST top-5 non-platform defender has this many
 * referring main domains, the whole page is above a new domain's reach.
 */
export const NOT_WINNABLE_MIN_REF_DOMAINS_TOP5 = 250
/** PRIOR. A non-platform result at position 1 with this many refdomains. */
export const NOT_WINNABLE_POS1_REF_DOMAINS = 1000

// --- likely_30d gates (ALL must pass) ---

/** PRIOR. Platform-held slots = unclaimed real estate. Need at least this many. */
export const THIRTY_DAY_MIN_PLATFORM_SLOTS = 3
/** PRIOR. Median referring main domains among non-platform results. */
export const THIRTY_DAY_MAX_MEDIAN_REF_DOMAINS = 10
/** PRIOR. At most this many exact-match homepages in the top 5. */
export const THIRTY_DAY_MAX_EXACT_MATCH_TOP5 = 1
/** PRIOR. Difficulty ceiling. */
export const THIRTY_DAY_MAX_DIFFICULTY = 30
/** PRIOR. Below this, ranking #1 is not worth the build regardless of ease. */
export const THIRTY_DAY_MIN_VOLUME = 50

// --- Band boundaries for everything that isn't blocked or 30-day ---

/** PRIOR. Difficulty ceiling for likely_90d. */
export const NINETY_DAY_MAX_DIFFICULTY = 45

/**
 * PRIOR. This many committed local operators in the top 5 caps the band at
 * likely_6m, regardless of how low aggregate difficulty comes out.
 *
 * WHY a separate rule rather than trusting difficulty: aggregate difficulty
 * averages the whole page, so a SERP with two genuinely committed operators and
 * six directories scores in the low 30s -- comfortably inside the 90-day
 * ceiling. But the operator does not have to beat the page average; they have to
 * beat the specific people holding the slots. Displacing someone who is actively
 * working the query takes longer than the average implies, and the count is the
 * signal, not the mean.
 */
export const SIX_MONTH_MIN_COMMITTED_TOP5 = 2
/** PRIOR. Difficulty ceiling for likely_6m. Above this, not_winnable. */
export const SIX_MONTH_MAX_DIFFICULTY = 75

/**
 * PRIOR. Minimum measured weight coverage before we will emit any band other
 * than `unknown`. Below this we are guessing from too little evidence, and the
 * honest answer is "we don't know" rather than a confident-looking band.
 */
export const MIN_WEIGHT_COVERED_FOR_VERDICT = 0.5

// ---------------------------------------------------------------------------
// Link quality
// ---------------------------------------------------------------------------

/**
 * PRIOR. Borrowed FROM Semrush KD, which factors the dofollow/nofollow ratio
 * of top-20 results. Worth stealing: 300 nofollow citations from directory
 * listings is not the same defensive asset as 300 editorial dofollow links,
 * and refdomain COUNT alone cannot tell them apart.
 */
export const LINK_QUALITY_DOFOLLOW_WEIGHT = 0.7
/**
 * PRIOR. Spam score inverts: a high-spam defender is a WEAKER defender, since
 * its link profile is likely to be discounted or penalised. So high spam makes
 * a SERP easier, not harder.
 */
export const LINK_QUALITY_SPAM_WEIGHT = 0.3
/** PRIOR. Spam score (0-100) at which a defender is treated as fully discounted. */
export const SPAM_SCORE_FULL_DISCOUNT = 60

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

/**
 * You cannot buy city-level search volume from DataForSEO.
 * /dataforseo_labs/locations_and_languages returns 94 rows and stops at
 * Country -- it lists which keyword DATABASES exist, not queryable places.
 * So demand is modelled from population, and every figure carries
 * `estimated: true` in its type all the way to the UI. See demand.ts.
 */
export const DEMAND_IS_MODELLED_NOT_MEASURED = true

// ---------------------------------------------------------------------------
// Cache TTLs (days)
// ---------------------------------------------------------------------------

export const TTL_DAYS = {
  /** SERPs move, but not fast enough to justify re-buying inside a month. */
  serpSnapshot: 45,
  /** Link profiles are the slowest-moving thing we buy. */
  domainAuthority: 90,
  /**
   * Availability changes OVERNIGHT -- someone else registers the domain, or a
   * registration lapses. Short TTL, unlike everything else here.
   */
  domainAvailability: 7,
  /**
   * NEGATIVE cache for domains the backlinks API has no data for. Small local
   * sites with no measurable link profile are the COMMON case, not the edge
   * case; without this we re-request (and re-pay for) them forever.
   */
  domainAuthorityUnresolved: 14,
} as const

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/**
 * PRIOR. Skip a county rollup when any single member place is at least this
 * share of the county's population.
 *
 * WHY: independent cities (Virginia's 38, plus Baltimore, St. Louis, and DC)
 * are simultaneously places AND county-equivalents. A naive rollup emits city
 * "Richmond" and county "Richmond city" scanning the identical SERP -- and the
 * county row can NEVER resolve, because the provider lists it as type City.
 * This one threshold catches all 23 such cases generically, with no hardcoded
 * list to maintain.
 */
export const COUNTY_ROLLUP_DOMINANT_PLACE_SHARE = 0.95

/**
 * PRIOR. A metro is only worth scanning separately from its anchor city when
 * it is at least this much bigger.
 *
 * Set LOW deliberately. An earlier version computed metro population by summing
 * incorporated places, which gave ~700k for Milwaukee against a real 1.57M
 * metro -- so any threshold above ~1.15x deleted most metros worth scanning.
 * We now read real CBSA population from cbsa-est2024-alldata.csv, so the
 * undercount is gone and this is only a backstop.
 */
export const METRO_VS_CITY_MIN_RATIO = 1.15

/** The rank-and-rent viable band. Used for ingest coverage assertions and UI defaults. */
export const VIABLE_POPULATION_BAND = { min: 25_000, max: 250_000 } as const
