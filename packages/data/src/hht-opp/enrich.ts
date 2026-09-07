import 'server-only'
import {
  acceptsGuestOrPaidPlacement,
  inboundOutboundRatio,
  OM_CACHE_TTL_DAYS,
  scoreOpportunity,
} from '@rnr/core'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db.js'
import { createSemrushClient, SemrushUnavailable } from '../opportunity-miner/semrush/client.js'
import { hhtOppDomains, hhtOppOpportunities, hhtOppSeoMetrics } from '../schema.js'
import { getHhtOppScoreWeights } from './settings.js'
import { latestSeoMetrics } from './store.js'

export interface EnrichResult {
  domainId: number
  domain: string
  enriched: boolean
  skipped: 'fresh_metrics' | 'not_placement' | null
  error: string | null
}

function result(
  domain: { id: number; rootDomain: string },
  patch: Partial<EnrichResult>,
): EnrichResult {
  return {
    domainId: domain.id,
    domain: domain.rootDomain,
    enriched: false,
    skipped: null,
    error: null,
    ...patch,
  }
}

export async function hasFreshHhtOppAuthority(db: Database, domainId: number): Promise<boolean> {
  const rows = await db
    .select({
      value: hhtOppSeoMetrics.value,
      retrievedAt: hhtOppSeoMetrics.retrievedAt,
    })
    .from(hhtOppSeoMetrics)
    .where(and(eq(hhtOppSeoMetrics.domainId, domainId), eq(hhtOppSeoMetrics.metric, 'authority_score')))
  let latest: { value: number | null; at: Date } | null = null
  for (const row of rows) {
    if (!latest || row.retrievedAt > latest.at) latest = { value: row.value, at: row.retrievedAt }
  }
  if (!latest || latest.value == null) return false
  return Date.now() - latest.at.getTime() < OM_CACHE_TTL_DAYS.backlinks * 86_400_000
}

async function rescoreDomainOpportunities(
  db: Database,
  domain: typeof hhtOppDomains.$inferSelect,
  related: Array<typeof hhtOppOpportunities.$inferSelect>,
  weights: Awaited<ReturnType<typeof getHhtOppScoreWeights>>,
): Promise<void> {
  const metrics = await latestSeoMetrics(db, domain.id)
  for (const opp of related) {
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
}

/**
 * One Semrush backlinks_overview call per placement-accepting domain.
 * Skips domains already enriched inside the backlinks cache window.
 * Does not purchase domain_rank / traffic — those are optional and spend extra.
 */
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

  const weights = await getHhtOppScoreWeights(db)
  const results: EnrichResult[] = []
  const needsLive: typeof domains = []

  for (const domain of domains) {
    const related = byDomain.get(domain.id) ?? []
    const placement = acceptsGuestOrPaidPlacement(related.map((row) => row.opportunityType))
    if (!placement && !options.approvedReview) {
      results.push(result(domain, { skipped: 'not_placement', error: 'No guest-post or paid-placement page on this domain yet.' }))
      continue
    }

    if (await hasFreshHhtOppAuthority(db, domain.id)) {
      results.push(result(domain, { skipped: 'fresh_metrics' }))
      continue
    }
    needsLive.push(domain)
  }

  if (needsLive.length === 0) return results

  let client
  try {
    client = createSemrushClient(db, process.env, true)
  } catch (error) {
    return [
      ...results,
      ...needsLive.map((domain) =>
        result(domain, {
          error: error instanceof Error ? error.message : 'Semrush is not configured.',
        }),
      ),
    ]
  }

  for (const domain of needsLive) {
    const related = byDomain.get(domain.id) ?? []
    try {
      const backlinks = await client.domainBacklinks(domain.rootDomain)
      const inbound = backlinks?.backlinks ?? null
      const ratio = inboundOutboundRatio(inbound, domain.avgExternalLinks)
      const snapshots = [
        { metric: 'authority_score', value: backlinks?.authorityScore ?? null },
        { metric: 'referring_domains', value: backlinks?.referringDomains ?? null },
        { metric: 'backlinks', value: inbound },
        { metric: 'inbound_outbound_ratio', value: ratio },
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

      await rescoreDomainOpportunities(db, domain, related, weights)
      results.push(result(domain, { enriched: true }))
    } catch (error) {
      results.push(
        result(domain, {
          error: error instanceof SemrushUnavailable ? error.message : error instanceof Error ? error.message : 'Enrichment failed.',
        }),
      )
    }
  }

  return results
}

export async function applyHhtOppBacklinkSnapshot(
  db: Database,
  domainId: number,
  snapshot: { authorityScore: number | null; backlinks: number | null; referringDomains: number | null },
): Promise<void> {
  const [domain] = await db.select().from(hhtOppDomains).where(eq(hhtOppDomains.id, domainId)).limit(1)
  if (!domain) throw new Error(`Domain ${domainId} was not found.`)
  const ratio = inboundOutboundRatio(snapshot.backlinks, domain.avgExternalLinks)
  await db.insert(hhtOppSeoMetrics).values(
    [
      { metric: 'authority_score', value: snapshot.authorityScore },
      { metric: 'referring_domains', value: snapshot.referringDomains },
      { metric: 'backlinks', value: snapshot.backlinks },
      { metric: 'inbound_outbound_ratio', value: ratio },
    ].map((row) => ({
      domainId,
      metric: row.metric,
      value: row.value,
      source: 'semrush',
      retrievedAt: new Date(),
    })),
  )
  const related = await db.select().from(hhtOppOpportunities).where(eq(hhtOppOpportunities.domainId, domainId))
  await rescoreDomainOpportunities(db, domain, related, await getHhtOppScoreWeights(db))
}

export async function enrichQualifiedHhtOppDomains(db: Database): Promise<EnrichResult[]> {
  const rows = await db.select({ domainId: hhtOppOpportunities.domainId, type: hhtOppOpportunities.opportunityType }).from(hhtOppOpportunities)
  const ids = [
    ...new Set(rows.filter((row) => acceptsGuestOrPaidPlacement([row.type])).map((row) => row.domainId)),
  ]
  return enrichHhtOppDomains(db, ids)
}
