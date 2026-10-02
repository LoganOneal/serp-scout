import 'server-only'
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import {
  HHT_PX_CLUSTERS,
  HHT_PX_GEO_TYPES,
  isHhtPxCluster,
  isHhtPxGeoType,
  isHhtPxOutreachStatus,
  monthlyTrendSlope,
  recentMonthlyVolume,
  type HhtPxCluster,
  type HhtPxGeoType,
  type HhtPxOutreachStatus,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtPxClusterYields,
  hhtPxGeographies,
  hhtPxKeywordVolumes,
  hhtPxKeywords,
  hhtPxPageKeywordMatches,
  hhtPxPipelineJobs,
  hhtPxProspectDomains,
  hhtPxProspectPages,
  hhtPxSerpResults,
  hhtPxSerpSnapshots,
} from '../schema.js'
import { getLatestHhtPxRun, previewHhtPxSerpCalls } from './pipeline.js'

export type HhtPxDashboardView = 'pipeline' | 'keywords' | 'pages' | 'domains'

export interface HhtPxKeywordFilters {
  state?: string
  city?: string
  geoType?: HhtPxGeoType
  cluster?: HhtPxCluster
  minVolume?: number
  maxVolume?: number
  minInventory?: number
  minEditorialDensity?: number
  minProspectable?: number
  minScore?: number
  serpChecked?: boolean
  source?: 'template' | 'google_keyword_ideas'
  sort?: string
  direction?: 'asc' | 'desc'
}

export interface HhtPxPageFilters {
  minScore?: number
  competitor?: string
  outreach?: HhtPxOutreachStatus
  prospectableOnly?: boolean
  lane?: 'primary' | 'paid_outreach' | 'needs_review' | 'earned_partnership' | 'excluded' | 'all'
  sort?: string
  direction?: 'asc' | 'desc'
}

export interface HhtPxDomainFilters {
  minAuthority?: number
  minPages?: number
  outreach?: HhtPxOutreachStatus
  prospectableOnly?: boolean
  sort?: string
  direction?: 'asc' | 'desc'
}

const KEYWORD_SORT = {
  keyword: hhtPxKeywords.keyword,
  geo: hhtPxGeographies.name,
  state: hhtPxGeographies.state,
  cluster: hhtPxKeywords.cluster,
  variant: hhtPxKeywords.variantGroup,
  volume: hhtPxKeywordVolumes.nationalDestinationVolume,
  competition: hhtPxKeywordVolumes.competition,
  score: hhtPxSerpSnapshots.keywordOpportunityScore,
  editorial: hhtPxSerpSnapshots.editorialDensity,
  prospectable: hhtPxSerpSnapshots.prospectableDensity,
  competitors: hhtPxSerpSnapshots.competitorCount,
  domains: hhtPxSerpSnapshots.uniqueProspectDomains,
  serp: hhtPxKeywords.serpStatus,
}

const matchVolume = sql`coalesce(${hhtPxPageKeywordMatches.volume}, ${hhtPxKeywordVolumes.nationalDestinationVolume})`

const PAGE_SORT = {
  score: hhtPxProspectPages.opportunityScore,
  authority: hhtPxProspectDomains.authorityScore,
  domain: hhtPxProspectDomains.rootDomain,
  position: hhtPxPageKeywordMatches.position,
  volume: matchVolume,
  keyword: hhtPxKeywords.keyword,
  added: hhtPxProspectPages.createdAt,
  editorial: hhtPxProspectPages.editorialScore,
  feasibility: hhtPxProspectPages.feasibilityScore,
}

const DOMAIN_SORT = {
  score: hhtPxProspectDomains.opportunityScore,
  domain: hhtPxProspectDomains.rootDomain,
  authority: hhtPxProspectDomains.authorityScore,
  traffic: hhtPxProspectDomains.organicTraffic,
  pages: hhtPxProspectDomains.pageCount,
}

function sortCol<T extends Record<string, unknown>>(map: T, key: string | undefined, fallback: keyof T): T[keyof T] {
  if (key && Object.prototype.hasOwnProperty.call(map, key)) return map[key as keyof T]
  return map[fallback]
}

function order(column: Parameters<typeof desc>[0], direction: 'asc' | 'desc' | undefined) {
  return direction === 'asc' ? asc(column) : desc(column)
}

