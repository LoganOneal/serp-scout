import 'server-only'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { HHT_BL_STAGES, type HhtBlStage } from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtBlAcquiredLinks,
  hhtBlBacklinks,
  hhtBlCampaignCandidates,
  hhtBlCandidateSites,
  hhtBlJobs,
  hhtBlLinkAnalyses,
  hhtBlOpportunities,
  hhtBlRawResponses,
  hhtBlReferringDomains,
  hhtBlResearchSites,
  hhtBlRunEvents,
  hhtBlRuns,
  hhtBlSiteClassifications,
  hhtBlSiteMetrics,
  hhtBlStrategyClusters,
  sites,
} from '../schema.js'

export type HhtBlDashboardView =
  | 'overview'
  | 'sites'
  | 'backlinks'
  | 'opportunities'
  | 'strategies'
  | 'acquired'

export type HhtBlStageStatus =
  | 'not_started'
  | 'pending'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'complete'

export interface HhtBlStageProgress {
  stage: HhtBlStage
  status: HhtBlStageStatus
  jobs: number
  records: number
}

export async function getHhtBlDashboard(
  db: Database,
  siteDomain = 'hotelhottubs.com',
  view: HhtBlDashboardView = 'overview',
) {
  const [site] = await db
    .select({ id: sites.id, domain: sites.domain, displayName: sites.displayName })
    .from(sites)
    .where(eq(sites.domain, siteDomain))
    .limit(1)
  if (!site) throw new Error(`No site record exists for ${siteDomain}`)

  const [run] = await db
    .select()
    .from(hhtBlRuns)
    .where(eq(hhtBlRuns.siteId, site.id))
    .orderBy(desc(hhtBlRuns.createdAt))
    .limit(1)
  if (!run) {
    return {
      site,
      run: null,
      stages: [],
      counts: null,
      jobs: [],
      candidateSites: [],
      researchSites: [],
      backlinks: [],
      opportunities: [],
      clusters: [],
      campaigns: [],
      acquiredLinks: [],
      events: [],
      cost: null,
    }
  }

  // One count query feeds every tab badge. Heavier row queries are scoped to
  // the active view so a backlink table never blocks the overview render.
  const [counts] = await db
    .select({
      candidates: sql<number>`(
        select count(*)::int from ${hhtBlCandidateSites}
        where ${hhtBlCandidateSites.runId} = ${run.id}
      )`,
      researchSites: sql<number>`(
        select count(*)::int from ${hhtBlResearchSites}
        where ${hhtBlResearchSites.runId} = ${run.id}
      )`,
      backlinks: sql<number>`(
        select count(*)::int from ${hhtBlBacklinks}
        where ${hhtBlBacklinks.runId} = ${run.id}
      )`,
      opportunities: sql<number>`(
        select count(*)::int from ${hhtBlOpportunities}
        where ${hhtBlOpportunities.runId} = ${run.id}
      )`,
      clusters: sql<number>`(
        select count(*)::int from ${hhtBlStrategyClusters}
        where ${hhtBlStrategyClusters.runId} = ${run.id}
      )`,
      acquired: sql<number>`(
        select count(*)::int from ${hhtBlAcquiredLinks}
        where ${hhtBlAcquiredLinks.runId} = ${run.id}
      )`,
    })
    .from(hhtBlRuns)
    .where(eq(hhtBlRuns.id, run.id))
    .limit(1)

  const jobRows =
    view === 'overview'
      ? await db
          .select()
          .from(hhtBlJobs)
          .where(eq(hhtBlJobs.runId, run.id))
          .orderBy(desc(hhtBlJobs.updatedAt))
          .limit(100)
      : []
  const stageJobRows = await db
    .select({
      stage: hhtBlJobs.stage,
      status: hhtBlJobs.status,
      jobs: sql<number>`count(*)::int`,
      records: sql<number>`coalesce(sum(${hhtBlJobs.recordsCompleted}), 0)::int`,
    })
    .from(hhtBlJobs)
    .where(eq(hhtBlJobs.runId, run.id))
    .groupBy(hhtBlJobs.stage, hhtBlJobs.status)
  const candidateSites =
    view === 'sites'
      ? await db
          .select({
            id: hhtBlCandidateSites.id,
            domain: hhtBlCandidateSites.domain,
            state: hhtBlCandidateSites.state,
            provenance: hhtBlCandidateSites.provenance,
            serpAppearances: hhtBlCandidateSites.serpAppearances,
            top10Appearances: hhtBlCandidateSites.top10Appearances,
            weightedVisibility: hhtBlCandidateSites.weightedVisibility,
            researchValueScore: hhtBlCandidateSites.researchValueScore,
            researchValueMissing: hhtBlCandidateSites.researchValueMissing,
            siteType: hhtBlSiteClassifications.siteType,
            transferability: hhtBlSiteClassifications.transferability,
            authorityScore: hhtBlSiteMetrics.authorityScore,
            organicTraffic: hhtBlSiteMetrics.estimatedOrganicTraffic,
            referringDomains: hhtBlSiteMetrics.referringDomains,
          })
          .from(hhtBlCandidateSites)
          .leftJoin(
            hhtBlSiteClassifications,
            eq(hhtBlSiteClassifications.candidateSiteId, hhtBlCandidateSites.id),
          )
          .leftJoin(
            hhtBlSiteMetrics,
            eq(hhtBlSiteMetrics.candidateSiteId, hhtBlCandidateSites.id),
          )
          .where(eq(hhtBlCandidateSites.runId, run.id))
          .orderBy(
            desc(hhtBlCandidateSites.researchValueScore),
            desc(hhtBlCandidateSites.weightedVisibility),
          )
          .limit(500)
      : []
  const researchSites =
    view === 'sites'
      ? await db
          .select({
            id: hhtBlResearchSites.id,
            rank: hhtBlResearchSites.rank,
            cohort: hhtBlResearchSites.cohort,
            domain: hhtBlCandidateSites.domain,
            state: hhtBlCandidateSites.state,
            researchValueScore: hhtBlCandidateSites.researchValueScore,
            siteType: hhtBlSiteClassifications.siteType,
            authorityScore: hhtBlSiteMetrics.authorityScore,
            organicTraffic: hhtBlSiteMetrics.estimatedOrganicTraffic,
            referringDomains: hhtBlSiteMetrics.referringDomains,
            selectedReason: hhtBlResearchSites.selectedReason,
          })
          .from(hhtBlResearchSites)
          .innerJoin(
            hhtBlCandidateSites,
            eq(hhtBlResearchSites.candidateSiteId, hhtBlCandidateSites.id),
          )
          .leftJoin(
            hhtBlSiteClassifications,
            eq(hhtBlSiteClassifications.candidateSiteId, hhtBlCandidateSites.id),
          )
          .leftJoin(
            hhtBlSiteMetrics,
            eq(hhtBlSiteMetrics.candidateSiteId, hhtBlCandidateSites.id),
          )
          .where(eq(hhtBlResearchSites.runId, run.id))
          .orderBy(asc(hhtBlResearchSites.rank))
          .limit(100)
      : []
  const backlinks =
    view === 'backlinks'
      ? await db
          .select({
            id: hhtBlBacklinks.id,
            state: hhtBlBacklinks.state,
            referringDomain: hhtBlReferringDomains.domain,
            sourceUrl: hhtBlBacklinks.sourceUrl,
            sourceTitle: hhtBlBacklinks.sourceTitle,
            competitorDomain: hhtBlCandidateSites.domain,
            targetUrl: hhtBlBacklinks.targetUrl,
            anchor: hhtBlBacklinks.anchor,
            follow: hhtBlBacklinks.follow,
            authorityScore: hhtBlBacklinks.authorityScore,
            firstSeenAt: hhtBlBacklinks.firstSeenAt,
            mechanism: hhtBlLinkAnalyses.mechanism,
            mechanismConfidence: hhtBlLinkAnalyses.mechanismConfidence,
            overallScore: hhtBlOpportunities.overallScore,
          })
          .from(hhtBlBacklinks)
          .innerJoin(
            hhtBlReferringDomains,
            eq(hhtBlBacklinks.referringDomainId, hhtBlReferringDomains.id),
          )
          .innerJoin(
            hhtBlResearchSites,
            eq(hhtBlBacklinks.researchSiteId, hhtBlResearchSites.id),
          )
          .innerJoin(
            hhtBlCandidateSites,
            eq(hhtBlResearchSites.candidateSiteId, hhtBlCandidateSites.id),
          )
          .leftJoin(
            hhtBlLinkAnalyses,
            eq(hhtBlLinkAnalyses.backlinkId, hhtBlBacklinks.id),
          )
          .leftJoin(
            hhtBlOpportunities,
            eq(hhtBlOpportunities.backlinkId, hhtBlBacklinks.id),
          )
          .where(eq(hhtBlBacklinks.runId, run.id))
          .orderBy(
            desc(hhtBlOpportunities.overallScore),
            desc(hhtBlBacklinks.authorityScore),
          )
          .limit(500)
      : []
  const opportunities =
    view === 'opportunities'
      ? await db
          .select({
            id: hhtBlOpportunities.id,
            rank: hhtBlOpportunities.rank,
            status: hhtBlOpportunities.status,
            linkValue: hhtBlOpportunities.linkValue,
            gettability: hhtBlOpportunities.gettability,
            transferability: hhtBlOpportunities.transferability,
            effort: hhtBlOpportunities.effort,
            overallScore: hhtBlOpportunities.overallScore,
            expectedValue: hhtBlOpportunities.expectedValue,
            referringDomain: hhtBlReferringDomains.domain,
            sourceUrl: hhtBlBacklinks.sourceUrl,
            competitorDomain: hhtBlCandidateSites.domain,
            mechanism: hhtBlLinkAnalyses.mechanism,
            recommendedAction: hhtBlLinkAnalyses.recommendedAction,
            evidence: hhtBlLinkAnalyses.evidence,
            requiresNewAsset: hhtBlLinkAnalyses.requiresNewAsset,
            requiredAssetType: hhtBlLinkAnalyses.requiredAssetType,
          })
          .from(hhtBlOpportunities)
          .innerJoin(
            hhtBlBacklinks,
            eq(hhtBlOpportunities.backlinkId, hhtBlBacklinks.id),
          )
          .innerJoin(
            hhtBlReferringDomains,
            eq(hhtBlBacklinks.referringDomainId, hhtBlReferringDomains.id),
          )
          .innerJoin(
            hhtBlResearchSites,
            eq(hhtBlBacklinks.researchSiteId, hhtBlResearchSites.id),
          )
          .innerJoin(
            hhtBlCandidateSites,
            eq(hhtBlResearchSites.candidateSiteId, hhtBlCandidateSites.id),
          )
          .innerJoin(
            hhtBlLinkAnalyses,
            eq(hhtBlLinkAnalyses.backlinkId, hhtBlBacklinks.id),
          )
          .where(eq(hhtBlOpportunities.runId, run.id))
          .orderBy(
            asc(hhtBlOpportunities.rank),
            desc(hhtBlOpportunities.overallScore),
          )
          .limit(500)
      : []
  const clusters =
    view === 'strategies'
      ? await db
          .select()
          .from(hhtBlStrategyClusters)
          .where(eq(hhtBlStrategyClusters.runId, run.id))
          .orderBy(desc(hhtBlStrategyClusters.estimatedCampaignValue))
          .limit(100)
      : []
  const campaigns =
    view === 'strategies'
      ? await db
          .select()
          .from(hhtBlCampaignCandidates)
          .where(eq(hhtBlCampaignCandidates.runId, run.id))
          .orderBy(desc(hhtBlCampaignCandidates.potentialProspects))
          .limit(100)
      : []
  const acquiredLinks =
    view === 'acquired'
      ? await db
          .select()
          .from(hhtBlAcquiredLinks)
          .where(eq(hhtBlAcquiredLinks.runId, run.id))
          .orderBy(desc(hhtBlAcquiredLinks.acquiredAt))
          .limit(500)
      : []
  const events =
    view === 'overview'
      ? await db
          .select()
          .from(hhtBlRunEvents)
          .where(eq(hhtBlRunEvents.runId, run.id))
          .orderBy(desc(hhtBlRunEvents.createdAt))
          .limit(50)
      : []
  const costRows =
    view === 'overview'
      ? await db
          .select({
            calls: sql<number>`count(*)::int`,
            rows: sql<number>`coalesce(sum(${hhtBlRawResponses.rowsReceived}), 0)::int`,
            knownUnits: sql<number | null>`sum(${hhtBlRawResponses.estimatedUnitsConsumed})::float`,
            unknownCalls: sql<number>`count(*) filter (where ${hhtBlRawResponses.estimatedUnitsConsumed} is null)::int`,
          })
          .from(hhtBlRawResponses)
          .where(eq(hhtBlRawResponses.runId, run.id))
      : []

  const stages: HhtBlStageProgress[] = HHT_BL_STAGES.map((stage) => {
    const stageJobs = stageJobRows.filter((job) => job.stage === stage)
    const stageIndex = HHT_BL_STAGES.indexOf(stage)
    const currentStageIndex = HHT_BL_STAGES.indexOf(run.currentStage)
    let status: HhtBlStageStatus = 'not_started'
    if (run.status === 'COMPLETE' && stageIndex <= currentStageIndex) status = 'complete'
    else if (stageJobs.some((job) => job.status === 'WAITING_FOR_CREDENTIALS')) status = 'waiting'
    else if (stageJobs.some((job) => job.status === 'FAILED')) status = 'failed'
    else if (stageJobs.some((job) => job.status === 'RUNNING')) status = 'running'
    else if (
      stageJobs.length > 0 &&
      stageJobs.every((job) => job.status === 'COMPLETE' || job.status === 'CANCELLED')
    ) {
      status = 'complete'
    } else if (stageJobs.length > 0) status = 'pending'
    else if (stageIndex < currentStageIndex) status = 'complete'
    else if (stageIndex === currentStageIndex && run.status === 'RUNNING') status = 'running'
    return {
      stage,
      status,
      jobs: stageJobs.reduce((sum, job) => sum + job.jobs, 0),
      records: stageJobs.reduce((sum, job) => sum + job.records, 0),
    }
  })

  return {
    site,
    run,
    stages,
    counts: counts ?? {
      candidates: 0,
      researchSites: 0,
      backlinks: 0,
      opportunities: 0,
      clusters: 0,
      acquired: 0,
    },
    jobs: jobRows,
    candidateSites,
    researchSites,
    backlinks,
    opportunities,
    clusters,
    campaigns,
    acquiredLinks,
    events,
    cost: costRows[0] ?? null,
  }
}
