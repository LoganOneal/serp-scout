import { DEFAULT_ENGINE_CONFIG } from './config.js'
import type { EngineConfig } from './types.js'
import { volumeMidpoint } from './keywords.js'

export interface PriorityInput {
  clusterYield: number
  relevanceScore: number
  verifiedStayCount: number
  sourceYield: number
  novel: boolean
  estimatedUnits: number
  avgMonthlySearches: number | null
  volumeLow: number | null
  volumeHigh: number | null
  volumeIsRange: boolean
  explore: boolean
}

export function footprintFactor(verifiedStayCount: number): number {
  if (verifiedStayCount <= 0) return 0.15
  return Math.log10(verifiedStayCount + 1)
}

export function priorityScore(input: PriorityInput, config: EngineConfig = DEFAULT_ENGINE_CONFIG): number {
  const weights = config.priorityWeights
  const volume = volumeMidpoint(input)
  const score =
    weights.clusterYield * input.clusterYield +
    weights.relevance * input.relevanceScore +
    weights.footprint * footprintFactor(input.verifiedStayCount) +
    weights.sourceYield * input.sourceYield +
    weights.novelty * (input.novel ? 1 : 0) -
    weights.cost * input.estimatedUnits +
    weights.volume * Math.log10(volume + 1)
  return input.explore ? score + weights.novelty : score
}
