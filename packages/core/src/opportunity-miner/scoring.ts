import { evaluateGarbage, type GarbageInput } from './garbage.js'
import { clamp, scale01 } from './normalize.js'
import {
  DEFAULT_SCORE_WEIGHTS,
  type BuyerType,
  type MarketScoreBreakdown,
  type ScoreWeights,
} from './types.js'

export interface ScoreInput {
  adjustedVolume: number | null
  weightedCpc: number | null
  weightedKd: number | null
  medianKd: number | null
  commercialVolumeShare: number | null
  highIntentVolumeShare: number | null
  uniqueAdvertisers: number
  persistentAdvertisers: number
  observedPriceCount: number
  observedMedianPrice: number | null
  cpcCoverageBase: number | null
  cpcCoverageBear: number | null
  gpLtvBase: number | null
  recurringUsage: number
  willingnessToPay: number
  expansionPotential: number
  serpWeakness: number
  competitorAuthority: number | null
  growth12m: number | null
  buildComplexity: number
  buyerType: BuyerType
  garbage: GarbageInput
  weights?: ScoreWeights
}

/**
 * Component scores are 0–100 and stored separately.
 * Total is a weighted blend, then garbage-multiplied. Never the only stored number.
 */
export function scoreMarket(input: ScoreInput): MarketScoreBreakdown {
  const weights = input.weights ?? DEFAULT_SCORE_WEIGHTS
  const demandScore = 100 * scale01(input.adjustedVolume, 250, 18_000)
  const commercialIntentScore =
    100 *
    clamp(
      0.45 * (input.commercialVolumeShare ?? 0) +
        0.35 * (input.highIntentVolumeShare ?? 0) +
        0.2 * scale01(input.weightedCpc, 0.3, 10),
      0,
      1,
    )

  const monetizationEvidenceScore = monetizationEvidence(input)
  const willingnessToPayScore = 20 * clamp(input.willingnessToPay, 1, 5)
  const recurringUsageScore = 20 * clamp(input.recurringUsage, 1, 5)
  const expansionScore = 20 * clamp(input.expansionPotential, 1, 5)

  const kd = input.medianKd ?? input.weightedKd
  const seoAccessibilityScore =
    100 *
    clamp(
      0.45 * (1 - scale01(kd, 15, 75)) + 0.55 * clamp(input.serpWeakness / 5, 0, 1),
      0,
      1,
    )

  const paidAcquisitionScore =
    100 *
    clamp(
      0.55 * scale01(input.cpcCoverageBase, 0.4, 2.5) +
        0.25 * scale01(input.cpcCoverageBear, 0.3, 1.4) +
        0.2 * scale01(input.uniqueAdvertisers, 0, 8),
      0,
      1,
    )

  const competitorWeaknessScore =
    100 *
    clamp(
      0.6 * clamp(input.serpWeakness / 5, 0, 1) +
        0.4 * (1 - scale01(input.competitorAuthority, 15, 80)),
      0,
      1,
    )

  const growthScore = 100 * scale01(input.growth12m, -0.15, 0.6)
  const buildFeasibilityScore = 100 * (1 - (clamp(input.buildComplexity, 1, 5) - 1) / 4)

  const unitEconomicsBlend =
    100 *
    clamp(
      0.4 * scale01(input.cpcCoverageBase, 0.5, 2.2) +
        0.25 * scale01(input.cpcCoverageBear, 0.4, 1.3) +
        0.2 * scale01(input.gpLtvBase, 40, 1500) +
        0.15 * scale01(input.observedMedianPrice, 9, 149),
      0,
      1,
    )

  const rawTotal =
    weights.monetizationEvidence * monetizationEvidenceScore +
    weights.unitEconomics * unitEconomicsBlend +
    weights.searchDemand * demandScore +
    weights.competitiveAccessibility * (0.55 * seoAccessibilityScore + 0.45 * competitorWeaknessScore) +
    weights.recurringRetention * recurringUsageScore +
    weights.growth * growthScore +
    weights.buildFeasibility * buildFeasibilityScore

  const garbage = evaluateGarbage(input.garbage)
  const totalScore = Math.round(clamp(rawTotal * garbage.scoreMultiplier, 0, 100) * 10) / 10

  return {
    demandScore: rnd(demandScore),
    commercialIntentScore: rnd(commercialIntentScore),
    monetizationEvidenceScore: rnd(monetizationEvidenceScore),
    willingnessToPayScore: rnd(willingnessToPayScore),
    recurringUsageScore: rnd(recurringUsageScore),
    expansionScore: rnd(expansionScore),
    seoAccessibilityScore: rnd(seoAccessibilityScore),
    paidAcquisitionScore: rnd(paidAcquisitionScore),
    competitorWeaknessScore: rnd(competitorWeaknessScore),
    growthScore: rnd(growthScore),
    buildFeasibilityScore: rnd(buildFeasibilityScore),
    totalScore,
  }
}

