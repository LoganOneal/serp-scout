import 'server-only'
import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm'
import {
  hotelBlContactChannel,
  type HotelBlContactChannel,
  type HotelBlContactType,
  type HotelBlContentType,
  type HotelBlEntityScope,
  type HotelBlRelationshipType,
  type HotelBlSiteControlType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hotelBlContacts,
  hotelBlContentOpportunities,
  hotelBlDiscoveredPages,
  hotelBlDomains,
  hotelBlEditorialLinks,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlOpportunities,
  hotelBlOutcomes,
  hotelBlRelationships,
  hotelBlRunEvents,
  hotelBlRuns,
} from '../schema.js'

export type HotelBlDashboardView = 'overview' | 'opportunities' | 'hotels' | 'domains' | 'content' | 'runs'

export interface HotelBlOpportunityFilters {
  minimumPriority?: number
  minimumFeasibility?: number
  minimumLinkValue?: number
  independentOnly?: boolean
  chainOnly?: boolean
  hasPressPage?: boolean
  hasFollowedPressLinks?: boolean
  hasPrContact?: boolean
  relationshipType?: HotelBlRelationshipType
  entityScope?: HotelBlEntityScope
  state?: string
  city?: string
  contentType?: HotelBlContentType
  crawlStatus?: string
  sort?: 'priority' | 'feasibility' | 'link_value' | 'effort' | 'hotel' | 'state'
  direction?: 'asc' | 'desc'
}

function opportunityConditions(filters: HotelBlOpportunityFilters): SQL[] {
  const conditions: SQL[] = []
  if (filters.minimumPriority !== undefined) conditions.push(gte(hotelBlOpportunities.priorityScore, filters.minimumPriority))
  if (filters.minimumFeasibility !== undefined) conditions.push(gte(hotelBlOpportunities.feasibilityScore, filters.minimumFeasibility))
  if (filters.minimumLinkValue !== undefined) conditions.push(gte(hotelBlOpportunities.linkValueScore, filters.minimumLinkValue))
  if (filters.independentOnly) conditions.push(sql`coalesce(${hotelBlDomains.manualSiteControlType}, ${hotelBlDomains.siteControlType}) = 'independent_property'`)
  if (filters.chainOnly) conditions.push(sql`coalesce(${hotelBlDomains.manualSiteControlType}, ${hotelBlDomains.siteControlType}) in ('brand_property_page', 'brand_root')`)
  if (filters.hasPressPage) conditions.push(eq(hotelBlDomains.hasPressPage, true))
  if (filters.hasFollowedPressLinks) conditions.push(gte(hotelBlDomains.dofollowExternalPressLinkCount, 1))
  if (filters.hasPrContact) conditions.push(or(eq(hotelBlDomains.hasPrEmail, true), eq(hotelBlDomains.hasNamedPrContact, true))!)
  if (filters.relationshipType) conditions.push(sql`coalesce(${hotelBlRelationships.manualRelationshipType}, ${hotelBlOpportunities.relationshipType}) = ${filters.relationshipType}`)
  if (filters.entityScope) conditions.push(eq(hotelBlRelationships.entityScope, filters.entityScope))
  if (filters.state) conditions.push(eq(hotelBlHotels.state, filters.state))
  if (filters.city) conditions.push(eq(hotelBlHotels.city, filters.city))
  if (filters.contentType) conditions.push(sql`coalesce(${hotelBlOpportunities.manualRecommendedContentType}, ${hotelBlOpportunities.recommendedContentType}) = ${filters.contentType}`)
  if (filters.crawlStatus) conditions.push(eq(hotelBlDomains.crawlStatus, filters.crawlStatus))
  return conditions
}

function bestContactColumn(column: 'name' | 'title' | 'email' | 'phone' | 'contact_type' | 'source_url') {
  return sql`(
    select c.${sql.raw(column)}
      from ${hotelBlContacts} c
     where c.domain_id = ${hotelBlDomains.id}
     order by
       case c.contact_type
         when 'pr' then 0
         when 'media' then 1
         when 'marketing' then 2
         when 'management' then 3
         else 4
       end,
       (c.email is not null) desc,
       (c.name is not null) desc,
       c.confidence desc nulls last,
       c.id
     limit 1
  )`
}

