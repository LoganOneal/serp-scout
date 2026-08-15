import type { KeywordVerdict, KeywordVerdictResult } from '../spaces/keyword-verdict.js'
import type { PaidVerdict, PaidVerdictResult } from '../ads/paid-verdict.js'
import type { SupplyStatusResult } from './coverage.js'

/**
 * Where supply changes an existing decision.
 *
 * ==================== A WRAPPER, NOT A NEW PARAMETER ====================
 * `assessKeyword` and `assessPaidKeyword` are left untouched. Threading supply
 * INTO them would have been tidier to call and much worse to audit: the supply
 * decision would be interleaved with the demand decision inside two already-long
 * branch chains, and the one question an operator asks about a downgraded
 * keyword — "did supply do this, or did the arithmetic?" — would need a reading
 * of the whole function to answer.
 *
 * As a wrapper it is one composition, `gated` is a boolean on the result, and
 * both verdicts stay visible: what the demand model said, and what supply did to
 * it.
 * =====================================================================
 *
 * ==================== UNKNOWN SUPPLY CHANGES NOTHING ====================
 * Every branch below fires ONLY on status 'none' — measured, and zero. On
 * 'unknown' the original verdict is returned byte-for-byte.
 *
 * This is the difference between adding a signal and adding a failure mode. A
 * locality whose listings never resolved to our slug would otherwise be
 * indistinguishable from a locality with no hotels, and an importer bug would
 * silently become a portfolio-wide decision to stop building.
 * =======================================================================
 */

export interface SupplyGatedKeywordVerdict extends KeywordVerdictResult {
  /** What supply said. Always populated, even when it changed nothing. */
  supplyStatus: SupplyStatusResult['status']
  supplyReason: string
  /** True only when supply actually overrode the demand model's answer. */
  gated: boolean
  /** The verdict before supply was applied. Equal to `verdict` when not gated. */
  demandVerdict: KeywordVerdict
  /** Non-blocking observations. Populated where supply is odd but not decisive. */
  supplyWarnings: string[]
}

export function gateKeywordVerdict(
  result: KeywordVerdictResult,
  supply: SupplyStatusResult,
): SupplyGatedKeywordVerdict {
  const base = {
    supplyStatus: supply.status,
    supplyReason: supply.reason,
    demandVerdict: result.verdict,
    supplyWarnings: [] as string[],
  }

  if (supply.stale) {
    base.supplyWarnings.push(
      `Supply coverage is stale — ${supply.reason} A count nobody has refreshed is a claim about ` +
        `the past, not about what is bookable now.`,
    )
  }

  if (supply.status !== 'none') {
    return { ...result, ...base, gated: false }
  }

  /**
   * BUILD is the only verdict supply blocks.
   *
   * DEFEND and IMPROVE describe a page that ALREADY EXISTS and already ranks.
   * Blocking those would tell the operator to stop maintaining a live asset over
   * an inventory number, and the cheap fix there is to list supply, not to
   * abandon the ranking. They get a warning instead, which is the honest weight:
   * a real problem, not a decision.
   */
  if (result.verdict === 'BUILD') {
    return {
      verdict: 'IGNORE',
      reason: `No supply — ${supply.reason} Building a page we cannot fulfil sends a searcher to an empty result set.`,
      missing: [],
      ...base,
      gated: true,
    }
  }

  if (result.verdict === 'DEFEND' || result.verdict === 'IMPROVE') {
    return {
      ...result,
      ...base,
      supplyWarnings: [
        ...base.supplyWarnings,
        `We rank here and have no available supply — ${supply.reason} The ranking is earning ` +
          `nothing. Listing inventory is the cheap fix; abandoning the page is not.`,
      ],
      gated: false,
    }
  }

  return { ...result, ...base, gated: false }
}

export interface SupplyGatedPaidVerdict extends PaidVerdictResult {
  supplyStatus: SupplyStatusResult['status']
  supplyReason: string
  gated: boolean
  demandVerdict: PaidVerdict
}

/**
 * Paid is gated harder than organic, and deliberately so.
 *
 * An organic page built into a supply gap costs a writer's afternoon and can be
 * reused when inventory arrives. A paid click into a supply gap costs money per
 * click, immediately, and buys nothing that survives. So zero supply BLOCKS —
 * the same treatment as an AI Overview, and for the same reason: a structural
 * fact about the query that no amount of favourable arithmetic should override.
 *
 * BLOCKED rather than SKIP, because SKIP means "we did the arithmetic and it
 * does not work". This one never got to the arithmetic.
 */
export function gatePaidVerdict(
  result: PaidVerdictResult,
  supply: SupplyStatusResult,
): SupplyGatedPaidVerdict {
  const base = {
    supplyStatus: supply.status,
    supplyReason: supply.reason,
    demandVerdict: result.verdict,
  }

  if (supply.status !== 'none') {
    if (supply.stale && (result.verdict === 'BUY' || result.verdict === 'MARGINAL')) {
      return {
        ...result,
        warnings: [
          ...result.warnings,
          `Supply coverage is stale — ${supply.reason} This bid is authorised against a count ` +
            `nobody has refreshed.`,
        ],
        ...base,
        gated: false,
      }
    }
    return { ...result, ...base, gated: false }
  }

  return {
    ...result,
    verdict: 'BLOCKED',
    reason: `No supply — ${supply.reason} Paying per click for a query we cannot fulfil buys nothing that survives the click.`,
    marginRatio: null,
    decidedOn: null,
    appliedMargin: null,
    ...base,
    gated: true,
  }
}
