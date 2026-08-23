import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  scoreHhtBlOpportunity,
  scoreHhtBlResearchValue,
  type HhtBlMechanism,
  type HhtBlSiteType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtBlBacklinks,
  hhtBlCampaignCandidates,
  hhtBlCandidateSites,
  hhtBlLinkAnalyses,
  hhtBlOpportunities,
  hhtBlReferringDomains,
  hhtBlResearchSites,
  hhtBlRuns,
  hhtBlSiteClassifications,
  hhtBlSiteMetrics,
  hhtBlStrategyClusters,
} from '../schema.js'

const clamp = (value: number): number => Math.max(0, Math.min(100, value))

export const HHT_BL_SITEWIDE_LINK_VALUE_PENALTY = 15

export const HHT_BL_SHARED_PLATFORM_DOMAINS = new Set([
  'alibaba.com',
  'ameblo.jp',
  'bing.com',
  'bio.site',
  'blogspot.com',
  'goodreads.com',
  'grokipedia.com',
  'hive.blog',
  'myportfolio.com',
  'odoo.com',
  'pinterest.com',
  'substack.com',
])

export function hhtBlOpportunityAuthority(input: {
  sourceDomain: string
  pageAuthority: number | null
  referringDomainAuthority: number | null
}): number {
  return HHT_BL_SHARED_PLATFORM_DOMAINS.has(input.sourceDomain)
    ? (input.pageAuthority ?? 0)
    : (input.referringDomainAuthority ?? input.pageAuthority ?? 0)
}

export function hhtBlOpportunityExclusionReason(
  input: {
    follow: boolean | null
    replicable: boolean
    relevance: number
    authority: number
  },
  minAuthorityScore: number,
): 'not_follow' | 'not_replicable' | 'low_relevance' | 'low_authority' | null {
  if (input.follow !== true) return 'not_follow'
  if (!input.replicable) return 'not_replicable'
  if (input.relevance < 40) return 'low_relevance'
  if (input.authority < minAuthorityScore) return 'low_authority'
  return null
}

export function dedupeHhtBlOpportunitiesBySource<
  T extends { sourceUrl: string; researchSiteId: number; overallScore: number },
>(rows: T[]): T[] {
  const best = new Map<string, T>()
  for (const row of rows) {
    const key = `${row.researchSiteId}\n${row.sourceUrl}`
    const current = best.get(key)
    if (!current || row.overallScore > current.overallScore) best.set(key, row)
  }
  return [...best.values()]
}

function tractability(totalBacklinks: number): number {
  return clamp(100 - (Math.log10(totalBacklinks + 1) / 6) * 100)
}

function sitePenalty(siteType: HhtBlSiteType, totalBacklinks: number, brandDependency: number): Record<string, number> {
  const penalties: Record<string, number> = {}
  if (siteType === 'OTA') penalties['major_ota'] = 25
  if (siteType === 'major_travel_brand') penalties['major_travel_brand'] = 25
  if (siteType === 'hotel_brand') penalties['hotel_brand'] = 20
  if (siteType === 'UGC_platform') penalties['ugc_giant'] = 30
  if (siteType === 'general_publisher') penalties['general_publisher'] = 10
  if (totalBacklinks > 1_000_000) penalties['oversized_backlink_profile'] = 15
  if (brandDependency > 80) penalties['brand_dependency'] = 10
  return penalties
}