const contactPageUrlSql = sql<string | null>`(
  select p.url
    from ${hotelBlDiscoveredPages} p
   where p.domain_id = ${hotelBlDomains.id}
     and p.page_type in ('contact', 'press', 'media')
     and p.status_code is not null
     and p.status_code < 400
   order by
     case p.page_type
       when 'press' then 0
       when 'media' then 1
       when 'contact' then 2
       else 3
     end,
     p.id
   limit 1
)`

export async function listHotelBlOpportunities(
  db: Database,
  filters: HotelBlOpportunityFilters = {},
  limit = 500,
) {
  const sortColumns = {
    priority: hotelBlOpportunities.priorityScore,
    feasibility: hotelBlOpportunities.feasibilityScore,
    link_value: hotelBlOpportunities.linkValueScore,
    effort: hotelBlOpportunities.effortScore,
    hotel: hotelBlHotels.hotelName,
    state: hotelBlHotels.state,
  } as const
  const sortColumn = sortColumns[filters.sort ?? 'priority']
  const order = filters.direction === 'asc' ? asc(sortColumn) : desc(sortColumn)
  const rows = await db
    .select({
      id: hotelBlOpportunities.id,
      hotelId: hotelBlHotels.id,
      hotelName: hotelBlHotels.hotelName,
      city: hotelBlHotels.city,
      state: hotelBlHotels.state,
      brandName: hotelBlHotels.brandName,
      domainId: hotelBlDomains.id,
      targetEntity: sql<string | null>`coalesce(${hotelBlRelationships.entityName}, ${hotelBlDomains.entityName})`,
      entityScope: hotelBlRelationships.entityScope,
      entityType: hotelBlRelationships.entityType,
      urlValidationStatus: hotelBlRelationships.urlValidationStatus,
      urlValidationConfidence: hotelBlRelationships.urlValidationConfidence,
      urlValidationReason: hotelBlRelationships.urlValidationReason,
      relationshipType: sql<HotelBlRelationshipType>`coalesce(${hotelBlRelationships.manualRelationshipType}, ${hotelBlOpportunities.relationshipType})`,
      domain: hotelBlDomains.domain,
      siteControlType: sql<HotelBlSiteControlType>`coalesce(${hotelBlDomains.manualSiteControlType}, ${hotelBlDomains.siteControlType})`,
      feasibilityScore: hotelBlOpportunities.feasibilityScore,
      feasibilityComponents: hotelBlOpportunities.feasibilityComponents,
      linkValueScore: hotelBlOpportunities.linkValueScore,
      linkValueComponents: hotelBlOpportunities.linkValueComponents,
      contentFitScore: hotelBlOpportunities.contentFitScore,
      contentFitComponents: hotelBlOpportunities.contentFitComponents,
      effortScore: hotelBlOpportunities.effortScore,
      priorityScore: hotelBlOpportunities.priorityScore,
      hasPressPage: hotelBlDomains.hasPressPage,
      externalPressLinkCount: hotelBlDomains.externalPressLinkCount,
      dofollowExternalPressLinkCount: hotelBlDomains.dofollowExternalPressLinkCount,
      latestPressDate: hotelBlDomains.latestPressDate,
      hasPrContact: sql<boolean>`(${hotelBlDomains.hasPrEmail} or ${hotelBlDomains.hasNamedPrContact})`,
      hasPressKit: hotelBlDomains.hasPressKit,
      prName: sql<string | null>`${bestContactColumn('name')}`,
      prTitle: sql<string | null>`${bestContactColumn('title')}`,
      prEmail: sql<string | null>`${bestContactColumn('email')}`,
      prPhone: sql<string | null>`${bestContactColumn('phone')}`,
      prContactType: sql<HotelBlContactType | null>`${bestContactColumn('contact_type')}`,
      prSourceUrl: sql<string | null>`${bestContactColumn('source_url')}`,
      contactPageUrl: contactPageUrlSql,
      authorityScore: hotelBlDomains.authorityScore,
      organicTraffic: hotelBlDomains.organicTraffic,
      referringDomains: hotelBlDomains.referringDomains,
      recommendedContentType: hotelBlOpportunities.recommendedContentType,
      manualRecommendedContentType: hotelBlOpportunities.manualRecommendedContentType,
      recommendedTargetPage: hotelBlOpportunities.recommendedTargetPage,
      recommendedPitchAngle: hotelBlOpportunities.recommendedPitchAngle,
      reasoningSummary: hotelBlOpportunities.reasoningSummary,
      status: hotelBlOpportunities.status,
      needsReview: hotelBlOpportunities.needsReview,
      crawlStatus: hotelBlDomains.crawlStatus,
    })
    .from(hotelBlOpportunities)
    .innerJoin(hotelBlHotels, eq(hotelBlOpportunities.hotelId, hotelBlHotels.id))
    .innerJoin(hotelBlDomains, eq(hotelBlOpportunities.domainId, hotelBlDomains.id))
    .innerJoin(hotelBlRelationships, eq(hotelBlOpportunities.relationshipId, hotelBlRelationships.id))
    .where(and(...opportunityConditions(filters)))
    .orderBy(order, desc(hotelBlOpportunities.priorityScore))
    .limit(Math.max(1, Math.min(limit, 20_000)))
  return rows.map((row) => ({
    ...row,
    contactChannel: hotelBlContactChannel({
      email: row.prEmail,
      name: row.prName,
      contactPageUrl: row.contactPageUrl,
    }) satisfies HotelBlContactChannel,
  }))
}

