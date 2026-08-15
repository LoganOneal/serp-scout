/**
 * Supply coverage: whether we can actually fulfil the demand a keyword names.
 *
 * ==================== SUPPLY IS A GATE, NOT A DISPLAY FEATURE ====================
 * `expandKeywordSpace` generated 975 keywords for hotelhottubs.com — 195
 * localities x 5 patterns — and it did so with no knowledge of whether the site
 * has one listing in Boise or none. Nothing downstream knew either.
 *
 * So `assessKeyword` can return BUILD for a locality with no inventory, and
 * `assessPaidKeyword` can return BUY and put real CPC behind a click that lands
 * on an empty result set. Neither model is wrong. Neither was ever given the
 * input.
 * ================================================================================
 *
 * ==================== AND UNKNOWN MUST NOT BECOME ZERO ====================
 * The obvious next move — "no coverage row means no supply, so block it" — swaps
 * one silent failure for a louder and more expensive one. A locality we FAILED
 * TO RESOLVE ("Las Vegas" never matched `las-vegas-nv`) is not a locality with
 * no hotels, and gating on it would turn an importer bug into a decision to stop
 * building pages across the portfolio.
 *
 * `SupplyStatus` therefore has three members, not two, and 'unknown' never
 * downgrades a verdict. Same rule as `positionMeasuredAt !== null` and
 * `domain_authority.resolved`: measured-and-zero and never-measured are
 * different facts, and any type that cannot hold both will eventually be asked
 * to.
 * =========================================================================
 */

/** Micros. Mirrors money.ts; duplicated as a type-only alias to avoid a cycle. */
type Micros = bigint

export type SupplyStatus =
  /** At least one AVAILABLE item is bound to this entity. */
  | 'have'
  /** Measured, and the count is zero. A real fact about the catalogue. */
  | 'none'
  /** No source connected, never ingested, or the entity never resolved. */
  | 'unknown'

/**
 * What the read model holds for one (site, entity) pair.
 *
 * Every count is nullable-free because the row existing IS the measurement —
 * same encoding as `outcomes.position` being nullable while `checked_at` is not.
 * Absence of the whole object is what means "never measured".
 */
export interface SupplyCoverage {
  entityKind: string
  entitySlug: string
  supplierCount: number
  itemCount: number
  /**
   * Items the publisher marked `available: true`.
   *
   * THE ONE THE GATE READS. `itemCount` includes rows whose availability the
   * publisher never stated, and treating an unstated availability as bookable is
   * how a sold-out city keeps its BUILD verdict.
   */
  availableItemCount: number
  minPriceMicros: Micros | null
  medianPriceMicros: Micros | null
  /**
   * When we last CONFIRMED these rows exist — ours, not the publisher's.
   *
   * Kept apart from the publisher's `updatedAt` deliberately: the first says
   * when we looked, the second says when they changed it. Collapsing them loses
   * the ability to tell *stale* from *unchanged*, and a 30-day-old coverage
   * count is a claim about the past.
   */
  lastSeenAt: string
}

/**
 * Beyond this, coverage is a historical claim rather than a current one.
 *
 * POLICY, not a measurement. Thirty days is chosen to be obviously longer than
 * any sane sync cadence, so tripping it means something upstream broke rather
 * than that the schedule is slow.
 */
export const COVERAGE_STALE_AFTER_DAYS = 30

export interface SupplyStatusResult {
  status: SupplyStatus
  reason: string
  /** True when the numbers are real but older than COVERAGE_STALE_AFTER_DAYS. */
  stale: boolean
}

export interface SupplyStatusOptions {
  /** ISO 8601. Injected rather than read from the clock, so this stays pure. */
  now?: string
  staleAfterDays?: number
}

/**
 * The three-way answer, from a coverage row that may not exist.
 *
 * `null` and `undefined` both mean "no row", which is 'unknown' — never 'none'.
 * The two callers that could get this wrong are the two that spend money.
 */
export function supplyStatusFor(
  coverage: SupplyCoverage | null | undefined,
  opts: SupplyStatusOptions = {},
): SupplyStatusResult {
  if (!coverage) {
    return {
      status: 'unknown',
      reason:
        'No supply coverage for this entity: either no feed is connected, the ingest has not run, ' +
        'or the listing’s location never resolved to this slug. Not the same as having no listings.',
      stale: false,
    }
  }

  const staleDays = opts.staleAfterDays ?? COVERAGE_STALE_AFTER_DAYS
  const now = opts.now ? Date.parse(opts.now) : Date.now()
  const seen = Date.parse(coverage.lastSeenAt)
  const ageDays = Number.isNaN(seen) ? Number.POSITIVE_INFINITY : (now - seen) / 86_400_000
  const stale = ageDays > staleDays

  if (coverage.availableItemCount > 0) {
    return {
      status: 'have',
      reason:
        `${coverage.availableItemCount} available item(s) across ${coverage.supplierCount} ` +
        `supplier(s)` + (stale ? `, last confirmed ${Math.round(ageDays)} days ago` : ''),
      stale,
    }
  }

  /**
   * Items exist but none is available. Reported as 'none' with the distinction
   * kept in the reason: a city with 40 sold-out rooms is a supply problem of a
   * completely different kind from a city with no properties at all, and only
   * one of them is fixed by acquiring inventory.
   */
  if (coverage.itemCount > 0) {
    return {
      status: 'none',
      reason:
        `${coverage.itemCount} item(s) listed, none marked available. The inventory exists and ` +
        `cannot currently be booked.`,
      stale,
    }
  }

  return {
    status: 'none',
    reason: `Measured: no items for this entity${stale ? ` (last confirmed ${Math.round(ageDays)} days ago)` : ''}.`,
    stale,
  }
}

