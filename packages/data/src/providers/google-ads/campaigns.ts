import 'server-only'
import type { AdsMatchType, Micros } from '@rnr/core'
import { googleAdsConfigured, type GoogleAdsEnv } from './keyword-volume.js'
import {
  assertMutationsAllowed,
  googleAdsAccessToken,
  googleAdsApiVersion,
  googleAdsIds,
} from './client.js'

/**
 * Creating a search campaign. Built, gated, and not fired.
 *
 * ==================== FOUR SAFETIES, NOT ONE FLAG ====================
 * 1. TWO env gates. `LIVE_CALLS_ENABLED` AND `GOOGLE_ADS_MUTATIONS_ENABLED`,
 *    both exact-string "true". See client.ts for why one flag is wrong.
 * 2. `--confirm` per invocation. Both gates open is still not an instruction.
 * 3. VALIDATE-ONLY FIRST. Google checks the whole mutation and applies nothing.
 *    That is a real external checkpoint rather than our own opinion of our
 *    request, and it is free.
 * 4. Campaigns are created PAUSED, with a required daily budget. Enabling is a
 *    separate deliberate act by a human in the Google Ads UI.
 *
 * The default path through this file therefore SPENDS NOTHING and CHANGES
 * NOTHING: it builds the operation set, sends it validate-only, and reports what
 * Google said.
 * ====================================================================
 */

export interface CampaignPlan {
  name: string
  /** Required. An uncapped campaign is an uncapped bill. */
  dailyBudgetMicros: Micros
  locationCode: number
  languageCode: string
  adGroups: AdGroupPlan[]
}

export interface AdGroupPlan {
  name: string
  /** Default max CPC for keywords that do not carry their own. */
  defaultMaxCpcMicros: Micros
  keywords: Array<{ text: string; matchType: AdsMatchType; maxCpcMicros?: Micros }>
  ads: ResponsiveSearchAd[]
}

export interface ResponsiveSearchAd {
  /** Google requires 3-15. Validation is done here so a 400 is not the first news. */
  headlines: string[]
  /** Google requires 2-4. */
  descriptions: string[]
  finalUrl: string
  path1?: string
  path2?: string
}

export interface MutationResult {
  /** True when nothing was applied — the default. */
  validateOnly: boolean
  ok: boolean
  /** Resource names Google returned. Empty on a validate-only run. */
  resourceNames: string[]
  errors: string[]
  /** Exactly what would be sent. Printed on a dry run so it is reviewable. */
  operations: unknown[]
}

/**
 * Google bills in whole cents, so every money field must be a multiple of
 * 10,000 micros.
 *
 * ==================== FOUND BY VALIDATE-ONLY, FOR $0 ====================
 * The first validate run returned `VALUE_NOT_MULTIPLE_OF_BILLABLE_UNIT`. Bids
 * are computed as a fraction of Google's top-of-page high — 80% of $25.11 is
 * $20.088, or 20,088,000 micros, which is a multiple of 1,000 and NOT of
 * 10,000. Every derived bid was silently malformed.
 *
 * Rounding DOWN, not to nearest: rounding a bid up spends more than the model
 * said it would, which is the wrong direction for a number that came out of a
 * break-even calculation.
 * =======================================================================
 */
export const BILLABLE_UNIT_MICROS = 10_000n

export function toBillableMicros(m: Micros): Micros {
  if (m <= 0n) return 0n
  return (m / BILLABLE_UNIT_MICROS) * BILLABLE_UNIT_MICROS
}

/** Google's documented limits, checked locally so failures are legible. */
export const RSA_MIN_HEADLINES = 3
export const RSA_MAX_HEADLINES = 15
export const RSA_MAX_HEADLINE_CHARS = 30
export const RSA_MIN_DESCRIPTIONS = 2
export const RSA_MAX_DESCRIPTIONS = 4
export const RSA_MAX_DESCRIPTION_CHARS = 90

/**
 * Structural problems, found before the API call rather than as a 400.
 *
 * Worth doing locally because a rejected mutate on a multi-ad-group plan reports
 * one error and hides the rest, so a bad plan takes as many round trips to fix
 * as it has mistakes.
 */