export async function rankHhtBlCandidateSites(
  db: Database,
  runId: number,
): Promise<{ scored: number; missing: number }> {
  const rows = await db
    .select({
      id: hhtBlCandidateSites.id,
      visibility: hhtBlCandidateSites.weightedVisibility,
      transferability: hhtBlSiteClassifications.transferability,
      hhtSimilarity: hhtBlSiteClassifications.hhtSimilarity,
      brandDependency: hhtBlSiteClassifications.brandDependency,
      siteType: hhtBlSiteClassifications.siteType,
      organicTraffic: hhtBlSiteMetrics.estimatedOrganicTraffic,
      referringDomains: hhtBlSiteMetrics.referringDomains,
      totalBacklinks: hhtBlSiteMetrics.totalBacklinks,
    })
    .from(hhtBlCandidateSites)
    .leftJoin(hhtBlSiteClassifications, eq(hhtBlSiteClassifications.candidateSiteId, hhtBlCandidateSites.id))
    .leftJoin(hhtBlSiteMetrics, eq(hhtBlSiteMetrics.candidateSiteId, hhtBlCandidateSites.id))
    .where(eq(hhtBlCandidateSites.runId, runId))

  const maxVisibility = Math.max(1, ...rows.map((row) => row.visibility))
  const efficiencies = rows.map((row) =>
    row.organicTraffic === null || row.referringDomains === null
      ? null
      : row.organicTraffic / Math.max(1, row.referringDomains),
  )
  const maxEfficiency = Math.max(1, ...efficiencies.filter((value): value is number => value !== null))
  let scored = 0
  let missing = 0

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const absent = [
      row.transferability === null ? 'classification.transferability' : null,
      row.hhtSimilarity === null ? 'classification.hht_similarity' : null,
      row.brandDependency === null ? 'classification.brand_dependency' : null,
      row.siteType === null ? 'classification.site_type' : null,
      row.organicTraffic === null ? 'metrics.organic_traffic' : null,
      row.referringDomains === null ? 'metrics.referring_domains' : null,
      row.totalBacklinks === null ? 'metrics.total_backlinks' : null,
    ].filter((value): value is string => value !== null)
    if (absent.length > 0) {
      await db
        .update(hhtBlCandidateSites)
        .set({ researchValueScore: null, researchValueMissing: absent, updatedAt: new Date() })
        .where(eq(hhtBlCandidateSites.id, row.id))
      missing += 1
      continue
    }

    const efficiency = efficiencies[index] ?? 0
    const result = scoreHhtBlResearchValue({
      targetSerpVisibility: (row.visibility / maxVisibility) * 100,
      transferability: row.transferability!,
      seoEfficiency: (efficiency / maxEfficiency) * 100,
      businessModelSimilarity: row.hhtSimilarity!,
      backlinkProfileTractability: tractability(row.totalBacklinks!),
      penalties: sitePenalty(row.siteType!, row.totalBacklinks!, row.brandDependency!),
    })
    await db
      .update(hhtBlCandidateSites)
      .set({
        state: 'SCORED',
        researchValueScore: result.score,
        researchValueComponents: result.components,
        researchValuePenalties: result.penalties,
        researchValueMissing: [],
        updatedAt: new Date(),
      })
      .where(eq(hhtBlCandidateSites.id, row.id))
    scored += 1
  }
  return { scored, missing }
}

type ResearchCohort = 'direct_hht' | 'independent_publisher' | 'directory_programmatic' | 'amenity_specialist' | 'destination_editorial'

function cohortFor(domain: string, siteType: HhtBlSiteType, hhtSimilarity: number): ResearchCohort {
  if (/jacuzzi|hot.?tub/i.test(domain)) return 'direct_hht'
  if (siteType === 'travel_directory' || siteType === 'programmatic_travel_site') return 'directory_programmatic'
  if (siteType === 'destination_guide' || siteType === 'tourism_organization') return 'destination_editorial'
  if (hhtSimilarity >= 75) return 'amenity_specialist'
  return 'independent_publisher'
}

