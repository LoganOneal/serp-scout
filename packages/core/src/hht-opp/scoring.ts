import { DEFAULT_HHT_OPP_SCORE_WEIGHTS, type HhtOppEligibility, type HhtOppLinkType, type HhtOppQuality, type HhtOppScoreWeights, type HhtOppSeoRisk, type HhtOppType } from './types.js'

export interface HhtOppFeasibilityInput {
  eligibility: HhtOppEligibility
  hasSubmissionRoute: boolean
  linkType: HhtOppLinkType
  topicalFit: number
  pitchClarity: number
  evidenceConfidence: number
  freshnessDays: number | null
  mentionPriority?: boolean
}

export interface HhtOppSeoValueInput {
  authorityScore: number | null
  referringDomains: number | null
  organicTraffic: number | null
  topicalRelevance: number
  usTrafficShare: number | null
  linkType: HhtOppLinkType
  avgExternalLinks: number | null
  seoRisk: HhtOppSeoRisk
  quality: HhtOppQuality
  competitorLinkCount?: number | null
}

export interface CostEfficiencyInput {
  priceAmount: number | null
  seoValue: number
  isPaid: boolean
}

export interface OverallInput {
  seoValue: number
  feasibility: number
  topicalRelevance: number
  editorialQuality: number
  costEfficiency: number
  freshness: number
  weights?: HhtOppScoreWeights
}

