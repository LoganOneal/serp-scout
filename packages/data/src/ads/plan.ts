import 'server-only'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import {
  allocateBudget,
  assessFeasibility,
  assessPaidKeyword,
  assignClusters,
  gatePaidVerdict,
  orderValueFromSupply,
  supplyStatusFor,
  type AdsMatchType,
  type AllocationCandidate,
  type ClusterAssignment,
  type Micros,
  type PaidVerdict,
} from '@rnr/core'
import type { Database } from '../db.js'
import { adsPlanKeywords, adsPlans, siteKeywordTargets, sites } from '../schema.js'
import { fetchCampaignForecast } from '../providers/google-ads/forecast.js'
import { loadEconomicsCatalog, resolveKeywordEconomics } from '../economics/store.js'
import { loadSiteSpace } from '../spaces/research.js'
import { coverageForKeyword, loadCoverageMap } from '../supply/coverage.js'

/**
 * Turn measured keywords into a paid-search plan that has not been launched.
 *
 * ==================== THE ORDER IS THE ARGUMENT ====================
 * 1. Verdict per keyword, from the BREAK-EVEN conversion rate — never from a
 *    predicted profit. See @rnr/core assessPaidKeyword and
 *    docs/plan-paid-search.md §0 for why a profit prediction here would be
 *    confidently wrong in the optimistic direction.
 * 2. Allocate the budget across survivors, spread rather than concentrated,
 *    with a share reserved for exploration.
 * 3. Assign destinations to treatment/control BEFORE launch, and compute
 *    whether the resulting test can actually resolve the question.
 * 4. Ask Google for its own forecast of the cost side.
 * 5. Persist. Nothing launches.
 * ===================================================================
 */

export interface BuildPlanArgs {
  siteId: number
  name: string
  dailyBudgetMicros: Micros
  /**
   * The conversion rate the operator ACTUALLY achieves, in bps, from their
   * affiliate network. Null makes every verdict UNKNOWN, which is the correct
   * output for a site whose conversion rate has never been imported.
   */
  achievedConversionBps: number | null
  matchType?: AdsMatchType
  /** Keyword ceiling. Reported when it truncates. */
  maxKeywords?: number
  /** Bid as a fraction of the high end of Google's range. */
  bidFraction?: number
  /** Terms to flag as brand queries. See isBrandQuery. */
  brandTerms?: string[]
  /**
   * What-if overrides for the economics, NOT written to the site.
   *
   * "What would it take at a $150 order value?" is a legitimate question to ask
   * before an operator has imported anything, and answering it must not require
   * storing an invented order value on the site row where the next reader would
   * take it for a measurement. The plan records what it used, so the answer
   * stays attributable — see `ads_plans.order_value_micros`.
   */
  economicsOverride?: {
    orderValueMicros?: Micros
    commissionRateBps?: number
  }
  /** Fetch Google's forecast. Free, and off by default so a build stays offline. */
  forecast?: boolean
  /** Injected so a plan is reproducible and auditable. */
  random?: () => number
  experiment?: {
    minDetectableRelativeLift?: number
    maxDays?: number
  }
}

export interface BuildPlanResult {
  planId: number
  byVerdict: Record<PaidVerdict, number>
  allocatedKeywords: number
  allocatedBudgetMicros: Micros
  experimentFeasible: boolean | null
  experimentVerdict: string | null
  forecast: {
    clicks: number | null
    costMicros: Micros | null
    source: string
  } | null
  notes: string[]
}

const EMPTY_TALLY = (): Record<PaidVerdict, number> => ({
  BUY: 0,
  MARGINAL: 0,
  SKIP: 0,
  BLOCKED: 0,
  UNKNOWN: 0,
})

/** Default bid: 80% of Google's top-of-page high. */
export const DEFAULT_BID_FRACTION = 0.8