function monetizationEvidence(input: ScoreInput): number {
  const persistent = scale01(input.persistentAdvertisers, 0, 6)
  const advertisers = scale01(input.uniqueAdvertisers, 0, 10)
  const pricing = scale01(input.observedPriceCount, 0, 4)
  const commercial = input.commercialVolumeShare ?? 0
  const cpc = scale01(input.weightedCpc, 0.5, 12)
  return (
    100 *
    clamp(0.28 * persistent + 0.22 * advertisers + 0.2 * pricing + 0.18 * commercial + 0.12 * cpc, 0, 1)
  )
}

function rnd(n: number): number {
  return Math.round(n * 10) / 10
}

export function inferBuyerType(args: {
  industry: string | null
  persona: string | null
  archetype: string | null
  keywords: string[]
}): BuyerType {
  const blob = `${args.industry ?? ''} ${args.persona ?? ''} ${args.keywords.join(' ')}`.toLowerCase()
  if (/(enterprise|mid-market|mid market)/.test(blob)) return 'enterprise'
  if (
    /(contractor|roofer|roofing|dentist|lawyer|realtor|hvac|plumber|plumbing|salon|restaurant|trucking|clinic|estimat|proposal)/.test(
      blob,
    )
  ) {
    return 'SMB'
  }
  if (/(freelancer|photographer|designer|creator|youtuber|coach)/.test(blob)) return 'freelancer'
  if (/(prosumer|small business|smb|agency)/.test(blob)) return 'prosumer'
  if (args.archetype && ['software', 'platform', 'crm', 'automation'].includes(args.archetype)) {
    return blob.includes('for') ? 'SMB' : 'prosumer'
  }
  return 'consumer'
}

export function inferWillingnessToPay(args: {
  buyer: BuyerType
  recurring: number
  weightedCpc: number | null
  observedMedianPrice: number | null
  workflow: string | null
}): number {
  let score = 2
  if (args.buyer === 'SMB' || args.buyer === 'mid_market') score += 1
  if (args.buyer === 'enterprise') score += 1
  if (args.recurring >= 4) score += 1
  if ((args.weightedCpc ?? 0) >= 4) score += 1
  if ((args.observedMedianPrice ?? 0) >= 49) score += 1
  if (args.workflow && /(estimat|quot|invoic|payroll|crm|proposal)/.test(args.workflow)) score += 1
  if (args.buyer === 'consumer' && args.recurring <= 2) score -= 1
  return clamp(score, 1, 5)
}

export function inferExpansionPotential(args: { workflow: string | null; industry: string | null }): number {
  if (args.workflow && /(estimat|quot|proposal|invoic|crm|schedul)/.test(args.workflow) && args.industry) {
    return 5
  }
  if (args.industry) return 4
  if (args.workflow && /(track|plan|automat)/.test(args.workflow)) return 3
  return 2
}