export interface ScoreBreakdown {
  feasibility: number
  seoValue: number
  topicalRelevance: number
  editorialQuality: number
  costEfficiency: number
  freshness: number
  overall: number
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

function scale(value: number | null, lo: number, hi: number): number {
  if (value == null || !Number.isFinite(value)) return 0
  return clamp(((value - lo) / (hi - lo)) * 100)
}

export function scoreFeasibility(input: HhtOppFeasibilityInput): number {
  let score = 35
  if (input.eligibility === 'PASS') score += 28
  else if (input.eligibility === 'REVIEW') score += 8
  else score -= 25

  if (input.hasSubmissionRoute) score += 12
  if (input.linkType === 'prohibited') score -= 30
  else if (input.linkType !== 'unknown') score += 8

  score += input.topicalFit * 0.12
  score += input.pitchClarity * 0.08
  score += input.evidenceConfidence * 0.1

  if (input.freshnessDays != null) {
    if (input.freshnessDays <= 14) score += 6
    else if (input.freshnessDays <= 30) score += 3
    else if (input.freshnessDays > 90) score -= 8
  }
  if (input.mentionPriority) score += 18

  return clamp(score)
}

export function scoreSeoValue(input: HhtOppSeoValueInput): number {
  const authority = scale(input.authorityScore, 5, 70)
  const refs = scale(input.referringDomains, 20, 8_000)
  const traffic = scale(input.organicTraffic, 200, 250_000)
  let score = 0.35 * authority + 0.25 * refs + 0.2 * traffic + 0.2 * input.topicalRelevance

  if (input.linkType.includes('dofollow') && input.linkType.includes('contextual')) score += 8
  else if (input.linkType.includes('dofollow')) score += 4
  else if (input.linkType.includes('nofollow') || input.linkType.includes('sponsored')) score -= 6
  else if (input.linkType === 'prohibited') score -= 20

  if ((input.avgExternalLinks ?? 0) >= 20) score -= 10
  else if ((input.avgExternalLinks ?? 0) >= 12) score -= 4

  if (input.seoRisk === 'HIGH') score -= 22
  else if (input.seoRisk === 'MEDIUM') score -= 8

  if (input.quality === 'POSSIBLE_LINK_FARM') score *= 0.35
  else if (input.quality === 'LOW_QUALITY') score *= 0.55

  if (input.usTrafficShare != null) score = score * (0.7 + 0.3 * clamp(input.usTrafficShare, 0, 1))

  if ((input.competitorLinkCount ?? 0) >= 3) score += 14
  else if ((input.competitorLinkCount ?? 0) >= 2) score += 10

  if (input.authorityScore == null && input.organicTraffic == null && input.referringDomains == null) {
    return clamp(0.45 * input.topicalRelevance + ((input.competitorLinkCount ?? 0) >= 2 ? 8 : 0))
  }
  return clamp(score)
}

export function scoreCostEfficiency(input: CostEfficiencyInput): number {
  if (!input.isPaid) return 70
  if (input.priceAmount == null) return 40
  if (input.priceAmount <= 0) return 70
  const valuePerDollar = input.seoValue / input.priceAmount
  return clamp(scale(valuePerDollar, 0.02, 0.8))
}

export function scoreFreshness(days: number | null): number {
  if (days == null) return 40
  if (days <= 7) return 100
  if (days <= 14) return 85
  if (days <= 30) return 70
  if (days <= 60) return 50
  return 25
}

export function scoreOverall(input: OverallInput): number {
  const w = input.weights ?? DEFAULT_HHT_OPP_SCORE_WEIGHTS
  const total = w.seoValue + w.feasibility + w.topicalRelevance + w.editorialQuality + w.costEfficiency + w.freshness
  const n = total > 0 ? total : 1
  return clamp(
    (w.seoValue * input.seoValue +
      w.feasibility * input.feasibility +
      w.topicalRelevance * input.topicalRelevance +
      w.editorialQuality * input.editorialQuality +
      w.costEfficiency * input.costEfficiency +
      w.freshness * input.freshness) /
      n,
  )
}

export function topicalRelevanceFor(type: HhtOppType, pageText: string): number {
  const blob = pageText.toLowerCase()
  let score = 20
  const hits = [
    'hotel',
    'travel',
    'honeymoon',
    'romantic',
    'hospitality',
    'getaway',
    'jacuzzi',
    'hot tub',
    'whirlpool',
    'suite',
  ]
  for (const term of hits) {
    if (blob.includes(term)) score += 8
  }
  if (type === 'unlinked_mention') score += 20
  if (type === 'existing_article' || type === 'resource_page') score += 8
  return clamp(score)
}

export function editorialQualityScore(input: {
  hasAuthors?: boolean
  hasDates?: boolean
  avgExternalLinks?: number | null
  quality: HhtOppQuality
}): number {
  let score = 50
  if (input.hasAuthors) score += 12
  if (input.hasDates) score += 8
  if ((input.avgExternalLinks ?? 0) <= 6) score += 10
  else if ((input.avgExternalLinks ?? 0) >= 18) score -= 15
  if (input.quality === 'POSSIBLE_LINK_FARM') score = 12
  else if (input.quality === 'LOW_QUALITY') score = 28
  return clamp(score)
}

export function scoreOpportunity(args: {
  feasibility: HhtOppFeasibilityInput
  seo: HhtOppSeoValueInput
  cost: CostEfficiencyInput
  editorial: Parameters<typeof editorialQualityScore>[0]
  freshnessDays: number | null
  weights?: HhtOppScoreWeights
}): ScoreBreakdown {
  const feasibility = scoreFeasibility(args.feasibility)
  const seoValue = scoreSeoValue(args.seo)
  const topicalRelevance = args.seo.topicalRelevance
  const editorialQuality = editorialQualityScore(args.editorial)
  const costEfficiency = scoreCostEfficiency({ ...args.cost, seoValue })
  const freshness = scoreFreshness(args.freshnessDays)
  return {
    feasibility,
    seoValue,
    topicalRelevance,
    editorialQuality,
    costEfficiency,
    freshness,
    overall: scoreOverall({
      seoValue,
      feasibility,
      topicalRelevance,
      editorialQuality,
      costEfficiency,
      freshness,
      weights: args.weights,
    }),
  }
}

export function normalizeWeights(weights: HhtOppScoreWeights): HhtOppScoreWeights {
  const entries = Object.entries(weights) as Array<[keyof HhtOppScoreWeights, number]>
  const total = entries.reduce((sum, [, value]) => sum + (Number.isFinite(value) ? value : 0), 0)
  if (total <= 0) return { ...DEFAULT_HHT_OPP_SCORE_WEIGHTS }
  const next = { ...DEFAULT_HHT_OPP_SCORE_WEIGHTS }
  for (const [key, value] of entries) next[key] = (Number.isFinite(value) ? value : 0) / total
  return next
}
