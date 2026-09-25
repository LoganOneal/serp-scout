import {
  HHT_PX_CLUSTER_TOPICAL_FIT,
  HHT_PX_PRIORITY_SCORE,
  type HhtPxCluster,
  type HhtPxCompetitorStrength,
  type HhtPxPageType,
  type HhtPxPriority,
} from './types.js'
import { DESIRABLE_TYPE_SET } from './types.js'
import { defaultClusterPrior } from './classify.js'

export function logDemand(avgMonthlySearches: number | null | undefined): number {
  if (avgMonthlySearches == null || avgMonthlySearches < 0) return 0
  return Math.log1p(avgMonthlySearches)
}

export function normalizeLogDemand(volume: number | null | undefined, maxVolume = 100_000): number {
  const max = logDemand(maxVolume)
  if (max <= 0) return 0
  return Math.max(0, Math.min(100, (logDemand(volume) / max) * 100))
}

export function inventoryFit(args: {
  hotelCount: number | null
  privateHotTubCount: number | null
  sharedHotTubCount: number | null
  editorsChoiceCount: number | null
}): number | null {
  const parts = [
    args.hotelCount,
    args.privateHotTubCount,
    args.sharedHotTubCount,
    args.editorsChoiceCount,
  ].filter((n): n is number => n != null)
  if (parts.length === 0) return null
  const total =
    (args.hotelCount ?? 0) +
    (args.privateHotTubCount ?? 0) * 2 +
    (args.sharedHotTubCount ?? 0) +
    (args.editorsChoiceCount ?? 0) * 3
  if (total <= 0) return 15
  return Math.max(15, Math.min(100, 20 + Math.log1p(total) * 18))
}

export interface KeywordScoreInput {
  prospectableDensity: number | null
  editorialDensity: number | null
  avgMonthlySearches: number | null
  cluster: HhtPxCluster
  inventoryFit: number | null
  uniqueProspectDomains: number | null
  resultCount: number | null
  clusterYield: number | null
  serpChecked: boolean
}

/**
 * Keyword opportunity 0–100. High volume cannot rescue a junk SERP.
 * Missing measurements are dropped and remaining weights renormalized.
 */
export function scoreHhtPxKeyword(input: KeywordScoreInput): number | null {
  if (!input.serpChecked) return null
  const diversity =
    input.resultCount && input.resultCount > 0 && input.uniqueProspectDomains != null
      ? Math.min(100, (input.uniqueProspectDomains / Math.min(input.resultCount, 20)) * 100)
      : null
  return weightedScore([
    { weight: 30, value: pct(input.prospectableDensity) },
    { weight: 20, value: pct(input.editorialDensity) },
    { weight: 20, value: normalizeLogDemand(input.avgMonthlySearches) },
    { weight: 10, value: HHT_PX_CLUSTER_TOPICAL_FIT[input.cluster] },
    { weight: 10, value: input.inventoryFit },
    { weight: 5, value: diversity },
    { weight: 5, value: defaultClusterPrior(input.cluster, input.clusterYield) },
  ])
}

export interface PageScoreInput {
  pageType: HhtPxPageType
  competitorStrength: HhtPxCompetitorStrength
  isProspectable: boolean
  cluster: HhtPxCluster
  keywordOpportunity: number | null
  bestPosition: number | null
  maxKeywordVolume: number | null
  matchedKeywordCount: number
  authorityScore: number | null
  inventoryFit: number | null
  independentPublisher: boolean
}

export function contextualLinkFit(args: {
  pageType: HhtPxPageType
  cluster: HhtPxCluster
  competitorStrength: HhtPxCompetitorStrength
}): number {
  if (!DESIRABLE_TYPE_SET.has(args.pageType)) return 10
  const topical = HHT_PX_CLUSTER_TOPICAL_FIT[args.cluster]
  const typeBoost =
    args.pageType === 'travel_blog'
      ? 12
      : args.pageType === 'local_media' || args.pageType === 'newspaper_travel' || args.pageType === 'national_magazine'
        ? 10
        : args.pageType === 'lifestyle_blog' ||
            args.pageType === 'editorial_travel_site' ||
            args.pageType === 'wedding_honeymoon_site'
          ? 8
          : args.pageType === 'tourism_board' || args.pageType === 'destination_guide'
            ? 6
            : args.pageType === 'independent_hotel_guide'
              ? 3
              : 2
  const competitorPenalty =
    args.competitorStrength === 'direct' ? 40 : args.competitorStrength === 'moderate' ? 18 : args.competitorStrength === 'weak' ? 8 : 0
  return Math.max(0, Math.min(100, topical * 0.7 + typeBoost + 20 - competitorPenalty))
}

