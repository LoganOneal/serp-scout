import { eq } from 'drizzle-orm'
import {
  adjustedClusterVolume,
  brandedShare,
  classifySearchDomain,
  clusterKeywords,
  extractConcepts,
  growthFromSeries,
  inferBuyerType,
  inferExpansionPotential,
  inferWillingnessToPay,
  isMajorPlatformOwned,
  isProductShaped,
  median,
  parseTrendSeries,
  persistentAdvertiserScore,
  serpWeaknessScore,
  omSlugify,
  weightedAverage,
  type BusinessType,
  type MonetizationModel,
  type RejectionReason,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  omKeywordConcepts,
  omKeywordDomains,
  omKeywords,
  omMarketDomains,
  omMarketKeywords,
  omMarkets,
} from '../schema.js'
import { omLog } from './log.js'

export async function clusterMarkets(db: Database, country = 'us'): Promise<{ created: number; updated: number }> {
  const keywords = await db.select().from(omKeywords).where(eq(omKeywords.country, country))
  const concepts = await db.select().from(omKeywordConcepts)
  const conceptByKw = new Map(concepts.map((c) => [c.keywordId, c]))
  const links = await db.select().from(omKeywordDomains)
  const domainsByKw = new Map<number, string[]>()
  const { omDomains } = await import('../schema.js')
  const domainRows = await db.select().from(omDomains)
  const domainById = new Map(domainRows.map((d) => [d.id, d]))
  for (const link of links) {
    const d = domainById.get(link.domainId)
    if (!d) continue
    const arr = domainsByKw.get(link.keywordId) ?? []
    arr.push(d.domain)
    domainsByKw.set(link.keywordId, arr)
  }

  const clusters = clusterKeywords(
    keywords.map((k) => ({
      id: k.id,
      keyword: k.keyword,
      volume: k.volume,
      domains: domainsByKw.get(k.id) ?? [],
    })),
  )

  let created = 0
  let updated = 0
  for (const cluster of clusters) {
    if (cluster.keywordIds.length < 1) continue
    const members = keywords.filter((k) => cluster.keywordIds.includes(k.id))
    const slug = uniqueSlug(omSlugify(cluster.nameHint))
    const existing = await db.select().from(omMarkets).where(eq(omMarkets.clusterKey, cluster.key)).limit(1)
    const vol = adjustedClusterVolume(members.map((m) => ({ keyword: m.keyword, volume: m.volume })))
    const weightedCpc = weightedAverage(members.filter((m) => m.cpc != null && m.volume).map((m) => ({ value: m.cpc!, weight: m.volume! })))
    const weightedKd = weightedAverage(
      members.filter((m) => m.keywordDifficulty != null && m.volume).map((m) => ({ value: m.keywordDifficulty!, weight: m.volume! })),
    )
    const kdValues = members.map((m) => m.keywordDifficulty).filter((n): n is number => n != null)
    const commercial = members.filter((m) => m.intent === 'commercial' || m.intent === 'transactional' || isProductShaped(m.keyword))
    const commercialVolume = commercial.reduce((a, m) => a + (m.volume ?? 0), 0)
    const highIntent = members.filter((m) => /pricing|cost|software|app|buy|alternative/.test(m.keyword.toLowerCase()))
    const trends = members.flatMap((m) => parseTrendSeries(m.trend))
    const growth12 = members
      .map((m) => growthFromSeries(parseTrendSeries(m.trend), 12))
      .filter((n): n is number => n != null)
    const growth3 = members.map((m) => growthFromSeries(parseTrendSeries(m.trend), 3)).filter((n): n is number => n != null)
    const growth6 = members.map((m) => growthFromSeries(parseTrendSeries(m.trend), 6)).filter((n): n is number => n != null)

    const memberLinks = links.filter((l) => cluster.keywordIds.includes(l.keywordId))
    const paidDomainIds = new Set(memberLinks.filter((l) => l.rankingType === 'paid').map((l) => l.domainId))
    const organicLinks = memberLinks.filter((l) => l.rankingType === 'organic')
    const weakness = serpWeaknessScore({
      domains: organicLinks.map((l) => {
        const d = domainById.get(l.domainId)
        return {
          domain: d?.domain ?? '',
          position: l.position,
          authorityScore: d?.authorityScore ?? null,
          classification: d?.classification ?? classifySearchDomain(d?.domain ?? ''),
        }
      }),
    })

    const first = members[0]!
    const concept = conceptByKw.get(first.id) ?? extractConcepts(first.keyword)
    const buyer = inferBuyerType({
      industry: concept.industry,
      persona: concept.persona,
      archetype: concept.productArchetype,
      keywords: members.map((m) => m.keyword),
    })
    const recurring = Math.round(
      members.reduce((a, m) => a + (conceptByKw.get(m.id)?.recurringUsageLikelihood ?? extractConcepts(m.keyword).recurringUsageLikelihood), 0) /
        members.length,
    )
    const wtp = inferWillingnessToPay({
      buyer,
      recurring,
      weightedCpc,
      observedMedianPrice: null,
      workflow: concept.workflow,
    })

    const businessType = buyerToBusiness(buyer, concept.industry)
    const monetization: MonetizationModel = recurring >= 4 ? 'subscription' : isProductShaped(first.keyword) ? 'usage_based' : 'unknown'
    const platformOwned = isMajorPlatformOwned(
      organicLinks.map((l) => ({
        domain: domainById.get(l.domainId)?.domain ?? '',
        position: l.position,
        classification: domainById.get(l.domainId)?.classification ?? 'unknown',
      })),
    )

    const values = {
      name: cluster.nameHint,
      description: `${members.length} keywords around ${cluster.nameHint}`,
      canonicalProblem: concept.workflow ? `People search for tools that do ${concept.workflow}` : null,
      likelyCustomer: concept.persona ?? concept.industry ?? buyer,
      businessType,
      monetizationModel: monetization,
      buyerType: buyer,
      clusterKey: cluster.key,
      country,
      rawVolume: vol.raw,
      adjustedVolume: vol.adjusted,
      weightedCpc,
      weightedKd,
      medianKd: median(kdValues),
      commercialVolume,
      highIntentVolume: highIntent.reduce((a, m) => a + (m.volume ?? 0), 0),
      brandedShare: brandedShare(
        members.map((m) => ({ keyword: m.keyword, volume: m.volume })),
        members.flatMap((m) => (m.keyword.split(' ').length === 1 ? [m.keyword] : [])),
      ),
      growth3m: median(growth3),
      growth6m: median(growth6),
      growth12m: median(growth12),
      growth24m: growthFromSeries(trends, 24),
      uniqueAdvertisers: paidDomainIds.size,
      persistentAdvertisers: Math.min(paidDomainIds.size, Math.round(persistentAdvertiserScore({
        uniqueAdvertisers: paidDomainIds.size,
        recurringAdvertisers: Math.ceil(paidDomainIds.size * 0.5),
        monthsObserved: 6,
        adDensity: paidDomainIds.size / Math.max(members.length, 1),
      }) / 15)),
      competitorCount: new Set(organicLinks.map((l) => l.domainId)).size,
      serpWeakness: weakness,
      recurringUsage: recurring,
      willingnessToPay: wtp,
      expansionPotential: inferExpansionPotential({ workflow: concept.workflow, industry: concept.industry }),
      rejectionReasons: platformOwned ? (['owned_by_free_platform'] as RejectionReason[]) : [],
      updatedAt: new Date(),
    }

    let marketId: number
    if (existing[0]) {
      await db.update(omMarkets).set(values).where(eq(omMarkets.id, existing[0].id))
      marketId = existing[0].id
      updated += 1
    } else {
      const inserted = await db
        .insert(omMarkets)
        .values({ ...values, slug })
        .returning({ id: omMarkets.id })
      marketId = inserted[0]!.id
      created += 1
    }

    await db.delete(omMarketKeywords).where(eq(omMarketKeywords.marketId, marketId))
    if (members.length) {
      await db.insert(omMarketKeywords).values(
        members.map((m) => ({
          marketId,
          keywordId: m.id,
          relevanceScore: 1,
          intentScore: conceptByKw.get(m.id)?.commercialIntent ?? null,
        })),
      )
    }

    await db.delete(omMarketDomains).where(eq(omMarketDomains.marketId, marketId))
    const domainRoles = new Map<number, { role: 'competitor' | 'advertiser'; count: number }>()
    for (const l of memberLinks) {
      const role = l.rankingType === 'paid' ? 'advertiser' : 'competitor'
      const prev = domainRoles.get(l.domainId)
      if (!prev) domainRoles.set(l.domainId, { role, count: 1 })
      else domainRoles.set(l.domainId, { role: prev.role === 'advertiser' || role === 'advertiser' ? 'advertiser' : 'competitor', count: prev.count + 1 })
    }
    if (domainRoles.size) {
      await db.insert(omMarketDomains).values(
        [...domainRoles.entries()].map(([domainId, v]) => ({
          marketId,
          domainId,
          role: v.role,
          relevanceScore: v.count,
          keywordCount: v.count,
        })),
      )
    }

    omLog('MARKET', [
      `${existing[0] ? 'Updated' : 'Created'}: ${cluster.nameHint}`,
      `Cluster keywords: ${members.length}`,
      `Adjusted volume: ${vol.adjusted.toLocaleString('en-US')}`,
      `Weighted CPC: ${weightedCpc != null ? `$${weightedCpc.toFixed(2)}` : '—'}`,
      `Persistent advertisers: ${values.persistentAdvertisers}`,
    ])
  }

  return { created, updated }
}

function buyerToBusiness(buyer: ReturnType<typeof inferBuyerType>, industry: string | null): BusinessType {
  if (industry && buyer === 'SMB') return 'vertical_saas'
  if (buyer === 'consumer') return 'B2C'
  if (buyer === 'prosumer' || buyer === 'freelancer') return 'prosumer'
  if (buyer === 'SMB') return 'SMB'
  return 'unknown'
}

function uniqueSlug(base: string): string {
  return `${base}-${Math.abs(hash(base) % 9999)}`
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
