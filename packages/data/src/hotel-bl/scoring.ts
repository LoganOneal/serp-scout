import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  buildHotelBlContentClusters,
  explainHotelBlOpportunity,
  recommendHotelBlContent,
  scoreHotelBlEffort,
  scoreHotelBlFeasibility,
  scoreHotelBlLinkValue,
  scoreHotelBlPriority,
  type HotelBlContentType,
  type HotelBlRelationshipType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hotelBlContacts,
  hotelBlContentOpportunities,
  hotelBlDomains,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlOpportunities,
  hotelBlRelationships,
  hotelBlRuns,
} from '../schema.js'

export const HOTEL_BL_SEMRUSH_FEASIBILITY_THRESHOLD = 50

function chunks<T>(values: T[], size = 400): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

export async function recalculateHotelBlOpportunities(
  db: Database,
  runId: number,
): Promise<{ opportunities: number; semrushJobsQueued: number; contentOpportunities: number }> {
  const rows = await db
    .select({
      relationshipId: hotelBlRelationships.id,
      relationshipType: hotelBlRelationships.relationshipType,
      entityScope: hotelBlRelationships.entityScope,
      entityType: hotelBlRelationships.entityType,
      manualRelationshipType: hotelBlRelationships.manualRelationshipType,
      relationshipNeedsReview: hotelBlRelationships.needsReview,
      hotelId: hotelBlHotels.id,
      hotelName: hotelBlHotels.hotelName,
      city: hotelBlHotels.city,
      state: hotelBlHotels.state,
      existingHhtUrl: hotelBlHotels.existingHhtUrl,
      hotelNeedsReview: hotelBlHotels.needsReview,
      domainId: hotelBlDomains.id,
      rootDomain: hotelBlDomains.rootDomain,
      siteControlType: hotelBlDomains.siteControlType,
      manualSiteControlType: hotelBlDomains.manualSiteControlType,
      domainNeedsReview: hotelBlDomains.needsReview,
      externalPressLinkCount: hotelBlDomains.externalPressLinkCount,
      dofollowExternalPressLinkCount: hotelBlDomains.dofollowExternalPressLinkCount,
      hasPressPage: hotelBlDomains.hasPressPage,
      hasAwardsPage: hotelBlDomains.hasAwardsPage,
      hasBlogOrNews: hotelBlDomains.hasBlogOrNews,
      hasNamedPrContact: hotelBlDomains.hasNamedPrContact,
      hasPrEmail: hotelBlDomains.hasPrEmail,
      freshnessDays: hotelBlDomains.freshnessDays,
      latestPressDate: hotelBlDomains.latestPressDate,
      authorityScore: hotelBlDomains.authorityScore,
      organicTraffic: hotelBlDomains.organicTraffic,
      referringDomains: hotelBlDomains.referringDomains,
      alreadyLinksToHht: hotelBlDomains.alreadyLinksToHht,
      semrushMeasuredAt: hotelBlDomains.semrushMeasuredAt,
    })
    .from(hotelBlRelationships)
    .innerJoin(hotelBlHotels, eq(hotelBlRelationships.hotelId, hotelBlHotels.id))
    .innerJoin(hotelBlDomains, eq(hotelBlRelationships.domainId, hotelBlDomains.id))
    .where(eq(hotelBlHotels.lastRunId, runId))

  if (rows.length === 0) return { opportunities: 0, semrushJobsQueued: 0, contentOpportunities: 0 }

  const domainIds = [...new Set(rows.map((row) => row.domainId))]
  const contactRows = await db
    .select({ domainId: hotelBlContacts.domainId, contactType: hotelBlContacts.contactType })
    .from(hotelBlContacts)
    .where(inArray(hotelBlContacts.domainId, domainIds))
  const contactTypesByDomain = new Map<number, Set<string>>()
  for (const contact of contactRows) {
    const types = contactTypesByDomain.get(contact.domainId) ?? new Set<string>()
    types.add(contact.contactType)
    contactTypesByDomain.set(contact.domainId, types)
  }

  const existing = await db
    .select({
      id: hotelBlOpportunities.id,
      hotelId: hotelBlOpportunities.hotelId,
      domainId: hotelBlOpportunities.domainId,
      relationshipType: hotelBlOpportunities.relationshipType,
      status: hotelBlOpportunities.status,
      manualRecommendedContentType: hotelBlOpportunities.manualRecommendedContentType,
    })
    .from(hotelBlOpportunities)
    .where(inArray(hotelBlOpportunities.hotelId, [...new Set(rows.map((row) => row.hotelId))]))
  const existingByKey = new Map(
    existing.map((row) => [`${row.hotelId}:${row.domainId}:${row.relationshipType}`, row]),
  )
  const sourceByKey = new Map(
    rows.map((row) => [`${row.hotelId}:${row.domainId}:${row.relationshipType}`, row]),
  )

  const values = rows.map((row) => {
    const effectiveRelationshipType = (row.manualRelationshipType ?? row.relationshipType) as HotelBlRelationshipType
    const siteControlType = row.manualSiteControlType ?? row.siteControlType
    const contactTypes = contactTypesByDomain.get(row.domainId) ?? new Set<string>()
    const hasPrContact = row.hasNamedPrContact || contactTypes.has('pr') || contactTypes.has('media')
    const feasibility = scoreHotelBlFeasibility({
      siteControlType,
      entityScope: row.entityScope,
      externalPressLinkCount: row.externalPressLinkCount,
      dofollowExternalPressLinkCount: row.dofollowExternalPressLinkCount,
      hasPressPage: row.hasPressPage,
      hasAwardsPage: row.hasAwardsPage,
      hasBlogOrNews: row.hasBlogOrNews,
      hasNamedPrContact: hasPrContact,
      hasPrEmail: row.hasPrEmail,
      freshnessDays: row.freshnessDays,
    })
    const generatedRecommendation = recommendHotelBlContent({
      hotelName: row.hotelName,
      city: row.city,
      state: row.state,
      existingHhtUrl: row.existingHhtUrl,
      hasPressPage: row.hasPressPage,
      hasAwardsPage: row.hasAwardsPage,
      hasBlogOrNews: row.hasBlogOrNews,
    })
    const key = `${row.hotelId}:${row.domainId}:${row.relationshipType}`
    const prior = existingByKey.get(key)
    const contentType = (prior?.manualRecommendedContentType ?? generatedRecommendation.contentType) as HotelBlContentType
    const contentFit = generatedRecommendation.alternatives[contentType]
    const topicalRelevance =
      effectiveRelationshipType === 'property' || effectiveRelationshipType === 'locality'
        ? 100
        : effectiveRelationshipType === 'management_company' || effectiveRelationshipType === 'owner'
          ? 90
          : 80
    const linkValue = scoreHotelBlLinkValue({
      authorityScore: row.authorityScore,
      organicTraffic: row.organicTraffic,
      topicalRelevance,
      recommendedContentType: contentType,
      alreadyLinksToHht: row.alreadyLinksToHht,
    })
    const needsReview =
      row.relationshipNeedsReview ||
      row.domainNeedsReview ||
      (row.hotelNeedsReview && (row.entityScope === 'hotel' || row.entityScope === 'unknown'))
    const effort = scoreHotelBlEffort({
      hasSuitableHhtPage: Boolean(row.existingHhtUrl),
      hasPressPage: row.hasPressPage,
      hasPrEmail: row.hasPrEmail,
      relationshipType: effectiveRelationshipType,
      contentType,
      needsReview,
    })
    const priority = scoreHotelBlPriority({
      feasibility: feasibility.score,
      linkValue: linkValue.score,
      contentFit,
      effort,
    })
    return {
      hotelId: row.hotelId,
      domainId: row.domainId,
      relationshipId: row.relationshipId,
      relationshipType: row.relationshipType,
      feasibilityScore: feasibility.score,
      feasibilityComponents: feasibility.components,
      linkValueScore: linkValue.score,
      linkValueComponents: linkValue.components,
      contentFitScore: contentFit,
      contentFitComponents: generatedRecommendation.alternatives,
      effortScore: effort,
      priorityScore: priority,
      recommendedContentType: generatedRecommendation.contentType,
      recommendedTargetPage: generatedRecommendation.targetPage,
      recommendedPitchAngle: generatedRecommendation.pitchAngle,
      reasoningSummary: explainHotelBlOpportunity({
        siteControlType,
        externalPressLinkCount: row.externalPressLinkCount,
        dofollowExternalPressLinkCount: row.dofollowExternalPressLinkCount,
        hasPressPage: row.hasPressPage,
        latestPressDate: row.latestPressDate?.toISOString().slice(0, 10) ?? null,
        hasPrContact,
        recommendedContentType: contentType,
        city: row.city,
      }),
      status: prior?.status ?? ('new' as const),
      needsReview,
      manualRecommendedContentType: prior?.manualRecommendedContentType ?? null,
      updatedAt: new Date(),
    }
  })

  for (const batch of chunks(values)) {
    await db
      .insert(hotelBlOpportunities)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          hotelBlOpportunities.hotelId,
          hotelBlOpportunities.domainId,
          hotelBlOpportunities.relationshipType,
        ],
        set: {
          relationshipId: sql`excluded.relationship_id`,
          feasibilityScore: sql`excluded.feasibility_score`,
          feasibilityComponents: sql`excluded.feasibility_components`,
          linkValueScore: sql`excluded.link_value_score`,
          linkValueComponents: sql`excluded.link_value_components`,
          contentFitScore: sql`excluded.content_fit_score`,
          contentFitComponents: sql`excluded.content_fit_components`,
          effortScore: sql`excluded.effort_score`,
          priorityScore: sql`excluded.priority_score`,
          recommendedContentType: sql`excluded.recommended_content_type`,
          recommendedTargetPage: sql`excluded.recommended_target_page`,
          recommendedPitchAngle: sql`excluded.recommended_pitch_angle`,
          reasoningSummary: sql`excluded.reasoning_summary`,
          needsReview: sql`excluded.needs_review`,
          updatedAt: new Date(),
        },
      })
  }

  await db.execute(sql`
    update hotel_bl_domains d
       set backlink_value_score = scores.max_value,
           updated_at = now()
      from (
        select o.domain_id, max(o.link_value_score) as max_value
          from hotel_bl_opportunities o
          join hotel_bl_hotels h on h.id = o.hotel_id
         where h.last_run_id = ${runId}
         group by o.domain_id
      ) scores
     where d.id = scores.domain_id
  `)

  const viableDomainIds = [...new Set(values.filter((value) => value.feasibilityScore >= HOTEL_BL_SEMRUSH_FEASIBILITY_THRESHOLD).map((value) => value.domainId))]
  const semrushJobRows: Array<typeof hotelBlJobs.$inferInsert> = []
  for (const domainId of viableDomainIds) {
    const domain = rows.find((row) => row.domainId === domainId)
    if (!domain) continue
    const fresh = domain.semrushMeasuredAt && Date.now() - domain.semrushMeasuredAt.getTime() < 30 * 86_400_000
    const requests = [
      ...(!fresh && domain.organicTraffic === null
        ? [{
            report: 'domain_rank',
            params: {
              target: domain.rootDomain,
              database: 'us',
              export_columns: ['domain', 'organic_keywords', 'organic_traffic', 'organic_traffic_cost'],
            },
          }]
        : []),
      ...(!fresh && (domain.authorityScore === null || domain.referringDomains === null)
        ? [{
            report: 'backlinks_overview',
            params: {
              target: domain.rootDomain,
              target_type: 'root_domain',
              export_columns: ['target', 'target_type', 'authority_score', 'backlinks_num', 'domains_num', 'follows_num', 'nofollows_num'],
            },
          }]
        : []),
    ]
    for (const request of requests) {
      semrushJobRows.push({
        runId,
        domainId,
        stage: 'semrush_enrichment',
        requestKey: `semrush:${request.report}:${domainId}`,
        configuration: request,
      })
    }
  }
  let semrushJobsQueued = 0
  for (const batch of chunks(semrushJobRows)) {
    const inserted = await db
      .insert(hotelBlJobs)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: hotelBlJobs.id })
    semrushJobsQueued += inserted.length
  }

  const scored = values.map((value) => {
    const row = sourceByKey.get(`${value.hotelId}:${value.domainId}:${value.relationshipType}`)!
    return {
      hotelId: value.hotelId,
      hotelName: row.hotelName,
      city: row.city,
      state: row.state,
      feasibilityScore: value.feasibilityScore,
      priorityScore: value.priorityScore,
      rootDomain: row.rootDomain,
    }
  })
  const clusters = buildHotelBlContentClusters(scored)
  await db.delete(hotelBlContentOpportunities).where(eq(hotelBlContentOpportunities.runId, runId))
  if (clusters.length > 0) {
    await db.insert(hotelBlContentOpportunities).values(
      clusters.map((cluster) => ({
        runId,
        ...cluster,
        strongPressBehaviorCount: scored.filter(
          (row) => row.feasibilityScore >= 70 && row.state && cluster.geography.includes(row.state),
        ).length,
      })),
    )
  }

  await db
    .update(hotelBlRuns)
    .set({
      currentStage: 'calculate_priorities',
      progress: {
        opportunities: values.length,
        semrushJobsQueued,
        contentOpportunities: clusters.length,
      },
      updatedAt: new Date(),
    })
    .where(eq(hotelBlRuns.id, runId))

  return { opportunities: values.length, semrushJobsQueued, contentOpportunities: clusters.length }
}

export async function importHotelBlSemrushMetrics(
  db: Database,
  input: {
    runId: number
    domain: string
    authorityScore?: number | null
    organicTraffic?: number | null
    referringDomains?: number | null
    alreadyLinksToHht?: boolean | null
    raw: Record<string, unknown>
    deferRecalculation?: boolean
  },
): Promise<void> {
  await db
    .update(hotelBlDomains)
    .set({
      ...(input.authorityScore === undefined ? {} : { authorityScore: input.authorityScore }),
      ...(input.organicTraffic === undefined ? {} : { organicTraffic: input.organicTraffic }),
      ...(input.referringDomains === undefined ? {} : { referringDomains: input.referringDomains }),
      ...(input.alreadyLinksToHht === undefined ? {} : { alreadyLinksToHht: input.alreadyLinksToHht }),
      semrushRaw: sql`coalesce(${hotelBlDomains.semrushRaw}, '{}'::jsonb) || ${JSON.stringify(input.raw)}::jsonb`,
      semrushMeasuredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(hotelBlDomains.rootDomain, input.domain), eq(hotelBlDomains.lastRunId, input.runId)))
  if (!input.deferRecalculation) await recalculateHotelBlOpportunities(db, input.runId)
}