export function parseHhtPxKeywordFilters(params: Record<string, string | undefined>): HhtPxKeywordFilters {
  const geoType = params['geoType']
  const cluster = params['cluster']
  return {
    state: params['state'] || undefined,
    city: params['city'] || undefined,
    geoType: geoType && isHhtPxGeoType(geoType) ? geoType : undefined,
    cluster: cluster && isHhtPxCluster(cluster) ? cluster : undefined,
    minVolume: num(params['minVolume']),
    maxVolume: num(params['maxVolume']),
    minInventory: num(params['minInventory']),
    minEditorialDensity: num(params['minEditorialDensity']),
    minProspectable: num(params['minProspectable']),
    minScore: num(params['minScore']),
    serpChecked: params['serp'] === 'checked' ? true : params['serp'] === 'unchecked' ? false : undefined,
    source: params['source'] === 'google_keyword_ideas' ? 'google_keyword_ideas' : undefined,
    sort: params['sort'] && params['sort'] in KEYWORD_SORT ? params['sort'] : 'score',
    direction: params['direction'] === 'asc' ? 'asc' : 'desc',
  }
}

export function parseHhtPxPageFilters(params: Record<string, string | undefined>): HhtPxPageFilters {
  const outreach = params['outreach']
  return {
    minScore: num(params['minScore']),
    competitor: params['competitor'] || undefined,
    outreach: outreach && isHhtPxOutreachStatus(outreach) ? outreach : undefined,
    prospectableOnly: params['prospectable'] !== '0',
    lane: pageLane(params['lane']),
    sort: params['sort'] && params['sort'] in PAGE_SORT ? params['sort'] : 'score',
    direction: params['direction'] === 'asc' ? 'asc' : 'desc',
  }
}

export function parseHhtPxDomainFilters(params: Record<string, string | undefined>): HhtPxDomainFilters {
  const outreach = params['outreach']
  return {
    minAuthority: num(params['minAuthority']),
    minPages: num(params['minPages']),
    outreach: outreach && isHhtPxOutreachStatus(outreach) ? outreach : undefined,
    prospectableOnly: params['prospectable'] !== '0',
    sort: params['sort'] && params['sort'] in DOMAIN_SORT ? params['sort'] : 'score',
    direction: params['direction'] === 'asc' ? 'asc' : 'desc',
  }
}

function pageLane(value: string | undefined): HhtPxPageFilters['lane'] {
  if (value === 'all' || value === 'paid_outreach' || value === 'needs_review' || value === 'earned_partnership' || value === 'excluded' || value === 'primary') {
    return value
  }
  return 'primary'
}

