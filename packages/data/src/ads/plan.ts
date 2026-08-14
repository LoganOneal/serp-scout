import 'server-only'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import {
  allocateBudget,
  assessFeasibility,
  assessPaidKeyword,
  assignClusters,
  type AdsMatchType,
  type AllocationCandidate,
  type ClusterAssignment,
  type Micros,
  type PaidVerdict,
} from '@rnr/core'
import type { Database } from '../db.js'
import { adsPlanKeywords, adsPlans, siteKeywordTargets, sites } from '../schema.js'
import { fetchCampaignForecast } from '../providers/google-ads/forecast.js'
import { loadSiteSpace } from '../spaces/research.js'

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

  if (economics.orderValueMicros === null || economics.commissionRateBps === null) {
    notes.push(
      'Order value or commission rate is unset on this site. Break-even cannot be computed, so ' +
        'every keyword will be UNKNOWN — that is the honest output, not a bug.',
    )
  }
  if (args.achievedConversionBps === null) {
    notes.push(
      'No achieved conversion rate supplied. Every verdict will be UNKNOWN: the model compares the ' +
        'REQUIRED rate against one you actually achieve, and inventing the second half would make ' +
        'the first half meaningless.',
    )
  }

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

  // --- 1. Verdict per keyword ------------------------------------------------
  const byVerdict = EMPTY_TALLY()
  const assessed = considered.map((row) => {
    const result = assessPaidKeyword({
      keywordNorm: row.keywordNorm,
      volume: row.volume,
      organicPosition: row.position,
      // The distinction the schema exists for: silence vs never having asked.
      positionMeasured: row.positionMeasuredAt !== null,
      bidLowMicros: row.bidLowMicros,
      bidHighMicros: row.bidHighMicros,
      hasAiOverview: row.hasAiOverview,
      economics,
      achievedConversionBps: args.achievedConversionBps,
      ...(args.brandTerms === undefined ? {} : { brandTerms: args.brandTerms }),
    })
    byVerdict[result.verdict] += 1
    return { row, result }
  })

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

  for (const { row, result } of assessed) {
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
        verdictReason: result.reason,
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
