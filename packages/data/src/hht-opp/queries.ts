import 'server-only'
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import {
  formatPrice,
  HHT_OPP_ELIGIBILITY,
  HHT_OPP_SEO_RISKS,
  HHT_OPP_STATUSES,
  HHT_OPP_STRATEGIES,
  HHT_OPP_TYPES,
  type HhtOppEligibility,
  type HhtOppSeoRisk,
  type HhtOppStatus,
  type HhtOppStrategy,
  type HhtOppType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtOppContacts,
  hhtOppCrawledPages,
  hhtOppDiscoveryRuns,
  hhtOppDomains,
  hhtOppDrafts,
  hhtOppOpportunities,
  hhtOppPricingOptions,
  hhtOppRequirements,
  hhtOppOutreachEvents,
  hhtOppSearchQueries,
  hhtOppSeoMetrics,
  hhtOppSources,
} from '../schema.js'
import { latestSeoMetrics } from './store.js'

export type HhtOppDashboardView = 'opportunities' | 'strategies' | 'queries' | 'outcomes' | 'learning'

export interface HhtOppFilters {
  type?: HhtOppType
  paid?: 'free' | 'paid' | 'all'
  maxPrice?: number
  minAuthority?: number
  minTraffic?: number
  minReferringDomains?: number
  contextual?: boolean
  dofollow?: boolean
  eligibility?: HhtOppEligibility
  minScore?: number
  seoRisk?: HhtOppSeoRisk
  strategy?: HhtOppStrategy
  contacted?: 'yes' | 'no'
  status?: HhtOppStatus
  sort?:
    | 'score'
    | 'authority'
    | 'traffic'
    | 'referring'
    | 'outbound'
    | 'price'
    | 'checked'
  direction?: 'asc' | 'desc'
}

export interface HhtOppListRow {
  id: number
  domainId: number
  site: string
  displayName: string | null
  opportunityType: HhtOppType
  inventedTypeName: string | null
  status: HhtOppStatus
  overallScore: number | null
  authorityScore: number | null
  organicTraffic: number | null
  referringDomains: number | null
  avgOutboundLinks: number | null
  linkType: string
  priceLabel: string
  priceAmount: number | null
  priceStatus: string
  eligibility: HhtOppEligibility
  requirementsSummary: string[]
  contact: string | null
  lastCheckedAt: Date | null
  hasDraft: boolean
  seoRisk: HhtOppSeoRisk
  strategy: HhtOppStrategy
  contacted: boolean
  opportunityUrl: string
}

function latestMetric(metric: string) {
  return sql<number | null>`(
    select m.value
      from ${hhtOppSeoMetrics} m
     where m.domain_id = ${hhtOppDomains.id}
       and m.metric = ${metric}
     order by m.retrieved_at desc
     limit 1
  )`
}

function primaryContactSql() {
  return sql<string | null>`(
    select coalesce(c.email, c.form_url)
      from ${hhtOppContacts} c
     where c.opportunity_id = ${hhtOppOpportunities.id}
     order by
       case c.status when 'VERIFIED_PUBLIC' then 0 when 'INFERRED' then 1 else 2 end,
       (c.email is not null) desc,
       c.id
     limit 1
  )`
}

function conditions(filters: HhtOppFilters): SQL[] {
  const out: SQL[] = []
  if (filters.type) out.push(eq(hhtOppOpportunities.opportunityType, filters.type))
  if (filters.eligibility) out.push(eq(hhtOppOpportunities.eligibility, filters.eligibility))
  if (filters.status) out.push(eq(hhtOppOpportunities.status, filters.status))
  if (filters.seoRisk) out.push(eq(hhtOppOpportunities.seoRisk, filters.seoRisk))
  if (filters.strategy) out.push(eq(hhtOppOpportunities.discoveredByStrategy, filters.strategy))
  if (filters.minScore != null) out.push(gte(hhtOppOpportunities.overallScore, filters.minScore))
  if (filters.maxPrice != null) {
    out.push(sql`(${hhtOppOpportunities.priceAmount} is not null and ${hhtOppOpportunities.priceAmount} <= ${filters.maxPrice})`)
  }
  if (filters.paid === 'paid') {
    out.push(sql`${hhtOppOpportunities.priceStatus} in ('FIXED', 'QUOTE_REQUIRED')`)
  }
  if (filters.paid === 'free') {
    out.push(sql`${hhtOppOpportunities.priceStatus} in ('FREE', 'PUBLISHER_PAYS', 'UNKNOWN')`)
  }
  if (filters.contextual) out.push(sql`${hhtOppOpportunities.linkType} like 'contextual_%'`)
  if (filters.dofollow) out.push(sql`${hhtOppOpportunities.linkType} like '%dofollow%'`)
  if (filters.contacted === 'yes') out.push(eq(hhtOppOpportunities.contacted, true))
  if (filters.contacted === 'no') out.push(eq(hhtOppOpportunities.contacted, false))
  if (filters.minAuthority != null) out.push(sql`${latestMetric('authority_score')} >= ${filters.minAuthority}`)
  if (filters.minTraffic != null) out.push(sql`${latestMetric('organic_traffic')} >= ${filters.minTraffic}`)
  if (filters.minReferringDomains != null) {
    out.push(sql`${latestMetric('referring_domains')} >= ${filters.minReferringDomains}`)
  }
  return out
}

