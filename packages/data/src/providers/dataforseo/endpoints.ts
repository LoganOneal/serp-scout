/**
 * DataForSEO endpoint paths, verified against the live API on 2026-08-03.
 *
 * DO NOT GUESS THESE. A wrong path does not 404 -- it returns HTTP 200 with a
 * task-level error, which means anything that only checks the HTTP status sees
 * success and an empty result set. See LOCATIONS below for the specific case
 * that cost real debugging time.
 */

export const DFS_BASE = 'https://api.dataforseo.com/v3'

export const ENDPOINTS = {
  /** Organic SERP, depth 100. $0.002 */
  SERP_ORGANIC_LIVE: '/serp/google/organic/live/advanced',
  /** Async variant, ~1/3 the price. Not used yet -- kept for a future backfill. */
  SERP_ORGANIC_TASK_POST: '/serp/google/organic/task_post',
  SERP_ORGANIC_TASK_GET: '/serp/google/organic/task_get/advanced',
  /**
   * The only safe way to learn a queued task is finished. Polling task_get
   * instead returns 40601 "Task Handed" and DISCARDS the paid-for result.
   */
  SERP_ORGANIC_TASKS_READY: '/serp/google/organic/tasks_ready',
  /** Local pack / Google Maps SERP. $0.002 — listings only, NOT search volume. */
  SERP_MAPS_LIVE: '/serp/google/maps/live/advanced',

  /**
   * Local-scoped search volume (Google Ads metrics via DataForSEO).
   * Pass the same city `location_code` as SERP/map pack for market-level demand.
   * Charged per request (up to 1000 keywords); rate limit ~12 live req/min.
   */
  KEYWORDS_GOOGLE_ADS_SEARCH_VOLUME: '/keywords_data/google_ads/search_volume/live',

  /**
   * Fetch an arbitrary page's HTML. ~$0.00015 per page.
   *
   * ==================== WHY THIS IS HERE ====================
   * Reddit answers 403 to server IPs -- verified against www, old and api hosts, all three
   * returning a "blocked / bot / network security" HTML page -- and self-service OAuth
   * registration closed in 2026. So SERP monitoring reads a thread's comment order through
   * this endpoint instead: same vendor, same credentials, same spend ledger, no extra
   * approval to wait on.
   * =========================================================
   */
  ON_PAGE_INSTANT_PAGES: '/on_page/instant_pages',

  /**
   * ============================ TRAP 1 ============================
   * Returns `{target, rank}` AND NOTHING ELSE.
   *
   * It does NOT return `referring_domains`, `referring_main_domains`, or
   * `backlinks`, no matter how strongly the endpoint's name and every instinct
   * suggest otherwise. Reading those fields off this response yields `null` for
   * every domain, forever, with no error: the 0.30-weight link component simply
   * vanishes from every score ever produced, the model renormalises around the
   * hole, and the reduced coverage is reported to a UI nobody reads closely.
   *
   * All three bulk endpoints below must be called and merged on `target`.
   * Guarded by a NEGATIVE contract test -- see backlinks.contract.test.ts.
   * ===============================================================
   */
  BACKLINKS_BULK_RANKS: '/backlinks/bulk_ranks/live',
  /** The endpoint that actually has the referring-domain counts. */
  BACKLINKS_BULK_REFERRING_DOMAINS: '/backlinks/bulk_referring_domains/live',
  /** Spam score 0-100. */
  BACKLINKS_BULK_SPAM_SCORE: '/backlinks/bulk_spam_score/live',

  /**
   * ============================ TRAP 2 ============================
   * It is `/serp/google/locations`. 267,107 rows, free.
   *
   * The plausible-looking `/serp/google/organic/locations` returns
   * `"Invalid Path."` as a TASK-LEVEL error inside an HTTP 200 response. A
   * client that trusts the status code reads that as "zero locations exist",
   * and then every locality in the corpus fails to resolve.
   * ===============================================================
   */
  LOCATIONS: '/serp/google/locations',

  /**
   * 94 rows, and they stop at Country.
   *
   * TRAP 3: this enumerates which keyword DATABASES exist, not queryable
   * places. There is NO city-level search volume to buy here. Demand is
   * modelled from population instead (see @rnr/core demand.ts) and every figure
   * is flagged estimated all the way to the UI.
   */
  LABS_LOCATIONS_AND_LANGUAGES: '/dataforseo_labs/locations_and_languages',

  /**
   * Every keyword a domain ranks for — position, volume, CPC, ranking URL.
   *
   * ==================== IT WAS ALREADY BEING CALLED, WRONG ====================
   * `quality-gates.ts` has hit this path as a bare string literal since the
   * expired-domain work, with `limit: 1`, reading `total_count` and throwing the
   * rows away. That is a fine gate ("does this domain still rank for anything?")
   * and it is not keyword research.
   *
   * It is registered here now for the reason TRAP 2 exists: a path that lives as
   * a literal at a call site is a path nobody diffs, and a wrong one returns
   * `"Invalid Path."` inside an HTTP 200 that reads as "this domain ranks for
   * nothing".
   *
   * ⚠️ PRICING IS UNVERIFIED ABOVE limit: 1 — see PRICE.labsRankedKeywords.
   * ==========================================================================
   */
  LABS_RANKED_KEYWORDS: '/dataforseo_labs/google/ranked_keywords/live',

  /**
   * Domains that rank for the same keywords as a target.
   *
   * The pre-registered expectation for `hotelhottubs.com` is that this returns
   * Booking, Expedia and TripAdvisor — a competitor set we cannot gap against,
   * because a keyword they rank for and we do not is not an opportunity. Hence
   * `site_competitors.peer`, which is NULL until somebody decides.
   */
  LABS_COMPETITORS_DOMAIN: '/dataforseo_labs/google/competitors_domain/live',

  /**
   * Keywords two domains BOTH rank for, or that one has and the other lacks.
   *
   * The keyword-gap engine. Same per-row pricing uncertainty as
   * LABS_RANKED_KEYWORDS.
   */
  LABS_DOMAIN_INTERSECTION: '/dataforseo_labs/google/domain_intersection/live',

  /** Balance and account status. Free. Called before any scan spends money. */
  USER_DATA: '/appendix/user_data',
} as const

