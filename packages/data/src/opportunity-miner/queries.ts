import { desc, eq, gte, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import {
  omAds,
  omAnomalies,
  omDomains,
  omKeywords,
  omMarketDomains,
  omMarketKeywords,
  omMarketScores,
  omMarkets,
  omOpportunityEconomics,
  omPricingObservations,
  omQueue,
  omRuns,
} from '../schema.js'

export interface MarketListFilters {
  businessType?: string
  buyerType?: string
  ai?: boolean
  minVolume?: number
  maxCpc?: number
  minCpcCoverage?: number
  maxKd?: number
  minGrowth?: number
  minWtp?: number
  minRecurring?: number
  maxBuild?: number
  persistentAdvertisers?: boolean
  weakSerp?: boolean
  status?: string
  anomaly?: string
  sort?: 'score' | 'volume' | 'coverage' | 'growth' | 'serp' | 'monetization'
}

export async function listOpportunityMarkets(db: Database, filters: MarketListFilters = {}) {
  const rows = await db
    .select({
      market: omMarkets,
      scores: omMarketScores,
      economics: omOpportunityEconomics,
    })
    .from(omMarkets)
    .leftJoin(omMarketScores, eq(omMarketScores.marketId, omMarkets.id))
    .leftJoin(omOpportunityEconomics, eq(omOpportunityEconomics.marketId, omMarkets.id))

  let out = rows
  if (filters.businessType) out = out.filter((r) => r.market.businessType === filters.businessType)
  if (filters.buyerType) out = out.filter((r) => r.market.buyerType === filters.buyerType)
  if (filters.status) out = out.filter((r) => r.market.status === filters.status)
  if (filters.minVolume != null) out = out.filter((r) => (r.market.adjustedVolume ?? 0) >= filters.minVolume!)
  if (filters.maxCpc != null) out = out.filter((r) => r.market.weightedCpc == null || r.market.weightedCpc <= filters.maxCpc!)
  if (filters.minCpcCoverage != null) {
    out = out.filter((r) => (r.economics?.cpcCoverageBase ?? 0) >= filters.minCpcCoverage!)
  }
  if (filters.maxKd != null) out = out.filter((r) => r.market.medianKd == null || r.market.medianKd <= filters.maxKd!)
  if (filters.minGrowth != null) out = out.filter((r) => (r.market.growth12m ?? -1) >= filters.minGrowth!)
  if (filters.minWtp != null) out = out.filter((r) => (r.market.willingnessToPay ?? 0) >= filters.minWtp!)
  if (filters.minRecurring != null) out = out.filter((r) => (r.market.recurringUsage ?? 0) >= filters.minRecurring!)
  if (filters.maxBuild != null) out = out.filter((r) => (r.market.buildComplexity ?? 5) <= filters.maxBuild!)
  if (filters.persistentAdvertisers) out = out.filter((r) => r.market.persistentAdvertisers >= 2)
  if (filters.weakSerp) out = out.filter((r) => (r.market.serpWeakness ?? 0) >= 3.2)
  if (filters.ai === true) out = out.filter((r) => /ai/i.test(`${r.market.name} ${r.market.slug}`))
  if (filters.ai === false) out = out.filter((r) => !/ai/i.test(`${r.market.name} ${r.market.slug}`))

  const sort = filters.sort ?? 'score'
  out.sort((a, b) => {
    const av = a.market.scoreOverride ?? a.scores?.totalScore ?? -1
    const bv = b.market.scoreOverride ?? b.scores?.totalScore ?? -1
    if (sort === 'volume') return (b.market.adjustedVolume ?? 0) - (a.market.adjustedVolume ?? 0)
    if (sort === 'coverage') return (b.economics?.cpcCoverageBase ?? 0) - (a.economics?.cpcCoverageBase ?? 0)
    if (sort === 'growth') return (b.market.growth12m ?? -99) - (a.market.growth12m ?? -99)
    if (sort === 'serp') return (b.market.serpWeakness ?? 0) - (a.market.serpWeakness ?? 0)
    if (sort === 'monetization') return (b.scores?.monetizationEvidenceScore ?? 0) - (a.scores?.monetizationEvidenceScore ?? 0)
    return bv - av
  })
  return out
}

export async function getMarketDetail(db: Database, slug: string) {
  const [market] = await db.select().from(omMarkets).where(eq(omMarkets.slug, slug)).limit(1)
  if (!market) return null
  const [scores] = await db.select().from(omMarketScores).where(eq(omMarketScores.marketId, market.id)).limit(1)
  const [economics] = await db.select().from(omOpportunityEconomics).where(eq(omOpportunityEconomics.marketId, market.id)).limit(1)
  const mk = await db.select().from(omMarketKeywords).where(eq(omMarketKeywords.marketId, market.id))
  const keywords = []
  if (mk.length) {
    const { inArray } = await import('drizzle-orm')
    keywords.push(
      ...(await db
        .select()
        .from(omKeywords)
        .where(inArray(omKeywords.id, mk.map((r) => r.keywordId)))),
    )
  }
  keywords.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
  const md = await db.select().from(omMarketDomains).where(eq(omMarketDomains.marketId, market.id))
  const domains = []
  for (const row of md) {
    const [d] = await db.select().from(omDomains).where(eq(omDomains.id, row.domainId)).limit(1)
    if (d) domains.push({ ...d, role: row.role, keywordCount: row.keywordCount })
  }
  const ads = []
  for (const d of domains.slice(0, 8)) {
    ads.push(...(await db.select().from(omAds).where(eq(omAds.domainId, d.id)).limit(5)))
  }
  const anomalies = await db.select().from(omAnomalies).where(eq(omAnomalies.marketId, market.id))
  const prices = await db.select().from(omPricingObservations).where(eq(omPricingObservations.marketId, market.id))
  return { market, scores: scores ?? null, economics: economics ?? null, keywords, domains, ads, anomalies, prices }
}

export async function minerStats(db: Database) {
  const keywordRows = await db.select({ keywords: sql<number>`count(*)` }).from(omKeywords)
  const marketRows = await db.select({ markets: sql<number>`count(*)` }).from(omMarkets)
  const pendingRows = await db.select({ pending: sql<number>`count(*)` }).from(omQueue).where(eq(omQueue.status, 'pending'))
  const highRows = await db
    .select({ high: sql<number>`count(*)` })
    .from(omMarketScores)
    .where(gte(omMarketScores.totalScore, 55))
  const keywords = keywordRows[0]?.keywords
  const markets = marketRows[0]?.markets
  const pending = pendingRows[0]?.pending
  const high = highRows[0]?.high
  const recent = await db.select().from(omRuns).orderBy(desc(omRuns.startedAt)).limit(8)
  return {
    keywords: Number(keywords ?? 0),
    markets: Number(markets ?? 0),
    pending: Number(pending ?? 0),
    highConfidence: Number(high ?? 0),
    recent,
  }
}

export async function listAnomalies(db: Database) {
  return db
    .select({ anomaly: omAnomalies, market: omMarkets })
    .from(omAnomalies)
    .innerJoin(omMarkets, eq(omMarkets.id, omAnomalies.marketId))
    .orderBy(desc(omAnomalies.createdAt))
}

export async function updateMarketReview(
  db: Database,
  slug: string,
  patch: { status?: string; notes?: string; scoreOverride?: number | null; tags?: string[] },
): Promise<void> {
  await db
    .update(omMarkets)
    .set({
      status: patch.status as never,
      notes: patch.notes,
      scoreOverride: patch.scoreOverride,
      tags: patch.tags,
      updatedAt: new Date(),
    })
    .where(eq(omMarkets.slug, slug))
}
