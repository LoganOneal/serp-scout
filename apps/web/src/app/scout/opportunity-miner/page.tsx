import Link from 'next/link'
import { Suspense } from 'react'
import { db, listOpportunityMarkets, minerStats, queryOr } from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import { MinerBoard } from '@/components/opportunity-miner/MinerBoard'

export const dynamic = 'force-dynamic'

export default async function OpportunityMinerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const str = (k: string) => {
    const v = sp[k]
    return typeof v === 'string' ? v : undefined
  }
  const num = (k: string) => {
    const v = str(k)
    if (v == null || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }

  const database = db()
  const [stats, rows] = await Promise.all([
    queryOr('minerStats', () => minerStats(database), {
      keywords: 0,
      markets: 0,
      pending: 0,
      highConfidence: 0,
      recent: [],
    }),
    queryOr(
      'listOpportunityMarkets',
      () =>
        listOpportunityMarkets(database, {
          businessType: str('type'),
          buyerType: str('buyer'),
          ai: str('ai') === '1' ? true : str('ai') === '0' ? false : undefined,
          minVolume: num('minVolume'),
          maxCpc: num('maxCpc'),
          minCpcCoverage: num('minCoverage'),
          maxKd: num('maxKd'),
          minGrowth: num('minGrowth') != null ? num('minGrowth')! / 100 : undefined,
          minWtp: num('minWtp'),
          minRecurring: num('minRecurring'),
          maxBuild: num('maxBuild'),
          persistentAdvertisers: str('ads') === '1',
          weakSerp: str('weakSerp') === '1',
          status: str('status'),
          sort: (str('sort') as 'score') ?? 'score',
        }),
      [],
    ),
  ])

  return (
    <div className="opp-workspace om-workspace">
      <div className="run-page-head">
        <PageHeader
          title="Opportunity Miner"
          description="Empirical search-market anomalies — not brainstormed startup ideas. Semrush is evidence. Models only hypothesize."
          actions={
            <Link className="btn" href="/scout/opportunity-miner">
              Reset filters
            </Link>
          }
        />
        <div className="om-hero">
          <div className="om-hero-stat">
            <div className="om-hero-value">{stats.highConfidence}</div>
            <div className="om-hero-label">Promising markets (≥55)</div>
          </div>
          <div className="om-hero-stat">
            <div className="om-hero-value">{stats.markets}</div>
            <div className="om-hero-label">Clustered markets</div>
          </div>
          <div className="om-hero-stat">
            <div className="om-hero-value">{stats.keywords.toLocaleString('en-US')}</div>
            <div className="om-hero-label">Keywords in graph</div>
          </div>
          <div className="om-hero-stat">
            <div className="om-hero-value">{stats.pending}</div>
            <div className="om-hero-label">Queued discovery jobs</div>
          </div>
        </div>
      </div>
      <Suspense fallback={<div className="empty" style={{ padding: 24 }}>Loading markets…</div>}>
      <MinerBoard
        rows={rows.map((r) => ({
          slug: r.market.slug,
          name: r.market.name,
          score: r.market.scoreOverride ?? r.scores?.totalScore ?? null,
          volume: r.market.adjustedVolume,
          growth: r.market.growth12m,
          cpc: r.market.weightedCpc,
          kd: r.market.medianKd,
          price: r.economics?.observedMedianPrice ?? r.economics?.estimatedMonthlyPriceBase ?? null,
          priceObserved: (r.economics?.pricingObservationCount ?? 0) > 0,
          advertisers: r.market.uniqueAdvertisers,
          coverage: r.economics?.cpcCoverageBase ?? null,
          serpWeakness: r.market.serpWeakness,
          type: r.market.businessType,
          status: r.market.status,
          buyer: r.market.buyerType,
          monetization: r.scores?.monetizationEvidenceScore ?? null,
        }))}
      />
      </Suspense>
    </div>
  )
}
