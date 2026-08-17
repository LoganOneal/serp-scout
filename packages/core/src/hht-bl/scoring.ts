const clamp = (value: number): number => Math.max(0, Math.min(100, value))

export interface HhtBlResearchValueInput {
  targetSerpVisibility: number
  transferability: number
  seoEfficiency: number
  businessModelSimilarity: number
  backlinkProfileTractability: number
  /** Explicit deductions, kept individually for audit. */
  penalties?: Record<string, number>
}

export interface HhtBlResearchValueResult {
  score: number
  unpenalizedScore: number
  penaltyTotal: number
  components: Omit<HhtBlResearchValueInput, 'penalties'>
  penalties: Record<string, number>
}

export function scoreHhtBlResearchValue(input: HhtBlResearchValueInput): HhtBlResearchValueResult {
  const components = {
    targetSerpVisibility: clamp(input.targetSerpVisibility),
    transferability: clamp(input.transferability),
    seoEfficiency: clamp(input.seoEfficiency),
    businessModelSimilarity: clamp(input.businessModelSimilarity),
    backlinkProfileTractability: clamp(input.backlinkProfileTractability),
  }
  const unpenalizedScore =
    components.targetSerpVisibility * 0.3 +
    components.transferability * 0.25 +
    components.seoEfficiency * 0.2 +
    components.businessModelSimilarity * 0.15 +
    components.backlinkProfileTractability * 0.1
  const penalties = Object.fromEntries(
    Object.entries(input.penalties ?? {}).map(([name, value]) => [name, Math.max(0, value)]),
  )
  const penaltyTotal = Object.values(penalties).reduce((sum, value) => sum + value, 0)
  return {
    score: clamp(unpenalizedScore - penaltyTotal),
    unpenalizedScore,
    penaltyTotal,
    components,
    penalties,
  }
}

export interface HhtBlOpportunityScoreInput {
  linkValue: number
  gettability: number
  transferability: number
  effort: number
}

export interface HhtBlOpportunityScoreResult extends HhtBlOpportunityScoreInput {
  overallScore: number
  expectedValue: number
}

export function scoreHhtBlOpportunity(
  input: HhtBlOpportunityScoreInput,
): HhtBlOpportunityScoreResult {
  const linkValue = clamp(input.linkValue)
  const gettability = clamp(input.gettability)
  const transferability = clamp(input.transferability)
  const effort = clamp(input.effort)
  const overallScore =
    linkValue * 0.4 + gettability * 0.3 + transferability * 0.2 + (100 - effort) * 0.1

  // Experimental 0-100 score. The effort floor keeps a zero estimate finite,
  // while preserving the multiplicative penalty when any benefit component is low.
  const effortFactor = 0.25 + (effort / 100) * 0.75
  const expectedValue =
    ((linkValue / 100) * (gettability / 100) * (transferability / 100) * 100) /
    effortFactor

  return {
    linkValue,
    gettability,
    transferability,
    effort,
    overallScore: clamp(overallScore),
    expectedValue: clamp(expectedValue),
  }
}