export function validateCampaignPlan(plan: CampaignPlan): string[] {
  const errors: string[] = []

  if (!plan.name.trim()) errors.push('campaign name is empty')
  if (plan.dailyBudgetMicros <= 0n) {
    errors.push('dailyBudgetMicros must be positive — a campaign without a cap is not plannable')
  }
  if (plan.adGroups.length === 0) errors.push('campaign has no ad groups')

  for (const g of plan.adGroups) {
    if (!g.name.trim()) errors.push('ad group name is empty')
    if (g.keywords.length === 0) errors.push(`ad group "${g.name}" has no keywords`)
    if (g.defaultMaxCpcMicros <= 0n) errors.push(`ad group "${g.name}" has no default max CPC`)

    /**
     * BROAD match silently breaks the model. The break-even figure for a
     * keyword is computed against ITS organic rank, which sets its
     * incrementality band. Broad match spends that budget on queries whose rank
     * was never measured — so the one published coefficient the whole thing is
     * keyed on no longer applies to what is actually being bought.
     */
    for (const k of g.keywords) {
      if (k.matchType === 'BROAD') {
        errors.push(
          `keyword "${k.text}" is BROAD match. Break-even is computed against this keyword's own ` +
            `organic rank; broad match buys queries whose rank was never measured, which voids the ` +
            `incrementality coefficient. Use EXACT or PHRASE.`,
        )
      }
    }

    for (const ad of g.ads) {
      if (ad.headlines.length < RSA_MIN_HEADLINES || ad.headlines.length > RSA_MAX_HEADLINES) {
        errors.push(`ad in "${g.name}" has ${ad.headlines.length} headlines (need 3-15)`)
      }
      if (
        ad.descriptions.length < RSA_MIN_DESCRIPTIONS ||
        ad.descriptions.length > RSA_MAX_DESCRIPTIONS
      ) {
        errors.push(`ad in "${g.name}" has ${ad.descriptions.length} descriptions (need 2-4)`)
      }
      for (const h of ad.headlines) {
        if (h.length > RSA_MAX_HEADLINE_CHARS) {
          errors.push(`headline over ${RSA_MAX_HEADLINE_CHARS} chars: "${h}"`)
        }
      }
      for (const d of ad.descriptions) {
        if (d.length > RSA_MAX_DESCRIPTION_CHARS) {
          errors.push(`description over ${RSA_MAX_DESCRIPTION_CHARS} chars: "${d}"`)
        }
      }
      if (!/^https?:\/\//i.test(ad.finalUrl)) {
        errors.push(`final URL is not absolute: "${ad.finalUrl}"`)
      }
    }
    if (g.ads.length === 0) errors.push(`ad group "${g.name}" has no ads`)
  }

  return errors
}

/**
 * Build the mutate operation set. Pure — no network, no gates, no side effects.
 *
 * Separated so a dry run can print exactly what would be sent, and so the shape
 * is testable without credentials. Temporary negative resource ids are how the
 * Google Ads API references objects created in the same request.
 */
export function buildCampaignOperations(
  plan: CampaignPlan,
  customerId: string,
): unknown[] {
  const c = `customers/${customerId}`
  const budgetId = -1
  const campaignId = -2
  const ops: unknown[] = []

  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: `${c}/campaignBudgets/${budgetId}`,
        name: `${plan.name} budget`,
        amountMicros: String(toBillableMicros(plan.dailyBudgetMicros)),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    },
  })

  ops.push({
    campaignOperation: {
      create: {
        resourceName: `${c}/campaigns/${campaignId}`,
        name: plan.name,
        /**
         * PAUSED, always, with no option to override from here.
         *
         * Enabling a campaign is a decision a human makes in the Google Ads UI
         * with the plan in front of them. A flag that could create an ENABLED
         * campaign would make "spend money now" reachable from a typo.
         */
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: `${c}/campaignBudgets/${budgetId}`,
        manualCpc: { enhancedCpcEnabled: false },
        /**
         * REQUIRED on create since the EU Political Ads Regulation. Google
         * rejects the whole mutation without it, and the error names a field
         * nothing in the docs' examples mentions.
         *
         * Found by the first validate-only run. `false` is a factual declaration
         * about hotel and supplement affiliate ads, not a default — and it is
         * hardcoded rather than exposed as an option precisely because anything
         * this repo plans is covered by it.
         */
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        /** Search only. Display and partners are a different auction we did not model. */
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: false,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        },
      },
    },
  })

  ops.push({
    campaignCriterionOperation: {
      create: {
        campaign: `${c}/campaigns/${campaignId}`,
        location: { geoTargetConstant: `geoTargetConstants/${plan.locationCode}` },
      },
    },
  })

  ops.push({
    campaignCriterionOperation: {
      create: {
        campaign: `${c}/campaigns/${campaignId}`,
        language: { languageConstant: `languageConstants/1000` },
      },
    },
  })

  let nextId = -3
  for (const group of plan.adGroups) {
    const groupId = nextId--
    ops.push({
      adGroupOperation: {
        create: {
          resourceName: `${c}/adGroups/${groupId}`,
          name: group.name,
          campaign: `${c}/campaigns/${campaignId}`,
          status: 'PAUSED',
          type: 'SEARCH_STANDARD',
          cpcBidMicros: String(toBillableMicros(group.defaultMaxCpcMicros)),
        },
      },
    })

    for (const k of group.keywords) {
      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: `${c}/adGroups/${groupId}`,
            status: 'ENABLED',
            keyword: { text: k.text, matchType: k.matchType },
            ...(k.maxCpcMicros === undefined
              ? {}
              : { cpcBidMicros: String(toBillableMicros(k.maxCpcMicros)) }),
          },
        },
      })
    }

    for (const ad of group.ads) {
      ops.push({
        adGroupAdOperation: {
          create: {
            adGroup: `${c}/adGroups/${groupId}`,
            status: 'PAUSED',
            ad: {
              finalUrls: [ad.finalUrl],
              responsiveSearchAd: {
                headlines: ad.headlines.map((text) => ({ text })),
                descriptions: ad.descriptions.map((text) => ({ text })),
                ...(ad.path1 === undefined ? {} : { path1: ad.path1 }),
                ...(ad.path2 === undefined ? {} : { path2: ad.path2 }),
              },
            },
          },
        },
      })
    }
  }

  return ops
}