export function outreachabilityScore(args: {
  pageType: HhtPxPageType
  independentPublisher: boolean
  competitorStrength: HhtPxCompetitorStrength
}): number {
  let score = args.independentPublisher ? 80 : 40
  if (args.pageType === 'national_magazine' || args.pageType === 'newspaper_travel') score -= 15
  if (args.pageType === 'tourism_board') score += 5
  if (args.competitorStrength === 'direct') score -= 35
  if (args.competitorStrength === 'moderate') score -= 15
  return Math.max(5, Math.min(100, score))
}

export function pageSearchExposure(bestPosition: number | null, volume: number | null): number {
  const position =
    bestPosition == null ? 40 : Math.max(0, Math.min(100, (21 - Math.min(bestPosition, 20)) * 5))
  const demand = normalizeLogDemand(volume)
  return position * 0.6 + demand * 0.4
}

export function scoreHhtPxPage(input: PageScoreInput): number {
  const linkFit = contextualLinkFit(input)
  const outreach = outreachabilityScore(input)
  const exposure = pageSearchExposure(input.bestPosition, input.maxKeywordVolume)
  return weightedScore([
    { weight: 30, value: linkFit },
    { weight: 20, value: outreach },
    { weight: 15, value: input.keywordOpportunity },
    { weight: 15, value: exposure },
    { weight: 10, value: input.authorityScore },
    { weight: 10, value: input.inventoryFit },
  ]) ?? 0
}

export interface DomainScoreInput {
  pageCount: number
  geographyCount: number
  clusterCount: number
  bestPageScore: number | null
  authorityScore: number | null
  organicTraffic: number | null
  competitorStrength: HhtPxCompetitorStrength
  isProspectable: boolean
}

export function scoreHhtPxDomain(input: DomainScoreInput): number {
  const breadth = Math.min(100, input.pageCount * 12 + input.geographyCount * 8 + input.clusterCount * 6)
  const competitorPenalty =
    input.competitorStrength === 'direct' ? 30 : input.competitorStrength === 'moderate' ? 12 : 0
  const traffic = input.organicTraffic == null ? null : Math.min(100, Math.log1p(input.organicTraffic) * 8)
  const base =
    weightedScore([
      { weight: 35, value: input.bestPageScore },
      { weight: 20, value: breadth },
      { weight: 20, value: input.authorityScore },
      { weight: 15, value: traffic },
      { weight: 10, value: input.isProspectable ? 80 : 20 },
    ]) ?? 0
  return Math.max(0, Math.min(100, base - competitorPenalty))
}

export function estimatedNonduplicatedDemand(volumes: readonly (number | null | undefined)[]): number | null {
  const measured = volumes.filter((n): n is number => n != null && n >= 0)
  if (measured.length === 0) return null
  return Math.max(...measured)
}

export function clusterPriorScore(priority: HhtPxPriority): number {
  return HHT_PX_PRIORITY_SCORE[priority]
}

function pct(value: number | null | undefined): number | null {
  if (value == null) return null
  return Math.max(0, Math.min(100, value * 100))
}

function weightedScore(parts: Array<{ weight: number; value: number | null | undefined }>): number | null {
  let weight = 0
  let total = 0
  for (const part of parts) {
    if (part.value == null || !Number.isFinite(part.value)) continue
    weight += part.weight
    total += part.weight * part.value
  }
  if (weight <= 0) return null
  return Math.round((total / weight) * 10) / 10
}

export function expectedProspectsPerSerpCall(args: {
  serpCount: number
  prospectablePages: number
}): number | null {
  if (args.serpCount <= 0) return null
  return args.prospectablePages / args.serpCount
}

export function qualityAdjustedProspectsPerSerpCall(args: {
  serpCount: number
  prospectablePages: number
  avgPageScore: number | null
}): number | null {
  const perCall = expectedProspectsPerSerpCall(args)
  if (perCall == null) return null
  const quality = (args.avgPageScore ?? 50) / 100
  return perCall * quality
}