export async function selectHhtBlResearchSites(
  db: Database,
  runId: number,
  limit: number,
): Promise<number> {
  const rows = await db
    .select({
      id: hhtBlCandidateSites.id,
      domain: hhtBlCandidateSites.domain,
      score: hhtBlCandidateSites.researchValueScore,
      siteType: hhtBlSiteClassifications.siteType,
      hhtSimilarity: hhtBlSiteClassifications.hhtSimilarity,
    })
    .from(hhtBlCandidateSites)
    .innerJoin(hhtBlSiteClassifications, eq(hhtBlSiteClassifications.candidateSiteId, hhtBlCandidateSites.id))
    .where(eq(hhtBlCandidateSites.runId, runId))
    .orderBy(desc(hhtBlCandidateSites.researchValueScore))
  const eligible = rows.filter(
    (row): row is typeof row & { score: number; hhtSimilarity: number } =>
      row.score !== null && row.hhtSimilarity !== null,
  )
  const shares: Record<ResearchCohort, number> = {
    direct_hht: 0.15,
    independent_publisher: 0.35,
    directory_programmatic: 0.2,
    amenity_specialist: 0.15,
    destination_editorial: 0.15,
  }
  const caps = Object.fromEntries(
    Object.entries(shares).map(([cohort, share]) => [cohort, Math.max(1, Math.ceil(limit * share))]),
  ) as Record<ResearchCohort, number>
  const selected: Array<(typeof eligible)[number] & { cohort: ResearchCohort }> = []
  const tally = new Map<ResearchCohort, number>()
  for (const row of eligible) {
    const cohort = cohortFor(row.domain, row.siteType, row.hhtSimilarity)
    if ((tally.get(cohort) ?? 0) >= caps[cohort]) continue
    selected.push({ ...row, cohort })
    tally.set(cohort, (tally.get(cohort) ?? 0) + 1)
    if (selected.length === limit) break
  }
  if (selected.length < limit) {
    for (const row of eligible) {
      if (selected.some((item) => item.id === row.id)) continue
      selected.push({ ...row, cohort: cohortFor(row.domain, row.siteType, row.hhtSimilarity) })
      if (selected.length === limit) break
    }
  }

  await db
    .update(hhtBlResearchSites)
    .set({ active: false })
    .where(eq(hhtBlResearchSites.runId, runId))

  for (let index = 0; index < selected.length; index += 1) {
    const row = selected[index]!
    await db
      .insert(hhtBlResearchSites)
      .values({
        runId,
        candidateSiteId: row.id,
        cohort: row.cohort,
        rank: index + 1,
        selectedReason: `Research value ${row.score.toFixed(1)}; ${row.cohort} cohort`,
      })
      .onConflictDoUpdate({
        target: hhtBlResearchSites.candidateSiteId,
        set: { cohort: row.cohort, rank: index + 1, selectedReason: `Research value ${row.score.toFixed(1)}; ${row.cohort} cohort`, active: true },
      })
    await db.update(hhtBlCandidateSites).set({ state: 'SELECTED', updatedAt: new Date() }).where(eq(hhtBlCandidateSites.id, row.id))
  }
  return selected.length
}

function effortFor(mechanism: HhtBlMechanism, requiresNewAsset: boolean): number {
  if (mechanism === 'tool_widget_embed' || mechanism === 'data_research_citation' || mechanism === 'statistics_citation') return requiresNewAsset ? 85 : 60
  if (mechanism === 'hotel_partner' || mechanism === 'guest_contribution' || mechanism === 'expert_quote') return requiresNewAsset ? 75 : 60
  if (mechanism === 'directory_listing' || mechanism === 'association_listing') return requiresNewAsset ? 45 : 25
  return requiresNewAsset ? 65 : 35
}