/**
 * Send the plan to Google.
 *
 * `validateOnly` DEFAULTS TO TRUE. Google checks everything and applies
 * nothing, which is a free external checkpoint on a request we would otherwise
 * only have our own opinion about.
 *
 * Setting it false requires both env gates and `confirm` — see
 * assertMutationsAllowed. Nothing in this repo calls it that way.
 */
export async function submitCampaign(args: {
  plan: CampaignPlan
  validateOnly?: boolean
  confirm?: boolean
  env?: GoogleAdsEnv
  fetchImpl?: typeof fetch
}): Promise<MutationResult> {
  const env = args.env ?? process.env
  const fetchImpl = args.fetchImpl ?? fetch
  const validateOnly = args.validateOnly ?? true

  const errors = validateCampaignPlan(args.plan)
  const { customerId, loginCustomerId } = googleAdsIds(env)
  const operations = buildCampaignOperations(args.plan, customerId || 'UNSET')

  if (errors.length > 0) {
    return { validateOnly, ok: false, resourceNames: [], errors, operations }
  }

  if (!validateOnly) {
    // Throws unless BOTH gates are open AND confirm was passed.
    assertMutationsAllowed({
      confirm: args.confirm === true,
      env,
      what: `create Google Ads campaign "${args.plan.name}"`,
    })
  }

  if (!googleAdsConfigured(env)) {
    return {
      validateOnly,
      ok: false,
      resourceNames: [],
      errors: ['google ads not configured'],
      operations,
    }
  }

  try {
    const token = await googleAdsAccessToken(env, fetchImpl)
    const version = googleAdsApiVersion(env)

    const res = await fetchImpl(
      `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:mutate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']!.trim(),
          'login-customer-id': loginCustomerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mutateOperations: operations,
          validateOnly,
          /** All-or-nothing. A half-created campaign is worse than none. */
          partialFailure: false,
        }),
      },
    )

    const text = await res.text()
    if (!res.ok) {
      return {
        validateOnly,
        ok: false,
        resourceNames: [],
        // 4000, not 600: the first validate run returned two distinct errors and
        // the truncation hid the second one's field path, which was the one that
        // mattered. A validate-only response is the cheapest debugging there is;
        // clipping it wastes the point of running it.
        errors: [`${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 4000)}`],
        operations,
      }
    }

    const json = JSON.parse(text) as {
      mutateOperationResponses?: Array<Record<string, { resourceName?: string }>>
    }
    const resourceNames: string[] = []
    for (const r of json.mutateOperationResponses ?? []) {
      for (const v of Object.values(r)) {
        if (v?.resourceName) resourceNames.push(v.resourceName)
      }
    }

    return { validateOnly, ok: true, resourceNames, errors: [], operations }
  } catch (e) {
    return {
      validateOnly,
      ok: false,
      resourceNames: [],
      errors: [(e as Error).message],
      operations,
    }
  }
}
