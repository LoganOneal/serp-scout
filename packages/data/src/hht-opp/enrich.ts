import 'server-only'
import { scoreOpportunity } from '@rnr/core'
import { eq, inArray } from 'drizzle-orm'
import type { Database } from '../db.js'
import { createSemrushClient, SemrushUnavailable } from '../opportunity-miner/semrush/client.js'
import { hhtOppDomains, hhtOppOpportunities, hhtOppSeoMetrics } from '../schema.js'
import { getHhtOppScoreWeights } from './settings.js'
import { latestSeoMetrics } from './store.js'

export interface EnrichResult {
  domainId: number
  domain: string
  enriched: boolean
  error: string | null
}

function mayEnrich(status: string, eligibility: string): boolean {
  return eligibility === 'PASS' || status === 'PASS' || status === 'ENRICHED' || status === 'DRAFT_READY' || status === 'REVIEW'
}

export async function enrichHhtOppDomains(
  db: Database,
  domainIds: number[],
  options: { approvedReview?: boolean } = {},
): Promise<EnrichResult[]> {
  if (domainIds.length === 0) return []
  const domains = await db.select().from(hhtOppDomains).where(inArray(hhtOppDomains.id, domainIds))
  const opps = await db.select().from(hhtOppOpportunities).where(inArray(hhtOppOpportunities.domainId, domainIds))
  const byDomain = new Map<number, typeof opps>()
  for (const opp of opps) {
    const list = byDomain.get(opp.domainId) ?? []
    list.push(opp)
    byDomain.set(opp.domainId, list)
  }

  let client
  try {
    client = createSemrushClient(db, process.env, true)
  } catch (error) {
    return domains.map((domain) => ({
      domainId: domain.id,
      domain: domain.rootDomain,
      enriched: false,
      error: error instanceof Error ? error.message : 'Semrush is not configured.',
    }))
  }

  const weights = await getHhtOppScoreWeights(db)
  const results: EnrichResult[] = []

  for (const domain of domains) {
    const related = byDomain.get(domain.id) ?? []
    const allowed = related.some((row) => mayEnrich(row.status, row.eligibility) && (row.eligibility === 'PASS' || options.approvedReview || row.status !== 'REVIEW'))
    if (!allowed) {
      results.push({
        domainId: domain.id,
        domain: domain.rootDomain,
        enriched: false,
        error: 'Enrichment is limited to PASS or manually approved REVIEW opportunities.',
      })
      continue
    }

    try {
      const [overview, backlinks] = await Promise.all([
        client.domainOverview(domain.rootDomain),
        client.domainBacklinks(domain.rootDomain),
      ])
      const snapshots = [
        { metric: 'authority_score', value: backlinks?.authorityScore ?? null },
        { metric: 'organic_traffic', value: overview?.organicTraffic ?? null },
        { metric: 'organic_keywords', value: overview?.organicKeywords ?? null },
        { metric: 'referring_domains', value: backlinks?.referringDomains ?? null },
        { metric: 'backlinks', value: backlinks?.backlinks ?? null },
      ]
      if (snapshots.some((row) => row.value != null)) {
        await db.insert(hhtOppSeoMetrics).values(
          snapshots.map((row) => ({
            domainId: domain.id,
            metric: row.metric,
            value: row.value,
            source: 'semrush',
            retrievedAt: new Date(),
          })),
        )
      }

      const metrics = await latestSeoMetrics(db, domain.id)
      for (const opp of related) {
        if (!mayEnrich(opp.status, opp.eligibility)) continue
        const scored = scoreOpportunity({
          feasibility: {
            eligibility: opp.eligibility,
            hasSubmissionRoute: true,
            linkType: opp.linkType,
            topicalFit: opp.topicalRelevanceScore ?? 40,
            pitchClarity: 55,
            evidenceConfidence: opp.eligibilityConfidence === 'HIGH' ? 85 : 40,
            freshnessDays: opp.lastCheckedAt ? Math.floor((Date.now() - opp.lastCheckedAt.getTime()) / 86_400_000) : 0,
          },
          seo: {
            authorityScore: metrics['authority_score'] ?? null,
            referringDomains: metrics['referring_domains'] ?? null,
            organicTraffic: metrics['organic_traffic'] ?? null,
            topicalRelevance: opp.topicalRelevanceScore ?? 40,
            usTrafficShare: null,
            linkType: opp.linkType,
            avgExternalLinks: domain.avgExternalLinks,
            seoRisk: opp.seoRisk,
            quality: domain.quality,
          },
          cost: {
            priceAmount: opp.priceAmount,
            seoValue: 0,
            isPaid: opp.priceStatus === 'FIXED' || opp.priceStatus === 'QUOTE_REQUIRED',
          },
          editorial: {
            hasAuthors: true,
            hasDates: true,
            avgExternalLinks: domain.avgExternalLinks,
            quality: domain.quality,
          },
          freshnessDays: opp.lastCheckedAt ? Math.floor((Date.now() - opp.lastCheckedAt.getTime()) / 86_400_000) : 0,
          weights,
        })
        await db
          .update(hhtOppOpportunities)
          .set({
            status: opp.eligibility === 'PASS' || opp.status === 'ENRICHED' ? 'ENRICHED' : opp.status,
            seoValueScore: scored.seoValue,
            feasibilityScore: scored.feasibility,
            topicalRelevanceScore: scored.topicalRelevance,
            editorialQualityScore: scored.editorialQuality,
            costEfficiencyScore: scored.costEfficiency,
            freshnessScore: scored.freshness,
            overallScore: scored.overall,
            updatedAt: new Date(),
          })
          .where(eq(hhtOppOpportunities.id, opp.id))
      }

      results.push({ domainId: domain.id, domain: domain.rootDomain, enriched: true, error: null })
    } catch (error) {
      results.push({
        domainId: domain.id,
        domain: domain.rootDomain,
        enriched: false,
        error: error instanceof SemrushUnavailable ? error.message : error instanceof Error ? error.message : 'Enrichment failed.',
      })
    }
  }

  return results
}

export async function enrichQualifiedHhtOppDomains(db: Database): Promise<EnrichResult[]> {
  const rows = await db
    .select({ domainId: hhtOppOpportunities.domainId })
    .from(hhtOppOpportunities)
    .where(inArray(hhtOppOpportunities.eligibility, ['PASS']))
  const ids = [...new Set(rows.map((row) => row.domainId))]
  return enrichHhtOppDomains(db, ids)
}
