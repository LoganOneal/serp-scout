import type { Micros } from '../money.js'
import {
  estimatePriorStrength,
  shrinkRate,
  type Observation,
  type ShrunkRate,
} from './shrinkage.js'

/**
 * What is one click on this keyword worth, and how do we know?
 *
 * ==================== ECONOMICS ARE A FUNCTION OF BOUND ENTITIES ==========
 * A keyword's terms come from different dimensions, and which dimension supplies
 * which term is not the same across sites:
 *
 *   bpc-157 peptide sciences review   commission <- VENDOR, order value <- PRODUCT
 *   bpc-157 dosage                    commission <- ???  (no vendor is bound)
 *   hotels with hot tubs las vegas    commission <- SITE, order value <- LOCALITY
 *
 * The middle case is the one that needs a rule written down, because a
 * product-only keyword monetises through whichever vendor the page routes the
 * click to and we do not measure that split.
 *
 * ==================== THE RULE: MINIMUM, NOT AVERAGE ====================
 * Same reasoning as break-even using the HIGH end of Google's bid range. When
 * the true value is unknown within a range and the number gates spending,
 * assuming the favourable end is the optimistic error. A keyword that clears
 * break-even at the worst-paying vendor's rate clears it everywhere.
 *
 * Deliberately pessimistic, and it will under-rate product keywords that in
 * fact route mostly to a high-paying vendor. Fixing that needs click-routing
 * data we do not collect.
 * =======================================================================
 *
 * Every term carries `resolvedFrom`. A verdict nobody can trace is a verdict
 * nobody can argue with, and the whole point of the break-even framing is that
 * an operator CAN argue with it.
 *
 * See docs/plan-affiliate-economics.md §2.4.
 */

export interface CommissionRate {
  /** null = the site default row. */
  entitySlug: string | null
  commissionRateBps: number
  /** ISO date. Rates are effective-dated so a renegotiation cannot rewrite history. */
  effectiveFrom: string
}

export interface EconomicsCatalog {
  /** ISO date the plan is being computed for. */
  asOf: string
  siteDefaultOrderValueMicros: Micros | null
  commissionRates: CommissionRate[]
  /**
   * Vendor slugs eligible for the min-across-vendors fallback.
   *
   * Explicitly supplied rather than derived from `commissionRates`, because a
   * vendor with no rate row must NOT silently drop out of the minimum — that
   * would make the fallback more optimistic the less we know.
   */
  vendorSlugs: string[]
  /** Entity slug → order value. Absent = inherit the site default. */
  entityOrderValueMicros: Record<string, Micros>
}

export interface KeywordBindings {
  /** dimension → entity slug, as stored on `site_keyword_targets.entities`. */
  entities: Record<string, string>
  /** Which dimension carries the vendor, if any. */
  vendorDimension?: string | undefined
  /** Dimensions that may carry an order value, most specific first. */
  orderValueDimensions?: string[] | undefined
}

export interface ResolvedTerm<T> {
  value: T | null
  /** `vendor:peptide-sciences`, `site-default`, `min-across-vendors`, `unset`. */
  resolvedFrom: string
  /** True when a site-level average is standing in for an entity-level number. */
  inherited: boolean
}

export interface ResolvedEconomics {
  commissionRateBps: ResolvedTerm<number>
  orderValueMicros: ResolvedTerm<Micros>
  /** Order value × commission. Null if either is null. */
  valuePerConversionMicros: Micros | null
}

/**
 * The rate in force on `asOf` for one entity, falling back to the site default.
 *
 * Effective-dated on purpose: a plan written three months ago must still explain
 * the numbers it reported, and `ads_plans` freezes what it used for the same
 * reason.
 */
export function commissionFor(
  catalog: EconomicsCatalog,
  entitySlug: string | null,
): { bps: number; from: string } | null {
  const eligible = catalog.commissionRates
    .filter((r) => r.entitySlug === entitySlug && r.effectiveFrom <= catalog.asOf)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
  const hit = eligible[0]
  return hit ? { bps: hit.commissionRateBps, from: hit.effectiveFrom } : null
}