function num(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function getHhtPxDashboard(
  database: Database,
  view: HhtPxDashboardView,
  params: Record<string, string | undefined> = {},
) {
  const run = await getLatestHhtPxRun(database)
  const jobs = run
    ? await database
        .select()
        .from(hhtPxPipelineJobs)
        .where(eq(hhtPxPipelineJobs.runId, run.id))
        .orderBy(desc(hhtPxPipelineJobs.updatedAt))
        .limit(40)
    : []
  const yields = await database.select().from(hhtPxClusterYields).orderBy(desc(hhtPxClusterYields.avgProspectsPerSerp))
  const [geoCount] = await database.select({ n: sql<number>`count(*)::int` }).from(hhtPxGeographies)
  const [keywordCount] = await database.select({ n: sql<number>`count(*)::int` }).from(hhtPxKeywords)
  const [volumeCount] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(hhtPxKeywordVolumes)
    .where(sql`${hhtPxKeywordVolumes.retrievedAt} is not null`)
  const [serpCount] = await database.select({ n: sql<number>`count(*)::int` }).from(hhtPxSerpSnapshots)
  const [pageCount] = await database.select({ n: sql<number>`count(*)::int` }).from(hhtPxProspectPages)
  const [domainCount] = await database.select({ n: sql<number>`count(*)::int` }).from(hhtPxProspectDomains)
  const counts = {
    geographies: geoCount?.n ?? 0,
    keywords: keywordCount?.n ?? 0,
    volumes: volumeCount?.n ?? 0,
    serps: serpCount?.n ?? 0,
    pages: pageCount?.n ?? 0,
    domains: domainCount?.n ?? 0,
  }
  const serpPreview = view === 'pipeline' ? await previewHhtPxSerpCalls(database, { limit: Number(params['limit'] ?? 25) }) : null

  if (view === 'keywords') {
    const filters = parseHhtPxKeywordFilters(params)
    const keywords = await listHhtPxKeywords(database, filters)
    return { view, run, jobs, yields, counts, serpPreview, filters, keywords, pages: [], domains: [] }
  }
  if (view === 'pages') {
    const filters = parseHhtPxPageFilters(params)
    const pages = await listHhtPxPages(database, filters)
    return { view, run, jobs, yields, counts, serpPreview, pageFilters: filters, keywords: [], pages, domains: [] }
  }
  if (view === 'domains') {
    const filters = parseHhtPxDomainFilters(params)
    const domains = await listHhtPxDomains(database, filters)
    return { view, run, jobs, yields, counts, serpPreview, domainFilters: filters, keywords: [], pages: [], domains }
  }
  const pages = await listHhtPxPages(database, { prospectableOnly: true, sort: 'volume', direction: 'desc' }, 25)
  return { view, run, jobs, yields, counts, serpPreview, keywords: [], pages, domains: [] }
}

export async function listHhtPxKeywords(database: Database, filters: HhtPxKeywordFilters, limit = 200) {
  const where: SQL[] = []
  if (filters.state) where.push(eq(hhtPxGeographies.stateCode, filters.state.toUpperCase()))
  if (filters.city) where.push(sql`${hhtPxGeographies.name} ilike ${`%${filters.city}%`}`)
  if (filters.geoType) where.push(eq(hhtPxGeographies.type, filters.geoType))
  if (filters.cluster) where.push(eq(hhtPxKeywords.cluster, filters.cluster))
  if (filters.minVolume != null) where.push(gte(hhtPxKeywordVolumes.nationalDestinationVolume, filters.minVolume))
  if (filters.maxVolume != null) where.push(lte(hhtPxKeywordVolumes.nationalDestinationVolume, filters.maxVolume))
  if (filters.minInventory != null) {
    where.push(
      sql`coalesce(${hhtPxGeographies.hotelCount},0) + coalesce(${hhtPxGeographies.privateHotTubCount},0) + coalesce(${hhtPxGeographies.sharedHotTubCount},0) + coalesce(${hhtPxGeographies.editorsChoiceCount},0) >= ${filters.minInventory}`,
    )
  }
  if (filters.minEditorialDensity != null) {
    where.push(gte(hhtPxSerpSnapshots.editorialDensity, filters.minEditorialDensity / 100))
  }
  if (filters.minProspectable != null) {
    where.push(gte(hhtPxSerpSnapshots.uniqueProspectDomains, filters.minProspectable))
  }
  if (filters.minScore != null) where.push(gte(hhtPxSerpSnapshots.keywordOpportunityScore, filters.minScore))
  if (filters.serpChecked === true) where.push(eq(hhtPxKeywords.serpStatus, 'cached'))
  if (filters.serpChecked === false) where.push(sql`${hhtPxKeywords.serpStatus} in ('unchecked', 'queued', 'skipped')`)
  if (filters.source) where.push(eq(hhtPxKeywords.source, filters.source))

  const sort = sortCol(KEYWORD_SORT, filters.sort, 'score')
  const rows = await database
    .select({
      id: hhtPxKeywords.id,
      keyword: hhtPxKeywords.keyword,
      cluster: hhtPxKeywords.cluster,
      variantGroup: hhtPxKeywords.variantGroup,
      geoName: hhtPxGeographies.name,
      geoType: hhtPxGeographies.type,
      state: hhtPxGeographies.state,
      stateCode: hhtPxGeographies.stateCode,
      volume: hhtPxKeywordVolumes.nationalDestinationVolume,
      monthly: hhtPxKeywordVolumes.monthlySearches,
      competition: hhtPxKeywordVolumes.competition,
      competitionIndex: hhtPxKeywordVolumes.competitionIndex,
      hotelCount: hhtPxGeographies.hotelCount,
      privateCount: hhtPxGeographies.privateHotTubCount,
      sharedCount: hhtPxGeographies.sharedHotTubCount,
      editorsCount: hhtPxGeographies.editorsChoiceCount,
      editorialDensity: hhtPxSerpSnapshots.editorialDensity,
      prospectableDensity: hhtPxSerpSnapshots.prospectableDensity,
      competitorCount: hhtPxSerpSnapshots.competitorCount,
      uniqueProspectDomains: hhtPxSerpSnapshots.uniqueProspectDomains,
      score: hhtPxSerpSnapshots.keywordOpportunityScore,
      serpStatus: hhtPxKeywords.serpStatus,
      representative: hhtPxKeywords.isRepresentative,
      source: hhtPxKeywords.source,
    })
    .from(hhtPxKeywords)
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.keywordId, hhtPxKeywords.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(order(sort, filters.direction))
    .limit(limit)

  return rows.map((row) => ({
    ...row,
    recentVolume: recentMonthlyVolume(row.monthly ?? []),
    trend: monthlyTrendSlope(row.monthly ?? []),
    inventory:
      (row.hotelCount ?? 0) + (row.privateCount ?? 0) + (row.sharedCount ?? 0) + (row.editorsCount ?? 0) || null,
  }))
}

export async function listHhtPxPages(database: Database, filters: HhtPxPageFilters, limit = 200) {
  const where: SQL[] = []
  if (filters.minScore != null) where.push(gte(hhtPxProspectPages.opportunityScore, filters.minScore))
  if (filters.competitor) where.push(eq(hhtPxProspectPages.competitorStrength, filters.competitor as 'none'))
  if (filters.outreach) where.push(eq(hhtPxProspectPages.outreachStatus, filters.outreach))
  if (filters.prospectableOnly) where.push(eq(hhtPxProspectPages.isProspectable, true))
  if (filters.lane === 'paid_outreach' || filters.lane === 'needs_review' || filters.lane === 'earned_partnership' || filters.lane === 'excluded') {
    where.push(eq(hhtPxProspectPages.publisherLane, filters.lane))
  } else if (filters.lane !== 'all') {
    where.push(sql`${hhtPxProspectPages.publisherLane} is null or ${hhtPxProspectPages.publisherLane} in ('paid_outreach', 'needs_review')`)
  }
  const sort = sortCol(PAGE_SORT, filters.sort, 'score')
  const rows = await database
    .select({
      id: hhtPxProspectPages.id,
      keywordId: hhtPxKeywords.id,
      score: hhtPxProspectPages.opportunityScore,
      domain: hhtPxProspectDomains.rootDomain,
      domainId: hhtPxProspectPages.domainId,
      title: hhtPxProspectPages.title,
      url: hhtPxProspectPages.url,
      pageType: hhtPxProspectPages.pageType,
      keyword: hhtPxKeywords.keyword,
      cluster: hhtPxKeywords.cluster,
      geoName: hhtPxGeographies.name,
      returnedKeyword: hhtPxKeywordVolumes.returnedKeyword,
      position: hhtPxPageKeywordMatches.position,
      volume: sql<number | null>`coalesce(${hhtPxPageKeywordMatches.volume}, ${hhtPxKeywordVolumes.nationalDestinationVolume})`,
      matchedKeywordCount: hhtPxProspectPages.matchedKeywordCount,
      bestPosition: hhtPxProspectPages.bestPosition,
      maxKeywordVolume: hhtPxProspectPages.maxKeywordVolume,
      authorityScore: hhtPxProspectDomains.authorityScore,
      linkFit: hhtPxProspectPages.linkFit,
      competitor: hhtPxProspectPages.competitorStrength,
      suggestedHhtUrl: hhtPxProspectPages.suggestedHhtUrl,
      outreachStatus: hhtPxProspectPages.outreachStatus,
      whyLink: hhtPxProspectPages.whyLink,
      isProspectable: hhtPxProspectPages.isProspectable,
      addedAt: hhtPxProspectPages.createdAt,
      lane: hhtPxProspectPages.publisherLane,
      qualification: hhtPxProspectPages.qualification,
      qualificationReason: hhtPxProspectPages.qualificationReason,
      editorialScore: hhtPxProspectPages.editorialScore,
      feasibilityScore: hhtPxProspectPages.feasibilityScore,
      insertionLocation: hhtPxProspectPages.insertionLocation,
      readerBenefit: hhtPxProspectPages.readerBenefit,
      evidenceConfidence: hhtPxProspectPages.evidenceConfidence,
      scoreDetail: hhtPxProspectPages.scoreDetail,
      contactUrl: hhtPxProspectDomains.contactUrl,
      publisherReason: hhtPxProspectDomains.publisherReason,
    })
    .from(hhtPxPageKeywordMatches)
    .innerJoin(hhtPxProspectPages, eq(hhtPxProspectPages.id, hhtPxPageKeywordMatches.pageId))
    .innerJoin(hhtPxProspectDomains, eq(hhtPxProspectDomains.id, hhtPxProspectPages.domainId))
    .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxPageKeywordMatches.keywordId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(
      filters.direction === 'asc' ? sql`${sort} asc nulls last` : sql`${sort} desc nulls last`,
      asc(hhtPxPageKeywordMatches.position),
      sql`${hhtPxProspectPages.opportunityScore} desc nulls last`,
    )
    .limit(limit)
  return rows.map((row) => ({
    ...row,
    geographies: row.geoName,
  }))
}

export async function listHhtPxDomains(database: Database, filters: HhtPxDomainFilters, limit = 200) {
  const where: SQL[] = []
  if (filters.minAuthority != null) where.push(gte(hhtPxProspectDomains.authorityScore, filters.minAuthority))
  if (filters.minPages != null) where.push(gte(hhtPxProspectDomains.pageCount, filters.minPages))
  if (filters.outreach) where.push(eq(hhtPxProspectDomains.outreachStatus, filters.outreach))
  if (filters.prospectableOnly) where.push(eq(hhtPxProspectDomains.isProspectable, true))
  const sort = sortCol(DOMAIN_SORT, filters.sort, 'score')
  const rows = await database
    .select()
    .from(hhtPxProspectDomains)
    .where(where.length ? and(...where) : undefined)
    .orderBy(order(sort, filters.direction))
    .limit(limit)
  const strongestIds = rows.map((row) => row.strongestPageId).filter((id): id is number => id != null)
  const pages = strongestIds.length
    ? await database
        .select({ id: hhtPxProspectPages.id, title: hhtPxProspectPages.title, url: hhtPxProspectPages.url })
        .from(hhtPxProspectPages)
    .where(inArray(hhtPxProspectPages.id, strongestIds))
    : []
  const pageById = new Map(pages.map((row) => [row.id, row]))
  return rows.map((row) => ({
    ...row,
    strongest: row.strongestPageId ? pageById.get(row.strongestPageId) ?? null : null,
  }))
}

export async function getHhtPxKeywordDetail(database: Database, keywordId: number) {
  const rows = await database
    .select({
      id: hhtPxKeywords.id,
      keyword: hhtPxKeywords.keyword,
      cluster: hhtPxKeywords.cluster,
      variantGroup: hhtPxKeywords.variantGroup,
      geoName: hhtPxGeographies.name,
      state: hhtPxGeographies.state,
      volume: hhtPxKeywordVolumes.nationalDestinationVolume,
      returnedKeyword: hhtPxKeywordVolumes.returnedKeyword,
      closeVariants: hhtPxKeywordVolumes.closeVariants,
      monthly: hhtPxKeywordVolumes.monthlySearches,
      score: hhtPxSerpSnapshots.keywordOpportunityScore,
      editorialDensity: hhtPxSerpSnapshots.editorialDensity,
      prospectableDensity: hhtPxSerpSnapshots.prospectableDensity,
      snapshotId: hhtPxSerpSnapshots.id,
      serpStatus: hhtPxKeywords.serpStatus,
    })
    .from(hhtPxKeywords)
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxSerpSnapshots, eq(hhtPxSerpSnapshots.keywordId, hhtPxKeywords.id))
    .where(eq(hhtPxKeywords.id, keywordId))
    .limit(1)
  const detail = rows[0]
  if (!detail) return null
  const results = detail.snapshotId
    ? await database
        .select()
        .from(hhtPxSerpResults)
        .where(eq(hhtPxSerpResults.snapshotId, detail.snapshotId))
        .orderBy(asc(hhtPxSerpResults.position))
    : []
  return { ...detail, results }
}