/**
 * ==================== THE 2x2 ====================
 * Supply and demand crossed. The two OFF-DIAGONAL cells are where the value is,
 * and neither of them can be produced by either signal alone:
 *
 *                    | keyword demand  | no demand
 *   -----------------+-----------------+------------------
 *   have supply      | BUILD_FIRST     | KEYWORD_GAP
 *   no supply        | SUPPLY_GAP      | IGNORE
 *
 * SUPPLY_GAP is the cell that costs money today — a BUILD verdict sending
 * someone to write a page about hotels we cannot book, and a BUY verdict
 * spending CPC on a query we cannot convert.
 *
 * KEYWORD_GAP is the cell nobody looks for. Forty properties in a city with no
 * keyword row is demand-side work with the supply risk already removed, and
 * nothing in this system could previously produce that list.
 * =================================================
 */
export type SupplyOpportunity =
  | 'BUILD_FIRST'
  | 'KEYWORD_GAP'
  | 'SUPPLY_GAP'
  | 'IGNORE'
  | 'UNKNOWN'

/** Whether the keyword side of the 2x2 says there is demand worth serving. */
export type DemandStatus = 'demand' | 'no_demand' | 'unknown'

export interface OpportunityResult {
  cell: SupplyOpportunity
  action: string
}

export function classifySupplyOpportunity(
  supply: SupplyStatus,
  demand: DemandStatus,
): OpportunityResult {
  if (supply === 'unknown' || demand === 'unknown') {
    return {
      cell: 'UNKNOWN',
      action:
        `Not decidable — ${supply === 'unknown' ? 'supply' : 'demand'} was never measured for this ` +
        `entity. Measure it before deciding; do not read a blank as a zero.`,
    }
  }

  if (supply === 'have' && demand === 'demand') {
    return { cell: 'BUILD_FIRST', action: 'Demand exists and we can fulfil it. Build this first.' }
  }
  if (supply === 'have' && demand === 'no_demand') {
    return {
      cell: 'KEYWORD_GAP',
      action:
        'Inventory nobody can find. The supply risk is already gone, so this is the cheapest page ' +
        'in the portfolio — the missing piece is a keyword row, not a listing.',
    }
  }
  if (supply === 'none' && demand === 'demand') {
    return {
      cell: 'SUPPLY_GAP',
      action:
        'Do not build and do not bid. Real demand we cannot fulfil — acquire supply here or drop ' +
        'the keyword. Which one is a commercial call, not a model’s.',
    }
  }
  return { cell: 'IGNORE', action: 'No supply and no demand.' }
}

/**
 * Median listing price for an entity, as an order-value estimate.
 *
 * ==================== BETTER THAN A SITE AVERAGE, STILL AN ESTIMATE ====
 * `resolveKeywordEconomics` falls back to ONE site-wide order value flagged
 * INHERITED, with plan-affiliate-economics.md noting that order value varies
 * more across destinations than commission varies across vendors. A per-locality
 * median from our own inventory is a measured number where that was a guess.
 *
 * It is still not average booking value: nobody books the median room, and this
 * ignores length of stay entirely. Returned with `estimated: true` — the same
 * literal-true marker DemandEstimate and RentModel carry — so it can never be
 * constructed as unflagged and can never be mistaken for a measured conversion.
 * ======================================================================
 */
export interface SupplyOrderValue {
  orderValueMicros: Micros
  estimated: true
  basis: string
}

/** Below this, a median is one or two rows and says more about them than the market. */
export const MIN_ITEMS_FOR_MEDIAN = 3

export function orderValueFromSupply(
  coverage: SupplyCoverage | null | undefined,
  opts: { minItems?: number } = {},
): SupplyOrderValue | null {
  if (!coverage || coverage.medianPriceMicros === null) return null
  const minItems = opts.minItems ?? MIN_ITEMS_FOR_MEDIAN
  if (coverage.itemCount < minItems) return null
  if (coverage.medianPriceMicros <= 0n) return null
  return {
    orderValueMicros: coverage.medianPriceMicros,
    estimated: true,
    basis:
      `Median listed price across ${coverage.itemCount} item(s) in ${coverage.entitySlug}. ` +
      `Not average booking value — nobody books the median room and this ignores length of stay.`,
  }
}
