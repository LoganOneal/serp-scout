/**
 * Money. Integer micros, bigint, everywhere. Never a float.
 *
 * WHY (this looks like over-engineering and isn't): Postgres `real` is float32,
 * and a float32 running total mis-handles $0.000036 per-row charges in two
 * regimes. Below ~$1,024 it DRIFTS -- 10k row charges on a $100 total land
 * ~$0.02 off, compounding. At/above $1,024 the charge is under half an ulp, so
 * round-to-nearest makes the addition a literal no-op and the total FREEZES
 * while real money keeps leaving the account and the per-run budget cap
 * silently stops capping. Both regimes are pinned in money.test.ts.
 *
 * 1 USD = 1_000_000 micros. All provider prices are exact integers in micros,
 * which is the other half of the argument: there is nothing to round.
 */

/** Micros in one US dollar. */
export const MICROS_PER_USD = 1_000_000n

/** Micros in one US cent. */
export const MICROS_PER_CENT = 10_000n

export type Micros = bigint

export function usdToMicros(usd: number): Micros {
  // Route through cents to keep the float division shallow. Callers pass
  // literals like 0.002, never computed values.
  return BigInt(Math.round(usd * 1_000_000))
}

export function centsToMicros(cents: number): Micros {
  return BigInt(Math.trunc(cents)) * MICROS_PER_CENT
}

/** Display only. Never feed the result back into arithmetic. */
export function formatMicrosUsd(m: Micros, opts?: { precision?: number }): string {
  const precision = opts?.precision ?? 4
  const neg = m < 0n
  const abs = neg ? -m : m
  const whole = abs / MICROS_PER_USD
  const frac = abs % MICROS_PER_USD
  const fracStr = frac.toString().padStart(6, '0').slice(0, precision)
  return `${neg ? '-' : ''}$${whole}${precision > 0 ? `.${fracStr}` : ''}`
}

// --- Provider price list -----------------------------------------------------
// Verified against DataForSEO pricing 2026-08-03. Exact integers in micros.

export const PRICE = {
  /** /serp/google/organic/live/advanced -- $0.002 */
  serpOrganicLive: 2_000n,
  /** /serp/google/organic/task_post + task_get -- $0.0006 */
  serpOrganicTask: 600n,
  /** /serp/google/maps/live/advanced -- $0.002 */
  serpMapsLive: 2_000n,
  /**
   * /keywords_data/google_ads/search_volume/live
   *
   * ==================== THE EXPENSIVE ONE ====================
   * $0.09 PER REQUEST, not per keyword -- confirmed against the account's live
   * rate card (`pnpm exec tsx packages/data/src/scripts/probe-dfs-rates.mts`).
   * It is 45x the price of a SERP call, so one request per keyword makes volume
   * dominate the bill: a 50 keyword x 50 market run is 2,500 requests = $225,
   * while the same keywords batched one request per market is 50 = $4.50.
   *
   * Anything calling this per keyword is a bug. Batch by location_code.
   * =========================================================
   */
  keywordsGoogleAdsSearchVolume: 90_000n,
  /** Any /backlinks/bulk_*\/live -- $0.024 per REQUEST, plus per row below. */
  backlinksBulkRequest: 24_000n,
  /** ...plus $0.000036 per row returned. */
  backlinksBulkRow: 36n,
  /** /on_page/instant_pages -- $0.00015 per page. Used by SERP monitoring. */
  onPageInstantPage: 150n,
  /**
   * on_page/instant_pages WITH JavaScript rendering.
   *
   * Measured by balance delta 2026-08-07: $0.0306 for 6 pages = $0.0051 each,
   * ~34x the non-rendered call. It is the second-pass reader for domains a
   * plain fetch cannot resolve, so it only ever runs on UNKNOWN rows.
   */
  onPageBrowserRender: 5_100n,
  /**
   * /backlinks/referring_domains/live — the full referring-domain LIST for one
   * target, as opposed to the bulk endpoints' counts.
   *
   * Measured by balance delta on 2026-08-07: $25.9873 -> $25.962256 for a
   * single request at limit 100. Not a rate-card lookup — the meter itself.
   * At this price a 118-domain market is $2.96, which is why the audit
   * pre-filters on the bulk counts and only buys the list where it can matter.
   *
   * The audit now calls /backlinks/backlinks/live (mode=one_per_domain) rather
   * than /backlinks/referring_domains/live, because only the former returns
   * `url_from` -- the page the citation actually sits on. Re-measured on
   * 2026-08-10: both endpoints cost $0.0242 for the same target and limit, so
   * the constant and the name still hold. Kept as one constant because the
   * audit buys exactly one of these per qualifying domain either way.
   */
  backlinksReferringDomains: 25_000n,
  /**
   * /dataforseo_labs/google/ranked_keywords/live — does this domain still rank
   * for anything?
   *
   * Measured by balance delta 2026-08-07: $0.012 per domain. Billed per target,
   * which is why the gate that uses it is capped rather than run over a whole
   * market.
   */
  labsRankedKeywords: 12_000n,
  /** /serp/google/locations -- free. */
  locations: 0n,
  /** /appendix/user_data -- free. */
  userData: 0n,
} as const

