import { eq } from 'drizzle-orm'
import {
  applyObservedPrices,
  detectAnomalies,
  estimateBuildFeasibility,
  evaluateGarbage,
  isMajorPlatformOwned,
  isProductShaped,
  organicEconomics,
  priorsForBuyer,
  scoreMarket,
  TARGET_CAC_SHARE,
  underwrite,
  type AnomalyMarket,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  omAnomalies,
  omKeywordDomains,
  omMarketKeywords,
  omMarketScores,
  omMarkets,
  omOpportunityEconomics,
  omPricingObservations,
} from '../schema.js'
import { omLog } from './log.js'
import { omKeywords } from '../schema.js'

export async function scoreAllMarkets(db: Database): Promise<{ scored: number; anomalies: number }> {
  const markets = await db.select().from(omMarkets)
  let scored = 0
  const anomalyInputs: AnomalyMarket[] = []

  for (const market of markets) {
    const mk = await db.select().from(omMarketKeywords).where(eq(omMarketKeywords.marketId, market.id))
    const allKw = []
    if (mk.length) {
      const { inArray } = await import('drizzle-orm')
      allKw.push(
        ...(await db
          .select()
          .from(omKeywords)
          .where(inArray(omKeywords.id, mk.map((r) => r.keywordId)))),
      )
    }

    const prices = await db.select().from(omPricingObservations).where(eq(omPricingObservations.marketId, market.id))
    const observed = prices
      .map((p) => p.popularPlan ?? p.cheapestPaid ?? p.highestSelfServe)
      .filter((n): n is number => n != null)
    const observedMedian = observed.length ? observed.slice().sort((a, b) => a - b)[Math.floor(observed.length / 2)]! : null
    const observedLow = observed.length ? Math.min(...observed) : null
    const observedHigh = observed.length ? Math.max(...observed) : null

    const oneTime = allKw.filter((k) => /(name|headshot|logo|avatar|quiz)/.test(k.keyword)).length >= Math.max(1, allKw.length * 0.4)
    const priors = applyObservedPrices(priorsForBuyer(market.buyerType, market.recurringUsage ?? 3, oneTime), {
      low: observedLow,
      median: observedMedian,
      high: observedHigh,
    })
    const econ = underwrite({
      monthlyPrice: priors.monthlyPrice,
      lifetimeMonths: priors.lifetimeMonths,
      grossMargin: priors.grossMargin,
      clickToPaid: priors.clickToPaid,
      targetCacShare: TARGET_CAC_SHARE,
      observedWeightedCpc: market.weightedCpc,
    })

    const feasibility = estimateBuildFeasibility({
      keywords: allKw.map((k) => k.keyword),
      archetype: null,
      industry: market.likelyCustomer,
      monetization: market.monetizationModel,
    })

    const links = await db.select().from(omKeywordDomains)
    const memberKwIds = new Set(mk.map((r) => r.keywordId))
    const memberLinks = links.filter((l) => memberKwIds.has(l.keywordId))
    const { omDomains } = await import('../schema.js')
    const domainIds = [...new Set(memberLinks.map((l) => l.domainId))]
    const domains = domainIds.length ? await db.select().from(omDomains) : []
    const relevant = domains.filter((d) => domainIds.includes(d.id))
    const competitorAuth = median(relevant.map((d) => d.authorityScore).filter((n): n is number => n != null))
    const competitorTraffic = Math.max(0, ...relevant.map((d) => d.estimatedOrganicTraffic ?? 0))
    const platformOwned = isMajorPlatformOwned(
      relevant.map((d) => ({
        domain: d.domain,
        position: memberLinks.find((l) => l.domainId === d.id)?.position ?? null,
        classification: d.classification,
      })),
    )

    const garbage = evaluateGarbage({
      keywords: allKw.map((k) => k.keyword),
      brandedShare: market.brandedShare,
      uniqueAdvertisers: market.uniqueAdvertisers,
      observedPriceCount: observed.length,
      weightedCpc: market.weightedCpc,
      majorPlatformOwned: platformOwned,
    })

    const scores = scoreMarket({
      adjustedVolume: market.adjustedVolume,
      weightedCpc: market.weightedCpc,
      weightedKd: market.weightedKd,
      medianKd: market.medianKd,
      commercialVolumeShare:
        market.adjustedVolume && market.adjustedVolume > 0 ? (market.commercialVolume ?? 0) / market.adjustedVolume : 0,
      highIntentVolumeShare:
        market.adjustedVolume && market.adjustedVolume > 0 ? (market.highIntentVolume ?? 0) / market.adjustedVolume : 0,
      uniqueAdvertisers: market.uniqueAdvertisers,
      persistentAdvertisers: market.persistentAdvertisers,
      observedPriceCount: observed.length,
      observedMedianPrice: observedMedian,
      cpcCoverageBase: econ.cpcCoverage.base,
      cpcCoverageBear: econ.cpcCoverage.bear,
      gpLtvBase: econ.grossProfitLtv.base,
      recurringUsage: market.recurringUsage ?? 3,
      willingnessToPay: market.willingnessToPay ?? 3,
      expansionPotential: market.expansionPotential ?? 3,
      serpWeakness: market.serpWeakness ?? 0,
      competitorAuthority: competitorAuth,
      growth12m: market.growth12m,
      buildComplexity: feasibility.complexity,
      buyerType: market.buyerType,
      garbage: {
        keywords: allKw.map((k) => k.keyword),
        brandedShare: market.brandedShare,
        uniqueAdvertisers: market.uniqueAdvertisers,
        observedPriceCount: observed.length,
        weightedCpc: market.weightedCpc,
        majorPlatformOwned: platformOwned,
      },
    })

    const org = organicEconomics({
      adjustedSearchVolume: market.adjustedVolume ?? 0,
      estimatedSerpCtr: 0.12,
      visitorToPaid: priors.clickToPaid.base,
      gpLtvBase: econ.grossProfitLtv.base,
    })
    const seoEconomicScore =
      (market.adjustedVolume ?? 0) > 2000 && econ.grossProfitLtv.base > 80 && (market.serpWeakness ?? 0) >= 3
        ? Math.min(100, org.estimatedMonthlyNewLtv / 50)
        : Math.min(70, org.estimatedMonthlyNewLtv / 80)

    await db
      .insert(omOpportunityEconomics)
      .values({
        marketId: market.id,
        estimatedMonthlyPriceBear: priors.monthlyPrice.bear,
        estimatedMonthlyPriceBase: priors.monthlyPrice.base,
        estimatedMonthlyPriceBull: priors.monthlyPrice.bull,
        estimatedLifetimeMonthsBear: priors.lifetimeMonths.bear,
        estimatedLifetimeMonthsBase: priors.lifetimeMonths.base,
        estimatedLifetimeMonthsBull: priors.lifetimeMonths.bull,
        grossMarginBear: priors.grossMargin.bear,
        grossMarginBase: priors.grossMargin.base,
        grossMarginBull: priors.grossMargin.bull,
        clickToPaidBear: priors.clickToPaid.bear,
        clickToPaidBase: priors.clickToPaid.base,
        clickToPaidBull: priors.clickToPaid.bull,
        grossProfitLtvBear: econ.grossProfitLtv.bear,
        grossProfitLtvBase: econ.grossProfitLtv.base,
        grossProfitLtvBull: econ.grossProfitLtv.bull,
        allowableCacBear: econ.allowableCac.bear,
        allowableCacBase: econ.allowableCac.base,
        allowableCacBull: econ.allowableCac.bull,
        sustainableCpcBear: econ.sustainableCpc.bear,
        sustainableCpcBase: econ.sustainableCpc.base,
        sustainableCpcBull: econ.sustainableCpc.bull,
        observedWeightedCpc: market.weightedCpc,
        cpcCoverageBear: econ.cpcCoverage.bear,
        cpcCoverageBase: econ.cpcCoverage.base,
        cpcCoverageBull: econ.cpcCoverage.bull,
        observedLowPrice: observedLow,
        observedMedianPrice: observedMedian,
        observedHighPrice: observedHigh,
        pricingObservationCount: observed.length,
        priceConfidence: observed.length ? 'observed' : 'weakly_inferred',
        lifetimeConfidence: 'weakly_inferred',
        organicClicksBase: org.organicClicks,
        estimatedMonthlyNewLtv: org.estimatedMonthlyNewLtv,
        seoEconomicScore,
      })
      .onConflictDoUpdate({
        target: omOpportunityEconomics.marketId,
        set: {
          estimatedMonthlyPriceBase: priors.monthlyPrice.base,
          grossProfitLtvBase: econ.grossProfitLtv.base,
          sustainableCpcBase: econ.sustainableCpc.base,
          cpcCoverageBase: econ.cpcCoverage.base,
          cpcCoverageBear: econ.cpcCoverage.bear,
          cpcCoverageBull: econ.cpcCoverage.bull,
          observedMedianPrice: observedMedian,
          pricingObservationCount: observed.length,
          priceConfidence: observed.length ? 'observed' : 'weakly_inferred',
          organicClicksBase: org.organicClicks,
          estimatedMonthlyNewLtv: org.estimatedMonthlyNewLtv,
          seoEconomicScore,
          updatedAt: new Date(),
        },
      })

    await db
      .insert(omMarketScores)
      .values({ marketId: market.id, ...scores })
      .onConflictDoUpdate({
        target: omMarketScores.marketId,
        set: { ...scores, updatedAt: new Date() },
      })

    await db
      .update(omMarkets)
      .set({
        buildComplexity: feasibility.complexity,
        rejectionReasons: garbage.reasons,
        updatedAt: new Date(),
      })
      .where(eq(omMarkets.id, market.id))

    omLog('ECONOMICS', [
      `Median observed price: ${observedMedian != null ? `$${observedMedian}/mo` : 'inferred'}`,
      `Base GP-LTV: $${econ.grossProfitLtv.base.toFixed(0)}`,
      `Base sustainable CPC: $${econ.sustainableCpc.base.toFixed(2)}`,
      `Observed CPC: ${market.weightedCpc != null ? `$${market.weightedCpc.toFixed(2)}` : '—'}`,
      `Coverage: ${econ.cpcCoverage.base.toFixed(2)}x`,
    ])

    anomalyInputs.push({
      marketId: market.id,
      weightedCpc: market.weightedCpc,
      medianKd: market.medianKd,
      competitorAuthority: competitorAuth,
      competitorTraffic,
      persistentAdvertisers: market.persistentAdvertisers,
      uniqueAdvertisers: market.uniqueAdvertisers,
      serpWeakness: market.serpWeakness ?? 0,
      observedMedianPrice: observedMedian,
      growth12m: market.growth12m,
      buyerType: market.buyerType,
      recurringUsage: market.recurringUsage ?? 3,
      buildComplexity: feasibility.complexity,
      cpcCoverageBase: econ.cpcCoverage.base,
      adjustedVolume: market.adjustedVolume,
      productShapedShare: allKw.length ? allKw.filter((k) => isProductShaped(k.keyword)).length / allKw.length : 0,
      industry: /vertical/.test(market.businessType) ? market.likelyCustomer : market.businessType === 'vertical_saas' ? market.likelyCustomer : null,
      willingnessToPay: market.willingnessToPay ?? 3,
    })
    scored += 1
  }

  const hits = detectAnomalies(anomalyInputs)
  await db.delete(omAnomalies)
  if (hits.length) {
    await db.insert(omAnomalies).values(hits.map((h) => ({ marketId: h.marketId, kind: h.kind, why: h.why })))
  }
  return { scored, anomalies: hits.length }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? null
}