export async function scoreHhtBlOpportunities(db: Database, runId: number): Promise<number> {
  const [run] = await db
    .select({ configuration: hhtBlRuns.configuration })
    .from(hhtBlRuns)
    .where(eq(hhtBlRuns.id, runId))
    .limit(1)
  if (!run) throw new Error(`HHT backlink run ${runId} does not exist`)
  const configuration = run.configuration as {
    backlinks?: { min_authority_score?: number }
  }
  const minAuthorityScore = configuration.backlinks?.min_authority_score ?? 20

  await db.delete(hhtBlOpportunities).where(eq(hhtBlOpportunities.runId, runId))
  const rows = await db
    .select({
      backlinkId: hhtBlBacklinks.id,
      researchSiteId: hhtBlBacklinks.researchSiteId,
      sourceUrl: hhtBlBacklinks.sourceUrl,
      follow: hhtBlBacklinks.follow,
      sitewide: hhtBlBacklinks.sitewide,
      pageAuthority: hhtBlBacklinks.authorityScore,
      pageScore: hhtBlBacklinks.sourcePageScore,
      refAuthority: hhtBlReferringDomains.authorityScore,
      sourceDomain: hhtBlReferringDomains.domain,
      sitesLinked: hhtBlReferringDomains.researchSitesLinked,
      mechanism: hhtBlLinkAnalyses.mechanism,
      editorial: hhtBlLinkAnalyses.editorial,
      likelyPaid: hhtBlLinkAnalyses.likelyPaid,
      replicable: hhtBlLinkAnalyses.replicable,
      replicability: hhtBlLinkAnalyses.replicabilityScore,
      relevance: hhtBlLinkAnalyses.hotelHotTubsRelevance,
      requiresNewAsset: hhtBlLinkAnalyses.requiresNewAsset,
    })
    .from(hhtBlBacklinks)
    .innerJoin(hhtBlReferringDomains, eq(hhtBlBacklinks.referringDomainId, hhtBlReferringDomains.id))
    .innerJoin(hhtBlLinkAnalyses, eq(hhtBlLinkAnalyses.backlinkId, hhtBlBacklinks.id))
    .where(eq(hhtBlBacklinks.runId, runId))

  const candidates: Array<{
    backlinkId: number
    researchSiteId: number
    sourceUrl: string
    overallScore: number
    linkValue: number
    gettability: number
    transferability: number
    effort: number
    expectedValue: number
    scoreInputs: Record<string, unknown>
  }> = []
  for (const row of rows) {
    const sharedPlatform = HHT_BL_SHARED_PLATFORM_DOMAINS.has(row.sourceDomain)
    const authority = hhtBlOpportunityAuthority({
      sourceDomain: row.sourceDomain,
      pageAuthority: row.pageAuthority,
      referringDomainAuthority: row.refAuthority,
    })
    if (
      hhtBlOpportunityExclusionReason(
        {
          follow: row.follow,
          replicable: row.replicable,
          relevance: row.relevance,
          authority,
        },
        minAuthorityScore,
      ) !== null
    ) {
      continue
    }
    const sitesLinked = sharedPlatform ? 1 : row.sitesLinked
    const sitewidePenalty = row.sitewide ? HHT_BL_SITEWIDE_LINK_VALUE_PENALTY : 0
    const linkValue = clamp(
      authority * 0.3 +
        (row.follow === true ? 15 : row.follow === null ? 0 : -10) +
        (row.editorial ? 20 : 5) +
        row.relevance * 0.2 +
        (row.pageScore ?? 0) * 0.15 -
        sitewidePenalty,
    )
    const clearMechanism = row.mechanism === 'unknown' || row.mechanism === 'organic_unreplicable' ? 0 : 100
    const gettability = clamp(
      row.replicability * 0.35 +
        Math.min(100, sitesLinked * 20) * 0.25 +
        clearMechanism * 0.2 +
        (row.likelyPaid ? 25 : 85) * 0.2,
    )
    const transferability = (row.relevance + row.replicability) / 2
    const effort = effortFor(row.mechanism, row.requiresNewAsset)
    const result = scoreHhtBlOpportunity({ linkValue, gettability, transferability, effort })
    candidates.push({
      backlinkId: row.backlinkId,
      researchSiteId: row.researchSiteId,
      sourceUrl: row.sourceUrl,
      overallScore: result.overallScore,
      linkValue: Math.round(result.linkValue),
      gettability: Math.round(result.gettability),
      transferability: Math.round(result.transferability),
      effort: Math.round(result.effort),
      expectedValue: result.expectedValue,
      scoreInputs: {
        authority,
        minAuthorityScore,
        follow: row.follow,
        editorial: row.editorial,
        relevance: row.relevance,
        replicability: row.replicability,
        sitesLinked,
        mechanism: row.mechanism,
        likelyPaid: row.likelyPaid,
        sitewide: row.sitewide,
        sitewidePenalty,
      },
    })
  }

  const scored = dedupeHhtBlOpportunitiesBySource(candidates)
  for (const row of scored) {
    await db
      .insert(hhtBlOpportunities)
      .values({
        runId,
        backlinkId: row.backlinkId,
        linkValue: row.linkValue,
        gettability: row.gettability,
        transferability: row.transferability,
        effort: row.effort,
        overallScore: row.overallScore,
        expectedValue: row.expectedValue,
        scoreInputs: row.scoreInputs,
      })
      .onConflictDoUpdate({
        target: hhtBlOpportunities.backlinkId,
        set: {
          linkValue: row.linkValue,
          gettability: row.gettability,
          transferability: row.transferability,
          effort: row.effort,
          overallScore: row.overallScore,
          expectedValue: row.expectedValue,
          scoreInputs: row.scoreInputs,
          updatedAt: new Date(),
        },
      })
  }
  scored.sort((a, b) => b.overallScore - a.overallScore)
  for (let index = 0; index < scored.length; index += 1) {
    await db
      .update(hhtBlOpportunities)
      .set({ rank: index + 1, status: 'RECOMMENDED', updatedAt: new Date() })
      .where(eq(hhtBlOpportunities.backlinkId, scored[index]!.backlinkId))
  }
  return scored.length
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

const CAMPAIGN_NAMES: Partial<Record<HhtBlMechanism, string>> = {
  tourism_board_resource: 'Tourism board destination resources',
  destination_guide: 'Destination guide inclusion',
  curated_resource_page: 'Curated travel resources',
  directory_listing: 'Travel directory listings',
  data_research_citation: 'Original travel data citations',
  journalist_editorial: 'Travel journalist editorial pitches',
}

export async function clusterHhtBlStrategies(db: Database, runId: number): Promise<number> {
  const rows = await db
    .select({
      opportunityId: hhtBlOpportunities.id,
      mechanism: hhtBlLinkAnalyses.mechanism,
      linkValue: hhtBlOpportunities.linkValue,
      gettability: hhtBlOpportunities.gettability,
      effort: hhtBlOpportunities.effort,
      expectedValue: hhtBlOpportunities.expectedValue,
      authority: hhtBlReferringDomains.authorityScore,
      pageAuthority: hhtBlBacklinks.authorityScore,
      sourceDomain: hhtBlReferringDomains.domain,
      sourceUrl: hhtBlBacklinks.sourceUrl,
      researchSiteId: hhtBlBacklinks.researchSiteId,
      requiresNewAsset: hhtBlLinkAnalyses.requiresNewAsset,
    })
    .from(hhtBlOpportunities)
    .innerJoin(hhtBlBacklinks, eq(hhtBlOpportunities.backlinkId, hhtBlBacklinks.id))
    .innerJoin(hhtBlReferringDomains, eq(hhtBlBacklinks.referringDomainId, hhtBlReferringDomains.id))
    .innerJoin(hhtBlLinkAnalyses, eq(hhtBlLinkAnalyses.backlinkId, hhtBlBacklinks.id))
    .where(eq(hhtBlOpportunities.runId, runId))
    .orderBy(desc(hhtBlOpportunities.overallScore))

  // Clusters and campaigns are fully derived from the current opportunity set.
  // Rebuild them so mechanisms removed by a rescore cannot survive as stale output.
  await db.delete(hhtBlStrategyClusters).where(eq(hhtBlStrategyClusters.runId, runId))
  const groups = new Map<HhtBlMechanism, typeof rows>()
  for (const row of rows) groups.set(row.mechanism, [...(groups.get(row.mechanism) ?? []), row])

  for (const [mechanism, group] of groups) {
    const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    const recommendation = CAMPAIGN_NAMES[mechanism] ?? mechanism.replaceAll('_', ' ')
    const prospectCount = new Set(group.map((row) => row.sourceDomain)).size
    const authorities = group.map((row) =>
      hhtBlOpportunityAuthority({
        sourceDomain: row.sourceDomain,
        pageAuthority: row.pageAuthority,
        referringDomainAuthority: row.authority,
      }),
    )
    const [cluster] = await db
      .insert(hhtBlStrategyClusters)
      .values({
        runId,
        mechanism,
        prospectCount,
        researchSitesObserved: new Set(group.map((row) => row.researchSiteId)).size,
        medianAuthority: median(authorities),
        averageLinkValue: average(group.map((row) => row.linkValue)),
        averageGettability: average(group.map((row) => row.gettability)),
        averageEffort: average(group.map((row) => row.effort)),
        estimatedCampaignValue: group.reduce((sum, row) => sum + row.expectedValue, 0),
        examples: group.slice(0, 5).map((row) => ({ sourceUrl: row.sourceUrl, opportunityId: row.opportunityId })),
        recommendedCampaign: recommendation,
      })
      .onConflictDoUpdate({
        target: [hhtBlStrategyClusters.runId, hhtBlStrategyClusters.mechanism],
        set: {
          prospectCount,
          researchSitesObserved: new Set(group.map((row) => row.researchSiteId)).size,
          medianAuthority: median(authorities),
          averageLinkValue: average(group.map((row) => row.linkValue)),
          averageGettability: average(group.map((row) => row.gettability)),
          averageEffort: average(group.map((row) => row.effort)),
          estimatedCampaignValue: group.reduce((sum, row) => sum + row.expectedValue, 0),
          examples: group.slice(0, 5).map((row) => ({ sourceUrl: row.sourceUrl, opportunityId: row.opportunityId })),
          recommendedCampaign: recommendation,
          updatedAt: new Date(),
        },
      })
      .returning({ id: hhtBlStrategyClusters.id })
    if (!cluster) continue
    await db
      .insert(hhtBlCampaignCandidates)
      .values({
        runId,
        strategyClusterId: cluster.id,
        name: recommendation,
        status: 'RECOMMENDED',
        evidence: [`${prospectCount} unique referring-domain prospects`, `${new Set(group.map((row) => row.researchSiteId)).size} research sites represented`],
        potentialProspects: prospectCount,
        existingAssetSufficient: new Set(
          group.filter((row) => !row.requiresNewAsset).map((row) => row.sourceDomain),
        ).size,
        newAssetRequired: new Set(
          group.filter((row) => row.requiresNewAsset).map((row) => row.sourceDomain),
        ).size,
        recommendation: `Review the highest-scoring ${recommendation.toLowerCase()} opportunities as one campaign.`,
      })
      .onConflictDoUpdate({
        target: hhtBlCampaignCandidates.strategyClusterId,
        set: {
          status: 'RECOMMENDED',
          evidence: [`${prospectCount} unique referring-domain prospects`, `${new Set(group.map((row) => row.researchSiteId)).size} research sites represented`],
          potentialProspects: prospectCount,
          existingAssetSufficient: new Set(
            group.filter((row) => !row.requiresNewAsset).map((row) => row.sourceDomain),
          ).size,
          newAssetRequired: new Set(
            group.filter((row) => row.requiresNewAsset).map((row) => row.sourceDomain),
          ).size,
          recommendation: `Review the highest-scoring ${recommendation.toLowerCase()} opportunities as one campaign.`,
        },
      })
  }
  return groups.size
}
