import type { BuyerType, ScenarioTriple, UnitEconomicsInput, UnitEconomicsResult } from './types.js'

export const TARGET_CAC_SHARE: ScenarioTriple = { bear: 0.2, base: 0.3, bull: 0.4 }

export function underwrite(input: UnitEconomicsInput): UnitEconomicsResult {
  const gp = zip3(input.monthlyPrice, input.lifetimeMonths, input.grossMargin, (p, life, m) => p * life * m)
  const cac = zip2(gp, input.targetCacShare, (g, share) => g * share)
  const cpc = zip2(cac, input.clickToPaid, (a, conv) => a * conv)
  const coverage = zip2(cpc, {
    bear: input.observedWeightedCpc ?? 0,
    base: input.observedWeightedCpc ?? 0,
    bull: input.observedWeightedCpc ?? 0,
  }, (sustainable, observed) => (observed > 0 ? sustainable / observed : 0))

  return {
    grossProfitLtv: gp,
    allowableCac: cac,
    sustainableCpc: cpc,
    cpcCoverage: coverage,
  }
}

export interface PricingPriors {
  monthlyPrice: ScenarioTriple
  lifetimeMonths: ScenarioTriple
  grossMargin: ScenarioTriple
  clickToPaid: ScenarioTriple
}

/**
 * Priors used only when no competitor pricing was observed.
 * Labelled weakly_inferred in storage. Observed prices replace monthlyPrice.
 */
export function priorsForBuyer(buyer: BuyerType, recurring: number, oneTimeLikely: boolean): PricingPriors {
  if (oneTimeLikely) {
    return {
      monthlyPrice: { bear: 9, base: 19, bull: 39 },
      lifetimeMonths: { bear: 1, base: 1.4, bull: 2.2 },
      grossMargin: { bear: 0.65, base: 0.75, bull: 0.85 },
      clickToPaid: { bear: 0.008, base: 0.02, bull: 0.04 },
    }
  }

  switch (buyer) {
    case 'enterprise':
    case 'mid_market':
      return {
        monthlyPrice: { bear: 149, base: 299, bull: 599 },
        lifetimeMonths: { bear: 12, base: 24, bull: 36 },
        grossMargin: { bear: 0.7, base: 0.8, bull: 0.88 },
        clickToPaid: { bear: 0.004, base: 0.01, bull: 0.02 },
      }
    case 'SMB':
      return {
        monthlyPrice: { bear: 29, base: 79, bull: 149 },
        lifetimeMonths: { bear: 8, base: 16, bull: 28 },
        grossMargin: { bear: 0.7, base: 0.8, bull: 0.88 },
        clickToPaid: { bear: 0.01, base: 0.025, bull: 0.045 },
      }
    case 'freelancer':
    case 'prosumer':
      return {
        monthlyPrice: { bear: 12, base: 29, bull: 59 },
        lifetimeMonths: { bear: 5, base: 10, bull: 18 },
        grossMargin: { bear: 0.7, base: 0.8, bull: 0.88 },
        clickToPaid: { bear: 0.012, base: 0.028, bull: 0.05 },
      }
    case 'consumer':
    default:
      return {
        monthlyPrice: { bear: 5, base: recurring >= 3 ? 12 : 8, bull: 19 },
        lifetimeMonths: { bear: 2, base: recurring >= 3 ? 8 : 3, bull: recurring >= 3 ? 14 : 5 },
        grossMargin: { bear: 0.65, base: 0.75, bull: 0.85 },
        clickToPaid: { bear: 0.006, base: 0.015, bull: 0.03 },
      }
  }
}

export function applyObservedPrices(
  priors: PricingPriors,
  observed: { low: number | null; median: number | null; high: number | null },
): PricingPriors {
  if (observed.median == null && observed.low == null && observed.high == null) return priors
  return {
    ...priors,
    monthlyPrice: {
      bear: observed.low ?? priors.monthlyPrice.bear,
      base: observed.median ?? observed.low ?? priors.monthlyPrice.base,
      bull: observed.high ?? observed.median ?? priors.monthlyPrice.bull,
    },
  }
}

export interface OrganicEconomics {
  organicClicks: number
  estimatedPaidCustomers: number
  estimatedMonthlyNewLtv: number
}

export function organicEconomics(args: {
  adjustedSearchVolume: number
  estimatedSerpCtr: number
  visitorToPaid: number
  gpLtvBase: number
}): OrganicEconomics {
  const organicClicks = args.adjustedSearchVolume * args.estimatedSerpCtr
  const estimatedPaidCustomers = organicClicks * args.visitorToPaid
  return {
    organicClicks,
    estimatedPaidCustomers,
    estimatedMonthlyNewLtv: estimatedPaidCustomers * args.gpLtvBase,
  }
}

function zip2(a: ScenarioTriple, b: ScenarioTriple, fn: (x: number, y: number) => number): ScenarioTriple {
  return { bear: fn(a.bear, b.bear), base: fn(a.base, b.base), bull: fn(a.bull, b.bull) }
}

function zip3(
  a: ScenarioTriple,
  b: ScenarioTriple,
  c: ScenarioTriple,
  fn: (x: number, y: number, z: number) => number,
): ScenarioTriple {
  return {
    bear: fn(a.bear, b.bear, c.bear),
    base: fn(a.base, b.base, c.base),
    bull: fn(a.bull, b.bull, c.bull),
  }
}