export async function listHhtOppOpportunities(db: Database, filters: HhtOppFilters = {}): Promise<HhtOppListRow[]> {
  const where = conditions(filters)
  const sort = filters.sort ?? 'score'
  const direction = filters.direction === 'asc' ? asc : desc
  const sortExpr = {
    score: hhtOppOpportunities.overallScore,
    authority: latestMetric('authority_score'),
    traffic: latestMetric('organic_traffic'),
    referring: latestMetric('referring_domains'),
    outbound: hhtOppDomains.avgExternalLinks,
    price: hhtOppOpportunities.priceAmount,
    checked: hhtOppOpportunities.lastCheckedAt,
  }[sort]

  const rows = await db
    .select({
      id: hhtOppOpportunities.id,
      domainId: hhtOppOpportunities.domainId,
      site: hhtOppDomains.rootDomain,
      displayName: hhtOppDomains.displayName,
      opportunityType: hhtOppOpportunities.opportunityType,
      inventedType: hhtOppOpportunities.inventedType,
      status: hhtOppOpportunities.status,
      overallScore: hhtOppOpportunities.overallScore,
      avgOutboundLinks: hhtOppDomains.avgExternalLinks,
      linkType: hhtOppOpportunities.linkType,
      priceAmount: hhtOppOpportunities.priceAmount,
      priceCurrency: hhtOppOpportunities.priceCurrency,
      priceStatus: hhtOppOpportunities.priceStatus,
      pricingModel: hhtOppOpportunities.pricingModel,
      eligibility: hhtOppOpportunities.eligibility,
      requirementsSummary: hhtOppOpportunities.requirementsSummary,
      lastCheckedAt: hhtOppOpportunities.lastCheckedAt,
      seoRisk: hhtOppOpportunities.seoRisk,
      strategy: hhtOppOpportunities.discoveredByStrategy,
      contacted: hhtOppOpportunities.contacted,
      opportunityUrl: hhtOppOpportunities.opportunityUrl,
      authorityScore: latestMetric('authority_score'),
      organicTraffic: latestMetric('organic_traffic'),
      referringDomains: latestMetric('referring_domains'),
      contact: primaryContactSql(),
      draftCount: sql<number>`(select count(*)::int from ${hhtOppDrafts} d where d.opportunity_id = ${hhtOppOpportunities.id})`,
    })
    .from(hhtOppOpportunities)
    .innerJoin(hhtOppDomains, eq(hhtOppDomains.id, hhtOppOpportunities.domainId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(direction(sortExpr), desc(hhtOppOpportunities.id))
    .limit(400)

  return rows.map((row) => ({
    id: row.id,
    domainId: row.domainId,
    site: row.site,
    displayName: row.displayName,
    opportunityType: row.opportunityType,
    inventedTypeName: row.inventedType && typeof row.inventedType['name'] === 'string' ? row.inventedType['name'] : null,
    status: row.status,
    overallScore: row.overallScore,
    authorityScore: row.authorityScore,
    organicTraffic: row.organicTraffic,
    referringDomains: row.referringDomains,
    avgOutboundLinks: row.avgOutboundLinks,
    linkType: row.linkType,
    priceLabel: formatPrice({
      amount: row.priceAmount,
      currency: row.priceCurrency,
      status: row.priceStatus,
      pricingModel: row.pricingModel,
      included: null,
      evidence: null,
    }),
    priceAmount: row.priceAmount,
    priceStatus: row.priceStatus,
    eligibility: row.eligibility,
    requirementsSummary: row.requirementsSummary,
    contact: row.contact,
    lastCheckedAt: row.lastCheckedAt,
    hasDraft: row.draftCount > 0,
    seoRisk: row.seoRisk,
    strategy: row.strategy,
    contacted: row.contacted,
    opportunityUrl: row.opportunityUrl,
  }))
}

export async function hhtOppStats(db: Database) {
  const [domains] = await db.select({ n: sql<number>`count(*)::int` }).from(hhtOppDomains)
  const [opps] = await db
    .select({
      opportunities: sql<number>`count(*)::int`,
      pass: sql<number>`count(*) filter (where ${hhtOppOpportunities.eligibility} = 'PASS')::int`,
      review: sql<number>`count(*) filter (where ${hhtOppOpportunities.eligibility} = 'REVIEW')::int`,
      fail: sql<number>`count(*) filter (where ${hhtOppOpportunities.eligibility} = 'FAIL')::int`,
    })
    .from(hhtOppOpportunities)
  const [drafts] = await db.select({ n: sql<number>`count(*)::int` }).from(hhtOppDrafts)
  return {
    domains: domains?.n ?? 0,
    opportunities: opps?.opportunities ?? 0,
    pass: opps?.pass ?? 0,
    review: opps?.review ?? 0,
    fail: opps?.fail ?? 0,
    drafts: drafts?.n ?? 0,
  }
}

export async function strategyYield(db: Database) {
  const fromQueries = await db
    .select({
      strategy: hhtOppSearchQueries.strategy,
      queries: sql<number>`count(*)::int`,
      domainsFound: sql<number>`coalesce(sum(${hhtOppSearchQueries.resultsFound}), 0)::int`,
      newDomains: sql<number>`coalesce(sum(${hhtOppSearchQueries.newDomains}), 0)::int`,
      qualified: sql<number>`coalesce(sum(${hhtOppSearchQueries.qualifiedDomains}), 0)::int`,
      pass: sql<number>`coalesce(sum(${hhtOppSearchQueries.passDomains}), 0)::int`,
    })
    .from(hhtOppSearchQueries)
    .groupBy(hhtOppSearchQueries.strategy)

  const fromOpps = await db
    .select({
      strategy: hhtOppOpportunities.discoveredByStrategy,
      domainsFound: sql<number>`count(distinct ${hhtOppOpportunities.domainId})::int`,
      qualified: sql<number>`count(*)::int`,
      pass: sql<number>`count(*) filter (where ${hhtOppOpportunities.eligibility} = 'PASS')::int`,
    })
    .from(hhtOppOpportunities)
    .groupBy(hhtOppOpportunities.discoveredByStrategy)

  const merged = new Map<
    string,
    { strategy: string; queries: number; domainsFound: number; newDomains: number; qualified: number; pass: number }
  >()
  for (const row of fromQueries) {
    merged.set(row.strategy, { ...row, strategy: row.strategy })
  }
  for (const row of fromOpps) {
    const prev = merged.get(row.strategy) ?? {
      strategy: row.strategy,
      queries: 0,
      domainsFound: 0,
      newDomains: 0,
      qualified: 0,
      pass: 0,
    }
    merged.set(row.strategy, {
      ...prev,
      domainsFound: Math.max(prev.domainsFound, row.domainsFound),
      qualified: Math.max(prev.qualified, row.qualified),
      pass: Math.max(prev.pass, row.pass),
    })
  }

  return [...merged.values()].map((row) => ({
    ...row,
    yieldPct: row.domainsFound > 0 ? (row.pass / row.domainsFound) * 100 : row.qualified > 0 ? (row.pass / row.qualified) * 100 : 0,
  }))
}

export async function getHhtOppDetail(db: Database, id: number) {
  const [opportunity] = await db
    .select()
    .from(hhtOppOpportunities)
    .where(eq(hhtOppOpportunities.id, id))
    .limit(1)
  if (!opportunity) return null

  const [domain] = await db.select().from(hhtOppDomains).where(eq(hhtOppDomains.id, opportunity.domainId)).limit(1)
  if (!domain) return null

  const [requirements, sources, pricing, contacts, drafts, pages, outreach] = await Promise.all([
    db.select().from(hhtOppRequirements).where(eq(hhtOppRequirements.opportunityId, id)),
    db.select().from(hhtOppSources).where(eq(hhtOppSources.opportunityId, id)),
    db.select().from(hhtOppPricingOptions).where(eq(hhtOppPricingOptions.opportunityId, id)),
    db.select().from(hhtOppContacts).where(eq(hhtOppContacts.opportunityId, id)),
    db.select().from(hhtOppDrafts).where(eq(hhtOppDrafts.opportunityId, id)).orderBy(desc(hhtOppDrafts.createdAt)),
    db.select().from(hhtOppCrawledPages).where(eq(hhtOppCrawledPages.domainId, domain.id)),
    db.select().from(hhtOppOutreachEvents).where(eq(hhtOppOutreachEvents.opportunityId, id)),
  ])

  const metrics = await latestSeoMetrics(db, domain.id)
  return { opportunity, domain, requirements, sources, pricing, contacts, drafts, pages, outreach, metrics }
}

export async function updateHhtOppStatus(db: Database, id: number, status: HhtOppStatus): Promise<void> {
  if (!HHT_OPP_STATUSES.includes(status)) throw new Error('Invalid status')
  const contacted = ['CONTACTED', 'REPLIED', 'NEGOTIATING', 'PLACED', 'QUOTED', 'APPROVED', 'PURCHASED'].includes(status)
  await db
    .update(hhtOppOpportunities)
    .set({
      status,
      ...(contacted ? { contacted: true } : {}),
      updatedAt: new Date(),
    })
    .where(eq(hhtOppOpportunities.id, id))
}

export async function listDiscoveryQueries(db: Database) {
  return db.select().from(hhtOppSearchQueries).orderBy(desc(hhtOppSearchQueries.id)).limit(200)
}

export async function listDiscoveryRuns(db: Database) {
  return db.select().from(hhtOppDiscoveryRuns).orderBy(desc(hhtOppDiscoveryRuns.id)).limit(20)
}

export const FILTER_ENUMS = {
  types: HHT_OPP_TYPES,
  eligibility: HHT_OPP_ELIGIBILITY,
  risks: HHT_OPP_SEO_RISKS,
  strategies: HHT_OPP_STRATEGIES,
  statuses: HHT_OPP_STATUSES,
}