/** Max targets per bulk backlinks request, per DataForSEO's documented limit. */
export const BULK_TARGET_LIMIT = 1000

/** Task-level status code meaning success. Anything else is a failure. */
export const DFS_OK = 20000
/**
 * `task_post` succeeded and the task is queued. This is a SUCCESS code.
 *
 * Treating every non-20000 as fatal made the queued SERP path -- 70% cheaper
 * than live -- impossible to call at all: the very first response threw.
 */
export const DFS_TASK_CREATED = 20100

/**
 * ============================== TRAP 4 ==============================
 * A suspended or unfunded account answers with HTTP 200 and a task-level
 * status_code in the 402xx range, with a message like "unusual activity...
 * temporarily paused."
 *
 * Read as "no results", this scores EVERY SERP as a wide-open jackpot -- no
 * competitors found anywhere -- and the tool starts recommending domain
 * purchases across the entire corpus. It is the single most expensive way this
 * integration can fail, and it fails looking like success.
 *
 * Detected explicitly, and the resulting error is deliberately NOT catchable
 * into an empty-results path: it aborts the whole run.
 * ===================================================================
 */
export const ACCOUNT_ISSUE_PATTERN =
  /unusual activity|paused|suspend|balance|access.*denied|payment/i

/**
 * "The rates limit per minute has been exceeded: 6 >= 6."
 *
 * Status 40202 sits inside the 402xx payment/access range, so without singling
 * it out the most recoverable failure this client has was classified as a
 * suspended account and failed the entire run. Matched by code AND by wording,
 * because the codes are not fully documented and have changed before.
 */
export const DFS_RATE_LIMIT = 40202
export const RATE_LIMIT_PATTERN = /rate.{0,3}limit|too many requests/i