export async function buildAdsPlan(
  db: Database,
  args: BuildPlanArgs,
): Promise<BuildPlanResult> {
  const notes: string[] = []
  const site = await loadSiteSpace(db, args.siteId)
  const space = site.keywordSpace
  if (!space) throw new Error(`Site ${args.siteId} has no keyword_space`)

  const [siteRow] = await db
    .select({
      orderValueMicros: sites.affiliateOrderValueMicros,
      commissionRateBps: sites.affiliateCommissionRateBps,
    })
    .from(sites)
    .where(eq(sites.id, args.siteId))
    .limit(1)

  const economics = {
    orderValueMicros: args.economicsOverride?.orderValueMicros ?? siteRow?.orderValueMicros ?? null,
    commissionRateBps:
      args.economicsOverride?.commissionRateBps ?? siteRow?.commissionRateBps ?? null,
  }

  if (args.economicsOverride) {
    notes.push(
      'Economics are a WHAT-IF override, not this site’s stored values. Every break-even figure ' +
        'below is conditional on them being right.',
    )
  }

  /**
   * These used to be checked HERE, against the site scalars, and both fired on
   * a plan whose economics resolved perfectly well per keyword — telling the
   * operator to set numbers that were already set. Commission comes from the
   * bound vendor and conversion from observations, so neither is knowable until
   * resolution has actually run. Moved below, and driven by what happened.
   */

  const maxKeywords = args.maxKeywords ?? 500
  const bidFraction = args.bidFraction ?? DEFAULT_BID_FRACTION
  const matchType = args.matchType ?? 'EXACT'

  const rows = await db
    .select()
    .from(siteKeywordTargets)
    .where(
      and(
        eq(siteKeywordTargets.siteId, args.siteId),
        eq(siteKeywordTargets.active, true),
        isNotNull(siteKeywordTargets.volume),
      ),
    )
    .orderBy(desc(siteKeywordTargets.volume))
    .limit(maxKeywords + 1)

  if (rows.length > maxKeywords) {
    notes.push(
      `Truncated to the top ${maxKeywords} keywords by volume. This plan is a sample of the ` +
        `eligible set, not the set.`,
    )
  }
  const considered = rows.slice(0, maxKeywords)

  if (considered.length === 0) {
    notes.push(
      'No keyword has a measured volume. Run the free volume pass first — a plan built on ' +
        'unmeasured demand is a plan built on nothing.',
    )
  }

  /**
   * ==================== PER-KEYWORD ECONOMICS, NOT SITE SCALARS ====================
   * Commission varies by vendor and order value varies by destination, so the
   * terms are resolved PER KEYWORD from whatever entities it binds. The
   * site-level values become one input to that resolution rather than the whole
   * answer — see @rnr/core resolveEconomics.
   *
   * The catalog is loaded once. A 975-keyword plan resolving per row would issue
   * thousands of queries for a handful of distinct facts.
   */
  const catalog = await loadEconomicsCatalog(db, args.siteId)
  if (args.economicsOverride) {
    // A what-if replaces the site default only. Per-vendor rates and per-entity
    // order values still apply, because overriding them silently would answer a
    // different question than the one asked.
    if (args.economicsOverride.orderValueMicros !== undefined) {
      catalog.siteDefaultOrderValueMicros = args.economicsOverride.orderValueMicros
    }
    if (args.economicsOverride.commissionRateBps !== undefined) {
      catalog.commissionRates = [
        ...catalog.commissionRates.filter((r) => r.entitySlug !== null),
        {
          entitySlug: null,
          commissionRateBps: args.economicsOverride.commissionRateBps,
          effectiveFrom: '1970-01-01',
        },
      ]
    }
  }

  /**
   * Supply, loaded once. Empty for a site with no feed, which leaves every
   * keyword 'unknown' and every verdict untouched.
   */
  const coverage = await loadCoverageMap(db, args.siteId)
  const nowIso = new Date().toISOString()

  // --- 1. Verdict per keyword ------------------------------------------------
  const byVerdict = EMPTY_TALLY()
  const provenance = new Map<string, number>()
  let inheritedOrderValue = 0
  let boundDecided = 0
  let supplyBlocked = 0
  let supplyPricedOrderValue = 0

  let noCommission = 0
  let noOrderValue = 0
  let noConversion = 0

  const assessed = considered.map((row) => {
    const resolved = resolveKeywordEconomics(catalog, {
      keywordNorm: row.keywordNorm,
      patternLabel: row.patternLabel,
      entities: row.entities,
    })

    const cov = coverageForKeyword(coverage, row.entities)
    const supply = supplyStatusFor(cov, { now: nowIso })

    /**
     * ==================== A MEASURED ORDER VALUE BEATS AN INHERITED ONE ======
     * `resolveKeywordEconomics` falls back to ONE site-wide order value when the
     * bound entity has none, and plan-affiliate-economics.md already flags that
     * order value varies more across destinations than commission varies across
     * vendors. The median listed price in that destination, from our own
     * inventory, is a measured number where that was a guess.
     *
     * It only ever REPLACES an inherited value — an entity with an explicitly
     * set order value keeps it. Somebody typed that on purpose, and a median
     * silently overruling it would answer a question nobody asked.
     * ========================================================================
     */
    let orderValueMicros = resolved.orderValueMicros.value
    if (resolved.orderValueMicros.inherited) {
      const fromSupply = orderValueFromSupply(cov)
      if (fromSupply) {
        orderValueMicros = fromSupply.orderValueMicros
        supplyPricedOrderValue += 1
      }
    }

    const key = resolved.commissionRateBps.resolvedFrom
    provenance.set(key, (provenance.get(key) ?? 0) + 1)
    if (resolved.orderValueMicros.inherited && orderValueMicros === resolved.orderValueMicros.value) {
      inheritedOrderValue += 1
    }
    if (resolved.commissionRateBps.value === null) noCommission += 1
    if (orderValueMicros === null) noOrderValue += 1
    if (resolved.conversion === null && args.achievedConversionBps === null) noConversion += 1

    /**
     * The stated rate is a manual override; observations supersede it. A number
     * derived from measured clicks beats one somebody typed, and when both
     * exist the typed one is the older belief.
     */
    const achievedPoint = resolved.conversion?.meanBps ?? args.achievedConversionBps
    const achievedLower = resolved.conversion?.lowerBps ?? null
    if (achievedLower !== null) boundDecided += 1

    const demandResult = assessPaidKeyword({
      keywordNorm: row.keywordNorm,
      volume: row.volume,
      organicPosition: row.position,
      // The distinction the schema exists for: silence vs never having asked.
      positionMeasured: row.positionMeasuredAt !== null,
      bidLowMicros: row.bidLowMicros,
      bidHighMicros: row.bidHighMicros,
      hasAiOverview: row.hasAiOverview,
      economics: {
        orderValueMicros,
        commissionRateBps: resolved.commissionRateBps.value,
      },
      achievedConversionBps: achievedPoint,
      achievedConversionLowerBps: achievedLower,
      ...(args.brandTerms === undefined ? {} : { brandTerms: args.brandTerms }),
    })

    /**
     * Paid is gated harder than organic. An organic page built into a supply gap
     * costs a writer's afternoon and is reusable when inventory arrives; a paid
     * click into one costs money per click, immediately, and buys nothing that
     * survives. Zero supply BLOCKS — the same treatment as an AI Overview.
     */
    const result = gatePaidVerdict(demandResult, supply)
    if (result.gated) supplyBlocked += 1

    byVerdict[result.verdict] += 1
    return { row, result, resolved }
  })

  /**
   * Reported from what resolution ACTUALLY produced, and only when it is true.
   * Each line names the command that fixes it, because "every keyword is
   * UNKNOWN" without a cause reads as a broken feature rather than a missing
   * input.
   */
  if (noCommission > 0) {
    notes.push(
      `${noCommission} keyword(s) have NO commission rate. Break-even is uncomputable for them. ` +
        `Fix with \`economics set <domain> --commission-bps=…\` or \`economics set-vendor\`.`,
    )
  }
  if (noOrderValue > 0) {
    notes.push(
      `${noOrderValue} keyword(s) have NO order value. Fix with ` +
        `\`economics set <domain> --order-value=…\` or \`economics set-value <domain> <slug>\`.`,
    )
  }
  if (noConversion > 0) {
    notes.push(
      `${noConversion} keyword(s) have no conversion measurement and none was supplied. The model ` +
        `compares the REQUIRED rate against one you actually achieve — record what a dashboard ` +
        `says with \`economics observe <domain> --clicks=… --orders=…\`.`,
    )
  }

  for (const [source, n] of [...provenance].sort((a, b) => b[1] - a[1])) {
    notes.push(`commission: ${n} keyword(s) resolved from ${source}`)
  }
  if (inheritedOrderValue > 0) {
    notes.push(
      `${inheritedOrderValue} keyword(s) used the SITE order value because their entity has none. ` +
        `Break-even is linear in order value, so a site average standing in for a destination is a ` +
        `real approximation, not a formality.`,
    )
  }
  if (boundDecided > 0) {
    notes.push(
      `${boundDecided} keyword(s) were decided on a posterior LOWER BOUND from measured clicks, ` +
        `not on a stated rate. The buy margin drops to 1.0 for those — the uncertainty is in the ` +
        `number rather than in a constant beside it.`,
    )
  }
  if (supplyPricedOrderValue > 0) {
    notes.push(
      `${supplyPricedOrderValue} keyword(s) priced their order value from the MEDIAN LISTED PRICE ` +
        `in that entity, replacing an inherited site average. Still an estimate — nobody books the ` +
        `median room and it ignores length of stay — but a measured one.`,
    )
  }
  if (supplyBlocked > 0) {
    notes.push(
      `${supplyBlocked} keyword(s) were BLOCKED for having no available supply. Each was a query ` +
        `this plan would otherwise have paid per click for and been unable to fulfil.`,
    )
  }
  if (coverage.size === 0 && considered.length > 0) {
    notes.push(
      'No supply coverage for this site, so no keyword is gated on it. That is the safe state, ' +
        'not a clean bill of health — this plan cannot tell whether it is bidding into empty ' +
        'inventory. Connect a feed with `supply connect`.',
    )
  }

  // --- 2. Allocate, across survivors only ------------------------------------
  const buyable = assessed.filter((a) => a.result.verdict === 'BUY' || a.result.verdict === 'MARGINAL')

  const candidates: AllocationCandidate[] = buyable
    .filter((a) => a.row.bidHighMicros !== null && a.row.volume !== null)
    .map((a) => ({
      keywordNorm: a.row.keywordNorm,
      /**
       * Clicks per day this keyword can absorb.
       *
       * Monthly volume / 30, times a CTR we do NOT have for paid. 5% is a
       * placeholder capacity figure used only to bound allocation — it never
       * enters a break-even or a verdict, and it is not reported as a forecast.
       * Google's own forecast (step 4) is the number to trust for clicks.
       */
      dailyClickCapacity: Math.max(1, ((a.row.volume as number) / 30) * 0.05),
      cpcMicros: bidMicros(a.row.bidHighMicros as Micros, bidFraction),
      marginRatio: a.result.marginRatio ?? 1,
      observedClicks: 0,
      observedConversions: 0,
    }))

  const allocation = allocateBudget(candidates, args.dailyBudgetMicros, {
    ...(args.random === undefined ? {} : { random: args.random }),
    // No single keyword takes more than a quarter of the budget: Zhang et al.
    // find a concentrated constrained budget buys fewer conversions.
    maxPerKeywordMicros: args.dailyBudgetMicros / 4n,
  })
  notes.push(...allocation.notes)
  const allocByKeyword = new Map(allocation.allocations.map((a) => [a.keywordNorm, a]))

  // --- 3. Experiment design, BEFORE launch ----------------------------------
  const clusters = [
    ...new Set(
      considered
        .map((r) => (r.entities as Record<string, string> | null)?.['locality'])
        .filter((x): x is string => typeof x === 'string'),
    ),
  ]
  let arms: ClusterAssignment[] = []
  let experimentFeasible: boolean | null = null
  let experimentVerdict: string | null = null

  if (clusters.length >= 10) {
    arms = assignClusters(clusters, args.random === undefined ? {} : { random: args.random })
    const dailyClicks = allocation.allocations.reduce((a, b) => a + b.clicks, 0)
    const avgCpc =
      candidates.length > 0
        ? candidates.reduce((a, b) => a + Number(b.cpcMicros), 0) / candidates.length
        : 0
    const feas = assessFeasibility({
      baselineConversionBps: args.achievedConversionBps ?? 300,
      minDetectableRelativeLift: args.experiment?.minDetectableRelativeLift ?? 0.2,
      // Half the clicks — only the treatment arm runs ads.
      dailyClicksAvailable: dailyClicks / 2,
      cpcMicros: BigInt(Math.round(avgCpc)),
      maxDays: args.experiment?.maxDays ?? 60,
      budgetMicros: args.dailyBudgetMicros * BigInt(args.experiment?.maxDays ?? 60),
    })
    experimentFeasible = feas.feasible
    experimentVerdict = feas.verdict
    notes.push(
      `Experiment: ${clusters.length} destination clusters, ` +
        `${arms.filter((a) => a.arm === 'treatment').length} treatment. ${feas.verdict}`,
    )
  } else {
    notes.push(
      `Only ${clusters.length} destination cluster(s) — too few to randomise. This plan can be ` +
        `run but its effect cannot be measured, which per plan-paid-search.md §6 means the result ` +
        `will be a last-click number that overstates paid search.`,
    )
  }
  const armByCluster = new Map(arms.map((a) => [a.cluster, a.arm]))

  // --- 4. Google's own forecast, free ---------------------------------------
  let forecast: BuildPlanResult['forecast'] = null
  if (args.forecast && allocation.allocations.length > 0) {
    const f = await fetchCampaignForecast({
      keywords: allocation.allocations.slice(0, 200).map((a) => {
        const row = considered.find((r) => r.keywordNorm === a.keywordNorm)
        return {
          text: a.keywordNorm,
          matchType,
          maxCpcMicros: bidMicros((row?.bidHighMicros ?? 1_000_000n) as Micros, bidFraction),
        }
      }),
      locationCode: space.serpLocationCode,
      languageCode: 'en',
    })
    forecast = { clicks: f.clicks, costMicros: f.costMicros, source: f.source }
    if (f.source === 'skipped') {
      notes.push(
        `Google forecast unavailable: ${f.error}. That is a missing measurement, not a forecast of zero.`,
      )
    }
  }

  // --- 5. Persist ------------------------------------------------------------
  const [plan] = await db
    .insert(adsPlans)
    .values({
      siteId: args.siteId,
      name: args.name,
      status: 'draft',
      // Frozen: the site's numbers will change, and this plan must still be
      // able to explain the break-even figures it reported.
      orderValueMicros: economics.orderValueMicros,
      commissionRateBps: economics.commissionRateBps,
      achievedConversionBps: args.achievedConversionBps,
      dailyBudgetMicros: args.dailyBudgetMicros,
      locationCode: space.serpLocationCode,
      languageCode: 'en',
      forecastClicks: forecast?.clicks ?? null,
      forecastCostMicros: forecast?.costMicros ?? null,
      forecastFetchedAt: forecast && forecast.source === 'google_ads' ? new Date() : null,
      experimentArms: arms.length > 0 ? arms : null,
      experimentFeasible,
      experimentVerdict,
    })
    .returning({ id: adsPlans.id })

  if (!plan) throw new Error('failed to create plan')

  for (const { row, result, resolved } of assessed) {
    const alloc = allocByKeyword.get(row.keywordNorm)
    const cluster = (row.entities as Record<string, string> | null)?.['locality'] ?? null
    await db
      .insert(adsPlanKeywords)
      .values({
        planId: plan.id,
        keywordTargetId: row.id,
        keyword: row.keywordNorm,
        matchType,
        // The grid's pattern label IS the theme. Free, and it is also the level
        // at which rates should later be shrunk (Agarwal et al.).
        adGroup: row.patternLabel ?? row.seedKey ?? 'general',
        volume: row.volume,
        organicPosition: row.position,
        incrementalityBand: result.incrementality?.band ?? null,
        incrementalityBps: result.incrementality?.bps ?? null,
        bidLowMicros: row.bidLowMicros,
        bidHighMicros: row.bidHighMicros,
        maxCpcMicros:
          row.bidHighMicros === null ? null : bidMicros(row.bidHighMicros, bidFraction),
        requiredConversionBpsLow: result.breakEven.requiredConversionBpsLow,
        requiredConversionBpsHigh: result.breakEven.requiredConversionBpsHigh,
        marginRatio: Number.isFinite(result.marginRatio) ? result.marginRatio : null,
        verdict: result.verdict,
        // Provenance appended to the reason, so a row explains its own inputs.
        verdictReason:
          `${result.reason} [commission ${resolved.commissionRateBps.resolvedFrom}` +
          `${resolved.orderValueMicros.inherited ? ', order value inherited' : ''}` +
          `${resolved.conversion ? `, conversion ${resolved.conversion.resolvedFrom} n=${resolved.conversion.clicks}` : ''}]`,
        warnings: result.warnings.length > 0 ? result.warnings : null,
        allocatedClicks: alloc?.clicks ?? null,
        allocatedBudgetMicros: alloc?.budgetMicros ?? null,
        allocationPot: alloc?.pot ?? null,
        experimentArm: cluster ? (armByCluster.get(cluster) ?? null) : null,
        experimentCluster: cluster,
      })
      .onConflictDoNothing()
  }

  return {
    planId: plan.id,
    byVerdict,
    allocatedKeywords: allocation.allocations.length,
    allocatedBudgetMicros: allocation.spentMicros,
    experimentFeasible,
    experimentVerdict,
    forecast,
    notes,
  }
}

