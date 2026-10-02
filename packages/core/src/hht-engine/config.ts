import type { EngineConfig } from './types.js'

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  lowYieldDomainThreshold: 1,
  maxSerpDepth: 100,
  exploreShare: 0.2,
  lowCreditsUnits: 500,
  rankingReverifyDays: 14,
  contactCooldownDays: 90,
  declineCooldownDays: 180,
  linkFarmOutboundLinks: 15,
  llmRelevanceLow: 0.35,
  llmRelevanceHigh: 0.72,
  priorityWeights: {
    clusterYield: 100,
    relevance: 40,
    footprint: 30,
    sourceYield: 25,
    novelty: 20,
    cost: 10,
    volume: 1,
  },
}
