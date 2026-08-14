import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { formatMicrosUsd, type Micros } from '@rnr/core'
import type { Database } from '../db.js'
import { adsPlanKeywords, adsPlans, sites } from '../schema.js'
import {
  submitCampaign,
  validateCampaignPlan,
  type AdGroupPlan,
  type CampaignPlan,
  type MutationResult,
  type ResponsiveSearchAd,
} from '../providers/google-ads/campaigns.js'

/**
 * Take a stored plan to Google. Validate-only by default; nothing has launched.
 *
 * ==================== WHAT ACTUALLY STOPS A LAUNCH ====================
 * Four independent conditions, and every one of them must be deliberate:
 *
 *   LIVE_CALLS_ENABLED === 'true'          (the repo-wide spend gate)
 *   GOOGLE_ADS_MUTATIONS_ENABLED === 'true' (a SEPARATE gate — see client.ts)
 *   confirm: true                           (per invocation)
 *   validateOnly: false                     (explicit, and never the default)
 *
 * And two more that hold even when all four are satisfied: the campaign, its ad
 * groups and its ads are created PAUSED, and a daily budget is required rather
 * than defaulted.
 *
 * The default path through this file therefore sends a validate-only mutation,
 * which Google checks in full and applies nothing. That is a free external
 * checkpoint on a request we would otherwise only have our own opinion of.
 * =====================================================================
 */

export interface LaunchResult extends MutationResult {
  planId: number
  campaign: CampaignPlan
  /** True only when a real campaign was created. Currently never. */
  applied: boolean
  notes: string[]
}

export interface BuildCampaignArgs {
  planId: number
  /** Only these verdicts become keywords. BUY alone by default. */
  includeVerdicts?: Array<'BUY' | 'MARGINAL'>
  /** Only this experiment arm. The whole point of assigning arms before launch. */
  arm?: 'treatment' | 'control'
  ads: Record<string, ResponsiveSearchAd> | ResponsiveSearchAd
}

/**
 * Assemble the Google-shaped campaign from a stored plan.
 *
 * Pure with respect to Google — it reads the database and returns a structure.
 * Nothing here can spend money, which is why it is separate from `launchPlan`.
 */
export async function buildCampaignFromPlan(
  db: Database,
  args: BuildCampaignArgs,
): Promise<{ campaign: CampaignPlan; notes: string[] }> {
  const notes: string[] = []
  const [plan] = await db.select().from(adsPlans).where(eq(adsPlans.id, args.planId)).limit(1)
  if (!plan) throw new Error(`No ads plan ${args.planId}`)

  const [site] = await db
    .select({ domain: sites.domain })
    .from(sites)
    .where(eq(sites.id, plan.siteId))
    .limit(1)
  if (!site?.domain) throw new Error(`Plan ${args.planId} belongs to a site with no domain`)

  const verdicts = args.includeVerdicts ?? ['BUY']
  const where = [eq(adsPlanKeywords.planId, args.planId), inArray(adsPlanKeywords.verdict, verdicts)]

  /**
   * ==================== ARM FILTERING IS THE EXPERIMENT ====================
   * Assigning destinations to treatment and control before launch does nothing
   * unless the launch honours it. Without this filter the campaign runs
   * everywhere, the control arm is contaminated, and the only measurement
   * available afterwards is last-click — which Gordon et al. (2019) show does
   * not recover the causal effect.
   */
  if (args.arm) where.push(eq(adsPlanKeywords.experimentArm, args.arm))

  const rows = await db
    .select()
    .from(adsPlanKeywords)
    .where(and(...where))

  if (rows.length === 0) {
    notes.push(
      `No keywords matched verdicts [${verdicts.join(', ')}]${args.arm ? ` in arm "${args.arm}"` : ''}. ` +
        `An empty campaign is a result about the plan, not an error.`,
    )
  }

  if (!args.arm && plan.experimentArms) {
    notes.push(
      'This plan has experiment arms assigned but no arm was requested, so the campaign covers ' +
        'BOTH. The control group would be contaminated and the effect unmeasurable — pass an arm.',
    )
  }

  // Group by the theme the grid already gave us for free.
  const groups = new Map<string, AdGroupPlan>()
  for (const row of rows) {
    const name = row.adGroup
    const existing = groups.get(name)
    const maxCpc = row.maxCpcMicros ?? 1_000_000n
    const keyword = {
      text: row.keyword,
      matchType: row.matchType,
      ...(row.maxCpcMicros === null ? {} : { maxCpcMicros: row.maxCpcMicros }),
    }
    if (existing) {
      existing.keywords.push(keyword)
      if (maxCpc > existing.defaultMaxCpcMicros) existing.defaultMaxCpcMicros = maxCpc
    } else {
      const ad = resolveAd(args.ads, name, site.domain)
      groups.set(name, {
        name,
        defaultMaxCpcMicros: maxCpc,
        keywords: [keyword],
        ads: [ad],
      })
    }
  }

  const campaign: CampaignPlan = {
    name: `${plan.name}${args.arm ? ` [${args.arm}]` : ''}`,
    dailyBudgetMicros: plan.dailyBudgetMicros,
    locationCode: plan.locationCode,
    languageCode: plan.languageCode,
    adGroups: [...groups.values()],
  }

  return { campaign, notes }
}