function bidMicros(high: Micros, fraction: number): Micros {
  return (high * BigInt(Math.round(fraction * 10_000))) / 10_000n
}

export interface PlanKeywordRow {
  keyword: string
  adGroup: string
  verdict: PaidVerdict | null
  verdictReason: string | null
  volume: number | null
  organicPosition: number | null
  incrementalityBps: number | null
  requiredConversionBpsHigh: number | null
  marginRatio: number | null
  maxCpcMicros: Micros | null
  allocatedBudgetMicros: Micros | null
  experimentArm: string | null
}

export async function listPlanKeywords(
  db: Database,
  planId: number,
  opts: { verdicts?: PaidVerdict[]; limit?: number } = {},
): Promise<PlanKeywordRow[]> {
  const rows = await db
    .select({
      keyword: adsPlanKeywords.keyword,
      adGroup: adsPlanKeywords.adGroup,
      verdict: adsPlanKeywords.verdict,
      verdictReason: adsPlanKeywords.verdictReason,
      volume: adsPlanKeywords.volume,
      organicPosition: adsPlanKeywords.organicPosition,
      incrementalityBps: adsPlanKeywords.incrementalityBps,
      requiredConversionBpsHigh: adsPlanKeywords.requiredConversionBpsHigh,
      marginRatio: adsPlanKeywords.marginRatio,
      maxCpcMicros: adsPlanKeywords.maxCpcMicros,
      allocatedBudgetMicros: adsPlanKeywords.allocatedBudgetMicros,
      experimentArm: adsPlanKeywords.experimentArm,
    })
    .from(adsPlanKeywords)
    .where(eq(adsPlanKeywords.planId, planId))
    .orderBy(desc(adsPlanKeywords.allocatedBudgetMicros), desc(adsPlanKeywords.volume))
    .limit(opts.limit ?? 100)

  if (!opts.verdicts?.length) return rows
  return rows.filter((r) => r.verdict !== null && opts.verdicts!.includes(r.verdict))
}