export function resolveEconomics(
  catalog: EconomicsCatalog,
  bindings: KeywordBindings,
): ResolvedEconomics {
  // --- Commission ------------------------------------------------------------
  let commission: ResolvedTerm<number> = { value: null, resolvedFrom: 'unset', inherited: false }

  const vendorSlug = bindings.vendorDimension
    ? bindings.entities[bindings.vendorDimension]
    : undefined

  if (vendorSlug) {
    const own = commissionFor(catalog, vendorSlug)
    if (own) {
      commission = { value: own.bps, resolvedFrom: `vendor:${vendorSlug}`, inherited: false }
    } else {
      const site = commissionFor(catalog, null)
      commission = site
        ? { value: site.bps, resolvedFrom: 'site-default', inherited: true }
        : commission
    }
  } else if (bindings.vendorDimension && catalog.vendorSlugs.length > 0) {
    /**
     * No vendor bound, but this site HAS vendors — the ambiguous case. Take the
     * worst rate across all of them, and count a vendor with no rate row as the
     * site default rather than skipping it: skipping would make the fallback
     * more optimistic the less we know, which is backwards.
     */
    const siteDefault = commissionFor(catalog, null)
    const missing = catalog.vendorSlugs.filter(
      (slug) => commissionFor(catalog, slug) === null && siteDefault === null,
    )
    const rates = catalog.vendorSlugs.map(
      (slug) => commissionFor(catalog, slug)?.bps ?? siteDefault?.bps ?? null,
    )
    const known = rates.filter((r): r is number => r !== null)

    if (missing.length > 0) {
      /**
       * REFUSED, and the reason is named.
       *
       * With a vendor carrying no rate and no site default to stand in, the
       * minimum across the KNOWN vendors would be an upper bound wearing a
       * lower bound's name — the unknown vendor could pay less than any of
       * them. Returning it would make the fallback more optimistic the less we
       * know, which is exactly backwards.
       *
       * `unset` alone was not enough: the first real run on borenhealth showed
       * a bare "unset" when the actual cause was five vendors without rates,
       * which is a five-minute fix nobody could see they needed to make.
       */
      commission = {
        value: null,
        resolvedFrom:
          `blocked: ${missing.length} of ${catalog.vendorSlugs.length} vendors have no rate ` +
          `and there is no site default (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`,
        inherited: false,
      }
    } else if (known.length === catalog.vendorSlugs.length && known.length > 0) {
      commission = {
        value: Math.min(...known),
        resolvedFrom: `min-across-${known.length}-vendors`,
        inherited: true,
      }
    } else if (siteDefault) {
      commission = { value: siteDefault.bps, resolvedFrom: 'site-default', inherited: true }
    }
  } else {
    const site = commissionFor(catalog, null)
    if (site) commission = { value: site.bps, resolvedFrom: 'site-default', inherited: false }
  }

  // --- Order value -----------------------------------------------------------
  let orderValue: ResolvedTerm<Micros> = { value: null, resolvedFrom: 'unset', inherited: false }

  for (const dim of bindings.orderValueDimensions ?? []) {
    const slug = bindings.entities[dim]
    if (!slug) continue
    const own = catalog.entityOrderValueMicros[slug]
    if (own !== undefined) {
      orderValue = { value: own, resolvedFrom: `${dim}:${slug}`, inherited: false }
      break
    }
  }
  if (orderValue.value === null && catalog.siteDefaultOrderValueMicros !== null) {
    /**
     * Flagged INHERITED, and the flag is load-bearing on screen.
     *
     * A Las Vegas suite and a Wisconsin Dells family room are not the same
     * booking, and break-even is linear in order value — so a site average
     * standing in for a destination is a real approximation, not a formality.
     * An inherited average that renders identically to a measured one is the
     * failure this repo's first rule covers.
     */
    orderValue = {
      value: catalog.siteDefaultOrderValueMicros,
      resolvedFrom: 'site-default',
      inherited: true,
    }
  }

  const valuePerConversionMicros =
    orderValue.value === null || commission.value === null
      ? null
      : (orderValue.value * BigInt(commission.value)) / 10_000n

  return { commissionRateBps: commission, orderValueMicros: orderValue, valuePerConversionMicros }
}

// --- Conversion --------------------------------------------------------------

/** One level of the shrinkage hierarchy, specific first. */
export interface ConversionScope {
  /** `keyword:hotels with hot tubs las vegas`, `pattern:in-room`, `site`. */
  label: string
  observation: Observation
}

