import type { AnomalyKind, BuyerType } from './types.js'

export interface AnomalyMarket {
  marketId: number
  weightedCpc: number | null
  medianKd: number | null
  competitorAuthority: number | null
  competitorTraffic: number | null
  persistentAdvertisers: number
  uniqueAdvertisers: number
  serpWeakness: number
  observedMedianPrice: number | null
  growth12m: number | null
  buyerType: BuyerType
  recurringUsage: number
  buildComplexity: number
  cpcCoverageBase: number | null
  adjustedVolume: number | null
  productShapedShare: number
  industry: string | null
  willingnessToPay: number
}

export interface AnomalyHit {
  kind: AnomalyKind
  marketId: number
  why: string
}

export function detectAnomalies(markets: AnomalyMarket[]): AnomalyHit[] {
  const hits: AnomalyHit[] = []
  for (const m of markets) {
    if ((m.weightedCpc ?? 0) >= 4 && (m.medianKd ?? 100) <= 35) {
      hits.push({
        kind: 'high_cpc_low_kd',
        marketId: m.marketId,
        why: `CPC $${(m.weightedCpc ?? 0).toFixed(2)} with median KD ${m.medianKd}`,
      })
    }
    if ((m.competitorAuthority ?? 100) <= 28 && (m.competitorTraffic ?? 0) >= 20_000) {
      hits.push({
        kind: 'tiny_competitors_huge_traffic',
        marketId: m.marketId,
        why: `Authority ${m.competitorAuthority} vs ~${m.competitorTraffic} estimated organic visits (domain_rank proxy)`,
      })
    }
    if (m.persistentAdvertisers >= 3 && m.serpWeakness >= 3.4) {
      hits.push({
        kind: 'persistent_ads_weak_organic',
        marketId: m.marketId,
        why: `${m.persistentAdvertisers} persistent advertisers; SERP weakness ${m.serpWeakness}/5`,
      })
    }
    if ((m.observedMedianPrice ?? 0) >= 79 && (m.weightedCpc ?? 99) > 0 && (m.weightedCpc ?? 99) <= 6) {
      hits.push({
        kind: 'high_pricing_low_cpc',
        marketId: m.marketId,
        why: `Observed ~$${m.observedMedianPrice}/mo vs CPC $${(m.weightedCpc ?? 0).toFixed(2)}`,
      })
    }
    if ((m.growth12m ?? 0) >= 0.2 && m.serpWeakness >= 3.2) {
      hits.push({
        kind: 'fast_growth_weak_incumbents',
        marketId: m.marketId,
        why: `${Math.round((m.growth12m ?? 0) * 100)}% 12m growth with weak incumbents`,
      })
    }
    if (
      ['consumer', 'prosumer', 'freelancer', 'SMB'].includes(m.buyerType) &&
      m.recurringUsage >= 3 &&
      m.buildComplexity <= 3 &&
      (m.cpcCoverageBase ?? 0) >= 1 &&
      (m.adjustedVolume ?? 0) >= 1500
    ) {
      hits.push({
        kind: 'plg_sweet_spot',
        marketId: m.marketId,
        why: `${m.buyerType} self-serve profile with coverage ${(m.cpcCoverageBase ?? 0).toFixed(2)}x`,
      })
    }
    if (m.productShapedShare >= 0.6 && (m.adjustedVolume ?? 0) >= 8000 && m.serpWeakness >= 3.2 && m.buildComplexity <= 2) {
      hits.push({
        kind: 'utility_goldmine',
        marketId: m.marketId,
        why: 'Product-shaped demand, simple build, weak tools in SERP',
      })
    }
    if (
      m.industry &&
      m.recurringUsage >= 4 &&
      m.willingnessToPay >= 4 &&
      (m.observedMedianPrice ?? 0) >= 49 &&
      (m.weightedCpc ?? 0) > 0 &&
      (m.weightedCpc ?? 99) <= 12 &&
      m.serpWeakness >= 2.8
    ) {
      hits.push({
        kind: 'vertical_saas_wedge',
        marketId: m.marketId,
        why: `${m.industry} workflow with high WTP and fragmented competition`,
      })
    }
  }
  return hits
}
