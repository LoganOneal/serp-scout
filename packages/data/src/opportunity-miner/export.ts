import { stringify } from 'csv-stringify/sync'
import type { Database } from '../db.js'
import { listOpportunityMarkets } from './queries.js'

export async function exportOpportunitiesCsv(db: Database, minScore = 0): Promise<string> {
  const rows = await listOpportunityMarkets(db, { sort: 'score' })
  const filtered = rows.filter((r) => (r.market.scoreOverride ?? r.scores?.totalScore ?? 0) >= minScore)
  return stringify(
    filtered.map((r) => ({
      market: r.market.name,
      slug: r.market.slug,
      score: r.market.scoreOverride ?? r.scores?.totalScore ?? '',
      volume: r.market.adjustedVolume ?? '',
      growth12m: r.market.growth12m ?? '',
      cpc: r.market.weightedCpc ?? '',
      kd: r.market.medianKd ?? '',
      price: r.economics?.observedMedianPrice ?? r.economics?.estimatedMonthlyPriceBase ?? '',
      advertisers: r.market.uniqueAdvertisers,
      cpc_coverage: r.economics?.cpcCoverageBase ?? '',
      serp_weakness: r.market.serpWeakness ?? '',
      type: r.market.businessType,
      status: r.market.status,
      buyer: r.market.buyerType,
    })),
    { header: true },
  )
}