export interface ResolvedConversion extends ShrunkRate {
  /** Which scope's own data dominated. */
  resolvedFrom: string
  /** Every level, so the shrinkage chain is inspectable. */
  chain: Array<{ label: string; clicks: number; orders: number; rateBps: number | null }>
  /** Period the underlying observations cover. Stale data looks fresh otherwise. */
  periodEnd: string | null
}

/**
 * Walk the hierarchy from broad to specific, shrinking at each step.
 *
 * The parent for level N is the SHRUNK estimate at level N-1, not its raw rate.
 * Chaining the shrunk values is what makes a keyword with 5 clicks inherit its
 * pattern's stabilised number rather than the pattern's own noisy one.
 *
 * `scopes` is ordered SPECIFIC FIRST (keyword, pattern, site) to match how a
 * caller thinks about it; this reverses internally.
 */
export function resolveConversion(args: {
  /** Specific first. The last element is the root and needs its own data. */
  scopes: ConversionScope[]
  /** Siblings at the finest level, for method-of-moments prior strength. */
  siblings?: Observation[]
  priorStrength?: number
  lowerQuantile?: number
  periodEnd?: string | null
}): ResolvedConversion | null {
  const scopes = [...args.scopes].reverse()
  const root = scopes[0]
  if (!root || root.observation.clicks === 0) {
    /**
     * Nothing anywhere has been measured. Null, not zero, not a plausible
     * default — the paid model turns this into UNKNOWN, which is the honest
     * verdict for a site whose conversion rate nobody has entered.
     */
    return null
  }

  const estimated = args.siblings ? estimatePriorStrength(args.siblings) : null
  const priorStrength = args.priorStrength ?? estimated ?? undefined

  const chain: ResolvedConversion['chain'] = []
  let current: ShrunkRate | null = null
  let priorBps = Math.round((root.observation.orders / root.observation.clicks) * 10_000)
  let resolvedFrom = root.label

  for (const scope of scopes) {
    chain.push({
      label: scope.label,
      clicks: scope.observation.clicks,
      orders: scope.observation.orders,
      rateBps:
        scope.observation.clicks > 0
          ? Math.round((scope.observation.orders / scope.observation.clicks) * 10_000)
          : null,
    })

    const shrunk = shrinkRate({
      observation: scope.observation,
      priorBps,
      ...(priorStrength === undefined ? {} : { priorStrength }),
      ...(args.lowerQuantile === undefined ? {} : { lowerQuantile: args.lowerQuantile }),
    })
    if (!shrunk) continue

    current = shrunk
    priorBps = shrunk.meanBps
    // Attribute to the most specific level that actually contributed data.
    if (scope.observation.clicks > 0) resolvedFrom = scope.label
  }

  if (!current) return null

  return {
    ...current,
    resolvedFrom,
    chain: chain.reverse(),
    periodEnd: args.periodEnd ?? null,
  }
}

/**
 * Derive every term from one set of network numbers.
 *
 * ==================== THE ENTRY SHAPE IS THE POINT ====================
 * An operator reads `clicks / orders / commission earned` off a dashboard, and
 * all three terms fall out of it at once WITH the sample size attached. There is
 * deliberately no path that accepts a bare rate: "3% from 40 clicks" and "3%
 * from 40,000" are different facts and the model treats them differently.
 *
 * `effectiveCommissionBps` is worth having even when the contract says 7.5% —
 * it is what actually landed after adjustments and category mixes, and where it
 * diverges from the contract the contract is the wrong number to plan with.
 * =====================================================================
 */
export function deriveFromObservation(o: {
  clicks: number
  orders: number
  saleValueMicros?: Micros | null
  commissionMicros?: Micros | null
}): {
  conversionBps: number | null
  averageOrderValueMicros: Micros | null
  effectiveCommissionBps: number | null
} {
  const conversionBps =
    o.clicks > 0 ? Math.round((o.orders / o.clicks) * 10_000) : null

  const averageOrderValueMicros =
    o.saleValueMicros != null && o.orders > 0 ? o.saleValueMicros / BigInt(o.orders) : null

  const effectiveCommissionBps =
    o.saleValueMicros != null && o.commissionMicros != null && o.saleValueMicros > 0n
      ? Number((o.commissionMicros * 10_000n) / o.saleValueMicros)
      : null

  return { conversionBps, averageOrderValueMicros, effectiveCommissionBps }
}