function resolveAd(
  ads: BuildCampaignArgs['ads'],
  adGroup: string,
  domain: string,
): ResponsiveSearchAd {
  const isMap = ads !== null && typeof ads === 'object' && !('headlines' in ads)
  const chosen = isMap
    ? ((ads as Record<string, ResponsiveSearchAd>)[adGroup] ??
      (ads as Record<string, ResponsiveSearchAd>)['default'])
    : (ads as ResponsiveSearchAd)
  if (!chosen) {
    throw new Error(
      `No ad copy for ad group "${adGroup}". Supply one per group or a "default" — a campaign ` +
        `cannot be assembled from keywords alone.`,
    )
  }
  return { ...chosen, finalUrl: chosen.finalUrl || `https://${domain}/` }
}

/**
 * Send a plan to Google.
 *
 * `validateOnly` defaults TRUE and `confirm` defaults FALSE, so calling this
 * with no options checks the campaign and changes nothing.
 */
export async function launchPlan(
  db: Database,
  args: BuildCampaignArgs & { validateOnly?: boolean; confirm?: boolean },
): Promise<LaunchResult> {
  const { campaign, notes } = await buildCampaignFromPlan(db, args)
  const validateOnly = args.validateOnly ?? true

  const structural = validateCampaignPlan(campaign)
  if (structural.length > 0) {
    return {
      planId: args.planId,
      campaign,
      applied: false,
      validateOnly,
      ok: false,
      resourceNames: [],
      errors: structural,
      operations: [],
      notes,
    }
  }

  const result = await submitCampaign({
    plan: campaign,
    validateOnly,
    confirm: args.confirm === true,
  })

  const applied = !validateOnly && result.ok
  if (applied) {
    /**
     * Recorded only when a campaign genuinely exists. Writing `launched` on a
     * validate-only run would make the database claim a spend that never
     * happened, which is the ledger mistake this repo has already paid for once.
     */
    await db
      .update(adsPlans)
      .set({
        status: 'launched',
        googleCampaignResource: result.resourceNames.find((r) => r.includes('/campaigns/')) ?? null,
        launchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsPlans.id, args.planId))
    notes.push(
      `Campaign created PAUSED. It will spend nothing until a human enables it in the Google Ads UI.`,
    )
  } else if (validateOnly && result.ok) {
    await db
      .update(adsPlans)
      .set({ status: 'validated', updatedAt: new Date() })
      .where(eq(adsPlans.id, args.planId))
    notes.push(
      `Google validated the campaign and applied NOTHING. Daily budget would be ` +
        `${formatMicrosUsd(campaign.dailyBudgetMicros)}.`,
    )
  }

  return { planId: args.planId, campaign, applied, ...result, notes }
}

/** What a plan would cost per day if every allocation ran. Display only. */
export function planDailySpend(rows: Array<{ allocatedBudgetMicros: Micros | null }>): Micros {
  return rows.reduce<Micros>((a, b) => a + (b.allocatedBudgetMicros ?? 0n), 0n)
}