export type PricedEndpoint = keyof typeof PRICE

/**
 * Cost of one call. `rows` only affects the bulk backlinks endpoints, where
 * the charge is per-request PLUS per-row -- which is precisely why the pipeline
 * batches every domain across all niches into one call set instead of calling
 * per niche. 40 per-niche requests cost 40 x $0.024 in request fees alone for
 * the same rows.
 */
export function costMicros(endpoint: PricedEndpoint, rows = 0): Micros {
  const base = PRICE[endpoint]
  if (endpoint === 'backlinksBulkRequest') {
    return base + PRICE.backlinksBulkRow * BigInt(Math.max(0, rows))
  }
  return base
}

/** Sum, with an explicit bigint zero so an empty list can't yield `0` (number). */
export function sumMicros(values: Iterable<Micros>): Micros {
  let total = 0n
  for (const v of values) total += v
  return total
}

export interface DiscoveryCostBreakdown {
  serpMicros: Micros
  volumeMicros: Micros
  mapsMicros: Micros
  totalMicros: Micros
  /** How many $0.09 volume requests this plan makes. The number that hurts. */
  volumeRequests: number
}

/**
 * What a discovery run will actually cost across ALL the endpoints it calls.
 *
 * ==================== WHY NOT jobCount x serpOrganicLive ====================
 * That was the old estimate, and it is the SERP line only. A job also buys
 * keyword volume ($0.09 per REQUEST -- 45x a SERP) and sometimes a maps pack.
 * Counting just the SERP made a run that cost $3.76 quote and report $0.16, so
 * the budget cap never fired and the operator found out from their DataForSEO
 * balance instead of from us.
 *
 * `volumeRequests` is the lever: volume is priced per request and accepts up to
 * 1000 keywords, so it is one request per LOCATION, not one per keyword. Pass
 * the batched count here and the estimate reflects what the runner should do.
 * =========================================================================
 */
export function estimateDiscoveryCostMicros(args: {
  /** Organic SERP calls — one per job (keyword x location x device). */
  jobCount: number
  /** Keyword-volume requests. Batched: one per location, NOT one per keyword. */
  volumeRequests: number
  /** Maps-pack calls — one per (niche, location) that asks for one. */
  mapsRequests?: number
}): DiscoveryCostBreakdown {
  const n = (x: number) => BigInt(Math.max(0, Math.trunc(x)))
  const serpMicros = n(args.jobCount) * PRICE.serpOrganicLive
  const volumeMicros = n(args.volumeRequests) * PRICE.keywordsGoogleAdsSearchVolume
  const mapsMicros = n(args.mapsRequests ?? 0) * PRICE.serpMapsLive
  return {
    serpMicros,
    volumeMicros,
    mapsMicros,
    totalMicros: serpMicros + volumeMicros + mapsMicros,
    volumeRequests: Math.max(0, Math.trunc(args.volumeRequests)),
  }
}