export async function getHotelBlDashboard(
  db: Database,
  view: HotelBlDashboardView,
  filters: HotelBlOpportunityFilters = {},
) {
  const [run] = await db.select().from(hotelBlRuns).orderBy(desc(hotelBlRuns.createdAt)).limit(1)
  if (!run) {
    return {
      run: null,
      counts: null,
      opportunities: [],
      hotels: [],
      domains: [],
      contentOpportunities: [],
      runs: [],
      jobs: [],
      events: [],
      breakdowns: { roles: [], controls: [], feasibility: [], states: [], treatments: [] },
      filterOptions: { states: [], cities: [] },
    }
  }

  const [counts] = await db
    .select({
      hotels: sql<number>`(select count(*)::int from ${hotelBlHotels} where ${hotelBlHotels.lastRunId} = ${run.id})`,
      domains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id})`,
      hotelDomains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.entityScope} = 'hotel')`,
      localityDomains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.entityScope} = 'locality')`,
      otherDomains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.entityScope} = 'other')`,
      validatedUrls: sql<number>`(select count(*)::int from ${hotelBlHotels} where ${hotelBlHotels.lastRunId} = ${run.id} and ${hotelBlHotels.urlValidatedAt} is not null)`,
      discrepantUrls: sql<number>`(select count(*)::int from ${hotelBlHotels} where ${hotelBlHotels.lastRunId} = ${run.id} and ${hotelBlHotels.urlValidationStatus} in ('locality', 'non_hotel', 'mismatch', 'unreachable', 'missing', 'ambiguous'))`,
      analyzedDomains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.crawlStatus} = 'complete')`,
      pendingDomains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.crawlStatus} in ('pending', 'running'))`,
      highFeasibility: sql<number>`(select count(*)::int from ${hotelBlOpportunities} o join ${hotelBlHotels} h on h.id = o.hotel_id where h.last_run_id = ${run.id} and o.feasibility_score >= 75)`,
      highPriority: sql<number>`(select count(*)::int from ${hotelBlOpportunities} o join ${hotelBlHotels} h on h.id = o.hotel_id where h.last_run_id = ${run.id} and o.priority_score >= 60)`,
      pressPages: sql<number>`(select count(distinct r.hotel_id)::int from ${hotelBlRelationships} r join ${hotelBlDomains} d on d.id = r.domain_id join ${hotelBlHotels} h on h.id = r.hotel_id where h.last_run_id = ${run.id} and d.has_press_page)`,
      followedMediaDomains: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.dofollowExternalPressLinkCount} > 0)`,
      prContacts: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and (${hotelBlDomains.hasPrEmail} or ${hotelBlDomains.hasNamedPrContact}))`,
      managementCompanies: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.entityType} = 'management_company')`,
      owners: sql<number>`(select count(*)::int from ${hotelBlDomains} where ${hotelBlDomains.lastRunId} = ${run.id} and ${hotelBlDomains.entityType} = 'owner')`,
      newReferringDomains: sql<number>`(select count(distinct d.root_domain)::int from ${hotelBlOpportunities} o join ${hotelBlDomains} d on d.id = o.domain_id join ${hotelBlHotels} h on h.id = o.hotel_id where h.last_run_id = ${run.id} and o.feasibility_score >= 50 and coalesce(d.already_links_to_hht, false) = false)`,
      acquired: sql<number>`(select count(*)::int from ${hotelBlOutcomes} bo join ${hotelBlOpportunities} o on o.id = bo.opportunity_id join ${hotelBlHotels} h on h.id = o.hotel_id where h.last_run_id = ${run.id} and bo.backlink_acquired)`,
    })
    .from(hotelBlRuns)
    .where(eq(hotelBlRuns.id, run.id))
    .limit(1)

  const [opportunities, hotels, domains, contentOpportunities, runs, jobs, events, roles, controls, feasibility, states, treatments, filterStates, filterCities] = await Promise.all([
    view === 'opportunities' ? listHotelBlOpportunities(db, filters) : Promise.resolve([]),
    view === 'hotels'
      ? db
          .select({
            id: hotelBlHotels.id,
            hotelName: hotelBlHotels.hotelName,
            city: hotelBlHotels.city,
            state: hotelBlHotels.state,
            country: hotelBlHotels.country,
            brandName: hotelBlHotels.brandName,
            siteControlType: hotelBlHotels.siteControlType,
            manualSiteControlType: hotelBlHotels.manualSiteControlType,
            siteControlConfidence: hotelBlHotels.siteControlConfidence,
            sourceUrl: hotelBlHotels.sourceUrl,
            candidateFinalUrl: hotelBlHotels.candidateFinalUrl,
            sourceEntityScope: hotelBlHotels.sourceEntityScope,
            sourceEntityType: hotelBlHotels.sourceEntityType,
            urlValidationStatus: hotelBlHotels.urlValidationStatus,
            urlValidationConfidence: hotelBlHotels.urlValidationConfidence,
            urlValidationReason: hotelBlHotels.urlValidationReason,
            listingMatched: hotelBlHotels.listingMatched,
            listingSourceUrl: hotelBlHotels.listingSourceUrl,
            canonicalPropertyDomain: hotelBlHotels.canonicalPropertyDomain,
            existingHhtUrl: hotelBlHotels.existingHhtUrl,
            needsReview: hotelBlHotels.needsReview,
            opportunities: sql<number>`count(${hotelBlOpportunities.id})::int`,
            maxPriority: sql<number>`max(${hotelBlOpportunities.priorityScore})`,
          })
          .from(hotelBlHotels)
          .leftJoin(hotelBlOpportunities, eq(hotelBlOpportunities.hotelId, hotelBlHotels.id))
          .where(eq(hotelBlHotels.lastRunId, run.id))
          .groupBy(hotelBlHotels.id)
          .orderBy(desc(sql`max(${hotelBlOpportunities.priorityScore})`), asc(hotelBlHotels.hotelName))
          .limit(1_000)
      : Promise.resolve([]),
    view === 'domains'
      ? db.select().from(hotelBlDomains).where(eq(hotelBlDomains.lastRunId, run.id)).orderBy(desc(hotelBlDomains.backlinkValueScore), desc(hotelBlDomains.dofollowExternalPressLinkCount), asc(hotelBlDomains.domain)).limit(1_000)
      : Promise.resolve([]),
    view === 'content'
      ? db.select().from(hotelBlContentOpportunities).where(eq(hotelBlContentOpportunities.runId, run.id)).orderBy(desc(hotelBlContentOpportunities.contentRoiScore)).limit(500)
      : Promise.resolve([]),
    view === 'runs' ? db.select().from(hotelBlRuns).orderBy(desc(hotelBlRuns.createdAt)).limit(50) : Promise.resolve([]),
    view === 'runs' || view === 'overview' ? db.select().from(hotelBlJobs).where(eq(hotelBlJobs.runId, run.id)).orderBy(desc(hotelBlJobs.updatedAt)).limit(250) : Promise.resolve([]),
    view === 'runs' || view === 'overview' ? db.select().from(hotelBlRunEvents).where(eq(hotelBlRunEvents.runId, run.id)).orderBy(desc(hotelBlRunEvents.createdAt)).limit(100) : Promise.resolve([]),
    view === 'overview' ? db.select({ label: hotelBlDomains.entityScope, count: sql<number>`count(*)::int` }).from(hotelBlDomains).where(eq(hotelBlDomains.lastRunId, run.id)).groupBy(hotelBlDomains.entityScope).orderBy(desc(sql`count(*)`)) : Promise.resolve([]),
    view === 'overview' ? db.select({ label: sql<HotelBlSiteControlType>`coalesce(${hotelBlDomains.manualSiteControlType}, ${hotelBlDomains.siteControlType})`, count: sql<number>`count(*)::int` }).from(hotelBlDomains).where(eq(hotelBlDomains.lastRunId, run.id)).groupBy(sql`coalesce(${hotelBlDomains.manualSiteControlType}, ${hotelBlDomains.siteControlType})`).orderBy(desc(sql`count(*)`)) : Promise.resolve([]),
    view === 'overview' ? db.execute<{ label: string; count: number }>(sql`select case when feasibility_score >= 75 then '75–100' when feasibility_score >= 50 then '50–74' when feasibility_score >= 25 then '25–49' else '0–24' end as label, count(*)::int as count from hotel_bl_opportunities o join hotel_bl_hotels h on h.id = o.hotel_id where h.last_run_id = ${run.id} group by 1 order by 1 desc`) : Promise.resolve([]),
    view === 'overview' ? db.select({ label: hotelBlHotels.state, count: sql<number>`count(*)::int` }).from(hotelBlHotels).where(eq(hotelBlHotels.lastRunId, run.id)).groupBy(hotelBlHotels.state).orderBy(desc(sql`count(*)`)).limit(12) : Promise.resolve([]),
    view === 'overview' ? db.select({ label: sql<HotelBlContentType>`coalesce(${hotelBlOpportunities.manualRecommendedContentType}, ${hotelBlOpportunities.recommendedContentType})`, count: sql<number>`count(*)::int` }).from(hotelBlOpportunities).innerJoin(hotelBlHotels, eq(hotelBlOpportunities.hotelId, hotelBlHotels.id)).where(eq(hotelBlHotels.lastRunId, run.id)).groupBy(sql`coalesce(${hotelBlOpportunities.manualRecommendedContentType}, ${hotelBlOpportunities.recommendedContentType})`).orderBy(desc(sql`count(*)`)) : Promise.resolve([]),
    view === 'opportunities' ? db.selectDistinct({ value: hotelBlHotels.state }).from(hotelBlHotels).where(eq(hotelBlHotels.lastRunId, run.id)).orderBy(hotelBlHotels.state) : Promise.resolve([]),
    view === 'opportunities' ? db.selectDistinct({ value: hotelBlHotels.city }).from(hotelBlHotels).where(and(eq(hotelBlHotels.lastRunId, run.id), filters.state ? eq(hotelBlHotels.state, filters.state) : undefined)).orderBy(hotelBlHotels.city) : Promise.resolve([]),
  ])

  return {
    run,
    counts,
    opportunities,
    hotels,
    domains,
    contentOpportunities,
    runs,
    jobs,
    events,
    breakdowns: {
      roles,
      controls,
      feasibility: Array.from(feasibility as Iterable<{ label: string; count: number }>),
      states,
      treatments,
    },
    filterOptions: {
      states: filterStates.map((row) => row.value).filter((value): value is string => Boolean(value)),
      cities: filterCities.map((row) => row.value).filter((value): value is string => Boolean(value)),
    },
  }
}

export async function listHotelBlUrlValidations(db: Database) {
  const [run] = await db.select({ id: hotelBlRuns.id }).from(hotelBlRuns).orderBy(desc(hotelBlRuns.createdAt)).limit(1)
  if (!run) return []
  return db.select({
    hotel: hotelBlHotels.hotelName,
    city: hotelBlHotels.city,
    state: hotelBlHotels.state,
    country: hotelBlHotels.country,
    hotelHotTubsListing: hotelBlHotels.listingSourceUrl,
    currentListingPage: hotelBlHotels.listingFinalUrl,
    listingMatched: hotelBlHotels.listingMatched,
    listingAddress: hotelBlHotels.listingAddress,
    importedCandidateUrl: hotelBlHotels.sourceUrl,
    resolvedCandidateUrl: hotelBlHotels.candidateFinalUrl,
    entityScope: hotelBlHotels.sourceEntityScope,
    entityType: hotelBlHotels.sourceEntityType,
    validationStatus: hotelBlHotels.urlValidationStatus,
    validationConfidence: hotelBlHotels.urlValidationConfidence,
    validationReason: hotelBlHotels.urlValidationReason,
    canonicalHotelDomain: hotelBlHotels.canonicalPropertyDomain,
    needsReview: hotelBlHotels.needsReview,
    validatedAt: hotelBlHotels.urlValidatedAt,
  }).from(hotelBlHotels).where(eq(hotelBlHotels.lastRunId, run.id)).orderBy(hotelBlHotels.state, hotelBlHotels.city, hotelBlHotels.hotelName)
}

export async function getHotelBlHotelDetail(db: Database, hotelId: number) {
  const [hotel] = await db.select().from(hotelBlHotels).where(eq(hotelBlHotels.id, hotelId)).limit(1)
  if (!hotel) return null
  const relationships = await db
    .select({
      relationshipId: hotelBlRelationships.id,
      relationshipType: hotelBlRelationships.relationshipType,
      entityScope: hotelBlRelationships.entityScope,
      relationshipEntityType: hotelBlRelationships.entityType,
      relationshipEntityName: hotelBlRelationships.entityName,
      urlValidationStatus: hotelBlRelationships.urlValidationStatus,
      urlValidationConfidence: hotelBlRelationships.urlValidationConfidence,
      urlValidationReason: hotelBlRelationships.urlValidationReason,
      candidateFinalUrl: hotelBlRelationships.candidateFinalUrl,
      manualRelationshipType: hotelBlRelationships.manualRelationshipType,
      confidence: hotelBlRelationships.confidence,
      source: hotelBlRelationships.source,
      sourceUrl: hotelBlRelationships.sourceUrl,
      evidence: hotelBlRelationships.evidence,
      relationshipNeedsReview: hotelBlRelationships.needsReview,
      domainId: hotelBlDomains.id,
      domain: hotelBlDomains.domain,
      entityName: hotelBlDomains.entityName,
      entityType: hotelBlDomains.entityType,
      siteControlType: hotelBlDomains.siteControlType,
      manualSiteControlType: hotelBlDomains.manualSiteControlType,
      crawlStatus: hotelBlDomains.crawlStatus,
      opportunityId: hotelBlOpportunities.id,
      feasibilityScore: hotelBlOpportunities.feasibilityScore,
      feasibilityComponents: hotelBlOpportunities.feasibilityComponents,
      linkValueScore: hotelBlOpportunities.linkValueScore,
      linkValueComponents: hotelBlOpportunities.linkValueComponents,
      contentFitScore: hotelBlOpportunities.contentFitScore,
      contentFitComponents: hotelBlOpportunities.contentFitComponents,
      effortScore: hotelBlOpportunities.effortScore,
      priorityScore: hotelBlOpportunities.priorityScore,
      recommendedContentType: hotelBlOpportunities.recommendedContentType,
      manualRecommendedContentType: hotelBlOpportunities.manualRecommendedContentType,
      recommendedPitchAngle: hotelBlOpportunities.recommendedPitchAngle,
      reasoningSummary: hotelBlOpportunities.reasoningSummary,
      status: hotelBlOpportunities.status,
    })
    .from(hotelBlRelationships)
    .innerJoin(hotelBlDomains, eq(hotelBlRelationships.domainId, hotelBlDomains.id))
    .leftJoin(hotelBlOpportunities, eq(hotelBlOpportunities.relationshipId, hotelBlRelationships.id))
    .where(eq(hotelBlRelationships.hotelId, hotelId))
    .orderBy(desc(hotelBlOpportunities.priorityScore))
  const domainIds = relationships.map((row) => row.domainId)
  const [pages, contacts] = domainIds.length === 0
    ? [[], []]
    : await Promise.all([
        db.select().from(hotelBlDiscoveredPages).where(inArray(hotelBlDiscoveredPages.domainId, domainIds)).orderBy(desc(hotelBlDiscoveredPages.lastContentDate)),
        db.select().from(hotelBlContacts).where(inArray(hotelBlContacts.domainId, domainIds)).orderBy(desc(hotelBlContacts.confidence)),
      ])
  return { hotel, relationships, pages, contacts }
}

export async function getHotelBlDomainDetail(db: Database, domainId: number) {
  const [domain] = await db.select().from(hotelBlDomains).where(eq(hotelBlDomains.id, domainId)).limit(1)
  if (!domain) return null
  const [hotels, pages, contacts, opportunities] = await Promise.all([
    db.select({ hotelId: hotelBlHotels.id, hotelName: hotelBlHotels.hotelName, city: hotelBlHotels.city, state: hotelBlHotels.state, relationshipType: hotelBlRelationships.relationshipType, manualRelationshipType: hotelBlRelationships.manualRelationshipType, entityScope: hotelBlRelationships.entityScope, entityType: hotelBlRelationships.entityType, urlValidationStatus: hotelBlRelationships.urlValidationStatus, urlValidationReason: hotelBlRelationships.urlValidationReason, confidence: hotelBlRelationships.confidence }).from(hotelBlRelationships).innerJoin(hotelBlHotels, eq(hotelBlRelationships.hotelId, hotelBlHotels.id)).where(eq(hotelBlRelationships.domainId, domainId)).orderBy(hotelBlHotels.hotelName),
    db.select().from(hotelBlDiscoveredPages).where(eq(hotelBlDiscoveredPages.domainId, domainId)).orderBy(desc(hotelBlDiscoveredPages.lastContentDate)),
    db.select().from(hotelBlContacts).where(eq(hotelBlContacts.domainId, domainId)).orderBy(desc(hotelBlContacts.confidence)),
    db.select({ id: hotelBlOpportunities.id, hotelId: hotelBlHotels.id, hotelName: hotelBlHotels.hotelName, relationshipType: sql<HotelBlRelationshipType>`coalesce(${hotelBlRelationships.manualRelationshipType}, ${hotelBlOpportunities.relationshipType})`, feasibilityScore: hotelBlOpportunities.feasibilityScore, feasibilityComponents: hotelBlOpportunities.feasibilityComponents, linkValueScore: hotelBlOpportunities.linkValueScore, linkValueComponents: hotelBlOpportunities.linkValueComponents, contentFitScore: hotelBlOpportunities.contentFitScore, contentFitComponents: hotelBlOpportunities.contentFitComponents, effortScore: hotelBlOpportunities.effortScore, priorityScore: hotelBlOpportunities.priorityScore, status: hotelBlOpportunities.status }).from(hotelBlOpportunities).innerJoin(hotelBlHotels, eq(hotelBlOpportunities.hotelId, hotelBlHotels.id)).innerJoin(hotelBlRelationships, eq(hotelBlOpportunities.relationshipId, hotelBlRelationships.id)).where(eq(hotelBlOpportunities.domainId, domainId)).orderBy(desc(hotelBlOpportunities.priorityScore)),
  ])
  const pageIds = pages.map((page) => page.id)
  const links = pageIds.length === 0 ? [] : await db.select().from(hotelBlEditorialLinks).where(inArray(hotelBlEditorialLinks.pageId, pageIds)).orderBy(desc(hotelBlEditorialLinks.followed))
  return { domain, hotels, pages, contacts, opportunities, links }
}