export async function getHhtPxPageDetail(database: Database, pageId: number) {
  const [page] = await database
    .select({
      page: hhtPxProspectPages,
      domain: hhtPxProspectDomains,
    })
    .from(hhtPxProspectPages)
    .innerJoin(hhtPxProspectDomains, eq(hhtPxProspectDomains.id, hhtPxProspectPages.domainId))
    .where(eq(hhtPxProspectPages.id, pageId))
    .limit(1)
  if (!page) return null
  const matches = await database
    .select({
      keywordId: hhtPxKeywords.id,
      keyword: hhtPxKeywords.keyword,
      cluster: hhtPxKeywords.cluster,
      geoName: hhtPxGeographies.name,
      position: hhtPxPageKeywordMatches.position,
      volume: sql<number | null>`coalesce(${hhtPxPageKeywordMatches.volume}, ${hhtPxKeywordVolumes.nationalDestinationVolume})`,
      returnedKeyword: hhtPxKeywordVolumes.returnedKeyword,
    })
    .from(hhtPxPageKeywordMatches)
    .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxPageKeywordMatches.keywordId))
    .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
    .leftJoin(hhtPxGeographies, eq(hhtPxGeographies.id, hhtPxKeywords.geographyId))
    .where(eq(hhtPxPageKeywordMatches.pageId, pageId))
    .orderBy(sql`coalesce(${hhtPxPageKeywordMatches.volume}, ${hhtPxKeywordVolumes.nationalDestinationVolume}) desc nulls last`, asc(hhtPxPageKeywordMatches.position))
  return { ...page.page, domain: page.domain, matches }
}

export const HHT_PX_FILTER_ENUMS = {
  clusters: HHT_PX_CLUSTERS,
  geoTypes: HHT_PX_GEO_TYPES,
}
