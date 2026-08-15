/**
 * The supply contract.
 *
 * ==================== ONE SHAPE FOR EVERY DIRECTORY ====================
 * `hotelhottubs.com` lists hotel rooms. `borenhealth.com` lists peptides. A
 * schema built around either one would need rewriting within a month of meeting
 * the other, so this models what is actually common to both:
 *
 *     supplier -> item -> attributes -> a link that earns
 *
 * A hotel property is a supplier and a room is an item; a peptide vendor is a
 * supplier and a product is an item. `attributes` carries everything that makes
 * an item FINDABLE, and it is deliberately free-form — the attribute that
 * matters here is an in-room hot tub and the one that matters there is a
 * peptide's form and dosage, and a fixed column set would be wrong for both.
 * ======================================================================
 */

/** Bumped only on a breaking change. The consumer refuses a version it cannot read. */
export const SUPPLY_SCHEMA_VERSION = 1

export interface SupplyLocation {
  city: string
  /** State / province. "NV". Omitted where the country has no such level. */
  region?: string
  /** ISO-3166 alpha-2. "US". */
  country: string
  lat?: number
  lon?: number
}

export interface SupplyItem {
  /**
   * Stable, and YOURS.
   *
   * The consumer never mints one. A synthesised key — a hash of the title, or a
   * row index — creates duplicates the moment your ordering changes, and the
   * duplicates look exactly like new inventory.
   */
  id: string
  /** The hotel property / the peptide vendor. Groups items for coverage counts. */
  supplierId: string
  supplierName: string
  /** "King Suite with In-Room Jacuzzi". */
  title: string
  /** Canonical page on your site. Where a searcher would land. */
  url: string
  /** The monetising link, when it differs from `url`. */
  affiliateUrl?: string
  /** Omitted entirely for a non-geographic catalogue. Not null — absent. */
  location?: SupplyLocation
  /** What makes this findable. `{ in_room_hot_tub: true, occupancy: 2 }`. */
  attributes?: Record<string, string | number | boolean>
  /**
   * INTEGER MICROS. 1_000_000 = $1.00.
   *
   * Never a float and never "dollars". `29.99` in binary floating point is not
   * $29.99, and a catalogue's worth of those rounds into a median that is
   * quietly wrong. See @rnr/core money.ts, which this mirrors.
   */
  priceMicros?: number
  /** ISO-4217. "USD". Required whenever `priceMicros` is present. */
  currency?: string
  /**
   * Is it bookable/purchasable right now?
   *
   * Omitted means UNKNOWN, which is not the same as false. The consumer counts
   * items and available items separately for exactly this reason.
   */
  available?: boolean
  images?: string[]
  /** ISO 8601. Drives the cursor and the `since` filter. */
  updatedAt: string
}

export interface SupplyManifest {
  schemaVersion: number
  /**
   * ==================== THE FIELD THAT MAKES A PARTIAL SYNC DETECTABLE ====
   * Without a total, a sync that pulls 4,000 of 5,231 items is
   * indistinguishable from a catalogue that shrank to 4,000 — and the consumer
   * would mark 1,231 listings as gone, dropping their localities out of
   * coverage and flipping BUILD verdicts to "supply gap" overnight.
   *
   * This is why the manifest exists as a separate endpoint rather than as a
   * header on the first page.
   * ======================================================================
   */
  totalItems: number
  totalSuppliers: number
  /** ISO 8601. The most recent `updatedAt` in the catalogue, when known. */
  lastModified?: string
  /**
   * Items that failed validation and were therefore NOT served.
   *
   * Reported rather than hidden: three listings that cannot be published are
   * three pages we will never rank, and the count belongs where somebody sees
   * it. A feed that silently drops them looks complete and is not.
   */
  invalidItems: number
  /** A few examples, so the count is actionable rather than just alarming. */
  invalidSamples: Array<{ id: string; problem: string }>
  /** Free-form. Anything the publisher wants the consumer to record. */
  meta?: Record<string, unknown>
}

export interface FetchPageArgs {
  /** Opaque to us; it is whatever your last page returned. Null on the first. */
  cursor: string | null
  /** Already clamped to [1, MAX_PAGE_LIMIT]. Safe to pass straight to `take`. */
  limit: number
  /** ISO 8601, or null. Return only items changed strictly after this. */
  since: string | null
}

export interface FetchPageResult {
  items: SupplyItem[]
  /**
   * The cursor for the NEXT page, or null when this was the last one.
   *
   * Null is the only stop signal. An empty `items` array with a non-null cursor
   * is legal (a page whose rows all failed validation), and the walker keeps
   * going — which is why "no items" must not be overloaded to mean "done".
   */
  nextCursor: string | null
}

export interface SupplyCounts {
  totalItems: number
  totalSuppliers: number
  lastModified?: string
  meta?: Record<string, unknown>
}

export interface SupplyFeedConfig {
  /**
   * Shared secret. Compared timing-safely against the bearer token.
   *
   * ==================== EMPTY MEANS REFUSE, NOT ALLOW ====================
   * An unset token makes every endpoint return 503. Serving openly would be the
   * "convenient" default and it would publish your entire catalogue, pricing
   * included, to anyone who guessed the path — and it would do so silently,
   * because an open endpoint returns 200 exactly like a working one.
   *
   * Same direction as LIVE_CALLS_ENABLED in the consumer, which must be the
   * exact string 'true' before anything can spend: a misconfigured secret fails
   * toward doing nothing.
   * ======================================================================
   */
  token: string | undefined | null
  fetchPage: (args: FetchPageArgs) => Promise<FetchPageResult> | FetchPageResult
  counts: () => Promise<SupplyCounts> | SupplyCounts
  /** Default page size when the caller does not ask. */
  defaultLimit?: number
  /** Hard ceiling. A caller asking for 50,000 gets this and a header saying so. */
  maxLimit?: number
  /** Requests per minute per token. 0 disables. */
  rateLimitPerMinute?: number
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number
}

export interface SupplyErrorBody {
  error: {
    code:
      | 'unauthorized'
      | 'not_configured'
      | 'rate_limited'
      | 'bad_request'
      | 'not_found'
      | 'upstream_error'
    message: string
  }
}
