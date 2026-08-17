import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  exactBacklinkKey,
  normalizeHhtBlDomain,
  normalizeHhtBlUrl,
  type HhtBlStage,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtBlBacklinks,
  hhtBlCandidateSites,
  hhtBlJobs,
  hhtBlKeywords,
  hhtBlRawResponses,
  hhtBlReferringDomains,
  hhtBlResearchSites,
  hhtBlRunEvents,
  hhtBlRuns,
  hhtBlSerpResults,
  hhtBlSiteMetrics,
  hhtBlSiteReferringDomains,
} from '../schema.js'
import {
  nextSemrushPage,
  normalizeSemrushHeader,
  parseHhtSemrushEnvelope,
  parseSemrushRows,
  semrushBoolean,
  semrushInteger,
  semrushNumber,
  semrushPayloadHash,
  semrushRequestKey,
  semrushTimestamp,
  type HhtSemrushEnvelope,
} from './semrush.js'

const PAGINATED_REPORTS = new Set([
  'domain_organic_organic',
  'backlinks_competitors',
  'backlinks_matrix',
  'backlinks_refdomains',
  'backlinks',
])

const PROVENANCE: Record<string, string> = {
  phrase_organic: 'serp',
  domain_organic_organic: 'organic_competitor',
  backlinks_competitors: 'backlink_competitor',
}

const REPORT_STAGE: Record<string, HhtBlStage> = {
  phrase_organic: 'serp_discovery',
  domain_rank: 'site_enrichment',
  domain_organic_organic: 'competitor_discovery',
  backlinks_competitors: 'competitor_discovery',
  backlinks_comparison: 'site_enrichment',
  backlinks_overview: 'site_enrichment',
  backlinks_matrix: 'backlink_matrix',
  backlinks_refdomains: 'backlink_collection',
  backlinks: 'backlink_collection',
}

async function importOrganicMetrics(
  db: Database,
  runId: number,
  rawResponseId: number,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const domain = normalizeHhtBlDomain(
      row['domain'] || String(params['domain'] ?? params['target'] ?? ''),
    )
    if (!domain) {
      skipped += 1
      continue
    }
    const candidateId = await upsertCandidate(db, { runId, domain, provenance: 'metrics' })
    const values = {
      rawResponseId,
      organicKeywords: semrushInteger(row['organic_keywords']),
      estimatedOrganicTraffic: semrushInteger(row['organic_traffic']),
      estimatedTrafficValue: semrushNumber(row['organic_traffic_cost']),
      measuredAt: new Date(),
    }
    await db
      .insert(hhtBlSiteMetrics)
      .values({ candidateSiteId: candidateId, ...values })
      .onConflictDoUpdate({ target: hhtBlSiteMetrics.candidateSiteId, set: values })
    imported += 1
  }
  return { imported, skipped }
}

export interface HhtBlImportResult {
  rawResponseId: number
  rowsReceived: number
  recordsImported: number
  recordsSkipped: number
  nofollowRows: number
  jobStatus: 'PENDING' | 'COMPLETE' | null
  nextOffset: number | null
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

async function upsertCandidate(
  db: Database,
  input: { runId: number; domain: string; provenance?: string; seedDomain?: string; depth?: number },
): Promise<number> {
  const domain = normalizeHhtBlDomain(input.domain)
  if (!domain) throw new Error(`Cannot normalize candidate domain: ${input.domain}`)
  const [existing] = await db
    .select()
    .from(hhtBlCandidateSites)
    .where(and(eq(hhtBlCandidateSites.runId, input.runId), eq(hhtBlCandidateSites.domain, domain)))
    .limit(1)
  if (existing) {
    await db
      .update(hhtBlCandidateSites)
      .set({
        provenance: unique([...existing.provenance, input.provenance ?? '']),
        seedDomains: unique([...existing.seedDomains, input.seedDomain ?? '']),
        discoveryDepth: Math.min(existing.discoveryDepth, input.depth ?? existing.discoveryDepth),
        updatedAt: new Date(),
      })
      .where(eq(hhtBlCandidateSites.id, existing.id))
    return existing.id
  }
  const [inserted] = await db
    .insert(hhtBlCandidateSites)
    .values({
      runId: input.runId,
      domain,
      provenance: input.provenance ? [input.provenance] : [],
      seedDomains: input.seedDomain ? [input.seedDomain] : [],
      discoveryDepth: input.depth ?? 0,
    })
    .returning({ id: hhtBlCandidateSites.id })
  if (!inserted) throw new Error(`Failed to insert candidate ${domain}`)
  return inserted.id
}

export async function seedHhtBlCandidateSites(
  db: Database,
  runId: number,
  seeds: Array<{ domain: string; cohort?: string; source?: string }>,
): Promise<{ inserted: number; existing: number }> {
  let inserted = 0
  let existing = 0
  for (const seed of seeds) {
    const domain = normalizeHhtBlDomain(seed.domain)
    if (!domain) continue
    const [before] = await db
      .select({ id: hhtBlCandidateSites.id })
      .from(hhtBlCandidateSites)
      .where(and(eq(hhtBlCandidateSites.runId, runId), eq(hhtBlCandidateSites.domain, domain)))
      .limit(1)
    await upsertCandidate(db, {
      runId,
      domain,
      provenance: seed.cohort ? `curated_seed:${seed.cohort}` : seed.source ?? 'curated_seed',
      seedDomain: domain,
      depth: 0,
    })
    if (before) existing += 1
    else inserted += 1
  }
  return { inserted, existing }
}

async function upsertRawResponse(
  db: Database,
  runId: number,
  jobId: number | null,
  envelope: HhtSemrushEnvelope,
  rowsReceived: number,
): Promise<number> {
  const requestKey = semrushRequestKey(envelope.report, envelope.params)
  const payloadHash = semrushPayloadHash(envelope.body)
  const inserted = await db
    .insert(hhtBlRawResponses)
    .values({
      ...(jobId === null ? {} : { jobId }),
      runId,
      provider: 'semrush_mcp',
      reportType: envelope.report,
      requestKey,
      parameters: envelope.params,
      rawText: envelope.body,
      payloadHash,
      rowsReceived,
      estimatedUnitsConsumed: envelope.estimatedUnitsConsumed ?? null,
      accountIdentifier: envelope.accountIdentifier ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: hhtBlRawResponses.id })
  if (inserted[0]) return inserted[0].id
  const [existing] = await db
    .select({ id: hhtBlRawResponses.id })
    .from(hhtBlRawResponses)
    .where(
      and(
        eq(hhtBlRawResponses.runId, runId),
        eq(hhtBlRawResponses.requestKey, requestKey),
        eq(hhtBlRawResponses.payloadHash, payloadHash),
      ),
    )
    .limit(1)
  if (!existing) throw new Error('raw response conflict occurred but the row could not be read')
  return existing.id
}

async function findResearchSite(db: Database, runId: number, target: string) {
  const domain = normalizeHhtBlDomain(target)
  if (!domain) throw new Error(`Cannot normalize research target ${target}`)
  const [site] = await db
    .select({ id: hhtBlResearchSites.id, candidateId: hhtBlCandidateSites.id, domain: hhtBlCandidateSites.domain })
    .from(hhtBlResearchSites)
    .innerJoin(hhtBlCandidateSites, eq(hhtBlResearchSites.candidateSiteId, hhtBlCandidateSites.id))
    .where(and(eq(hhtBlResearchSites.runId, runId), eq(hhtBlCandidateSites.domain, domain)))
    .limit(1)
  if (!site) throw new Error(`${domain} is not selected as an HHT research site for run ${runId}`)
  return site
}

async function upsertReferringDomain(
  db: Database,
  input: {
    runId: number
    domain: string
    authorityScore?: number | null
    domainScore?: number | null
    researchSitesLinked?: number
    totalBacklinks?: number
    firstSeenAt?: Date | null
    lastSeenAt?: Date | null
  },
): Promise<number> {
  const domain = normalizeHhtBlDomain(input.domain)
  if (!domain) throw new Error(`Cannot normalize referring domain ${input.domain}`)
  const [existing] = await db
    .select({ id: hhtBlReferringDomains.id })
    .from(hhtBlReferringDomains)
    .where(and(eq(hhtBlReferringDomains.runId, input.runId), eq(hhtBlReferringDomains.domain, domain)))
    .limit(1)
  if (existing) {
    const patch: Record<string, unknown> = {}
    if (input.authorityScore !== undefined && input.authorityScore !== null) patch['authorityScore'] = input.authorityScore
    if (input.domainScore !== undefined && input.domainScore !== null) patch['domainScore'] = input.domainScore
    if (input.researchSitesLinked !== undefined) patch['researchSitesLinked'] = input.researchSitesLinked
    if (input.totalBacklinks !== undefined) patch['totalBacklinks'] = input.totalBacklinks
    if (input.firstSeenAt !== undefined && input.firstSeenAt !== null) patch['firstSeenAt'] = input.firstSeenAt
    if (input.lastSeenAt !== undefined && input.lastSeenAt !== null) patch['lastSeenAt'] = input.lastSeenAt
    if (Object.keys(patch).length > 0) {
      await db.update(hhtBlReferringDomains).set(patch).where(eq(hhtBlReferringDomains.id, existing.id))
    }
    return existing.id
  }
  const inserted = await db
    .insert(hhtBlReferringDomains)
    .values({
      runId: input.runId,
      domain,
      authorityScore: input.authorityScore ?? null,
      domainScore: input.domainScore ?? null,
      researchSitesLinked: input.researchSitesLinked ?? 0,
      totalBacklinks: input.totalBacklinks ?? 0,
      firstSeenAt: input.firstSeenAt ?? null,
      lastSeenAt: input.lastSeenAt ?? null,
    })
    .returning({ id: hhtBlReferringDomains.id })
  if (!inserted[0]) throw new Error(`Failed to upsert referring domain ${domain}`)
  return inserted[0].id
}

async function importSerp(
  db: Database,
  runId: number,
  rawResponseId: number,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number }> {
  const phrase = String(params['phrase'] ?? '')
  let [keyword] = await db
    .select({ id: hhtBlKeywords.id })
    .from(hhtBlKeywords)
    .where(and(eq(hhtBlKeywords.runId, runId), eq(hhtBlKeywords.keyword, phrase)))
    .limit(1)
  if (!keyword) {
    ;[keyword] = await db
      .insert(hhtBlKeywords)
      .values({ runId, category: 'imported', destination: 'unknown', keyword: phrase })
      .returning({ id: hhtBlKeywords.id })
  }
  if (!keyword) throw new Error(`Could not resolve keyword ${phrase}`)

  let imported = 0
  let skipped = 0
  const touchedDomains: string[] = []
  for (const row of rows) {
    const domain = normalizeHhtBlDomain(row['domain'])
    const url = normalizeHhtBlUrl(row['url'])
    const position = semrushInteger(row['position'])
    if (!domain || !url || position === null) {
      skipped += 1
      continue
    }
    await upsertCandidate(db, { runId, domain, provenance: 'serp', depth: 0 })
    await db
      .insert(hhtBlSerpResults)
      .values({
        keywordId: keyword.id,
        rawResponseId,
        position,
        domain,
        url,
        title: row['title'] || null,
      })
      .onConflictDoNothing()
    touchedDomains.push(domain)
    imported += 1
  }
  await refreshSerpAggregates(db, runId, unique(touchedDomains))
  return { imported, skipped }
}

async function refreshSerpAggregates(db: Database, runId: number, domains: string[]): Promise<void> {
  if (domains.length === 0) return
  const rows = await db
    .select({
      domain: hhtBlSerpResults.domain,
      appearances: sql<number>`count(*)::int`,
      top3: sql<number>`count(*) filter (where ${hhtBlSerpResults.position} <= 3)::int`,
      top5: sql<number>`count(*) filter (where ${hhtBlSerpResults.position} <= 5)::int`,
      top10: sql<number>`count(*) filter (where ${hhtBlSerpResults.position} <= 10)::int`,
      categories: sql<number>`count(distinct ${hhtBlKeywords.category})::int`,
      destinations: sql<number>`count(distinct ${hhtBlKeywords.destination})::int`,
      visibility: sql<number>`sum(case
        when ${hhtBlSerpResults.position} = 1 then 1.0
        when ${hhtBlSerpResults.position} = 2 then 0.85
        when ${hhtBlSerpResults.position} = 3 then 0.75
        when ${hhtBlSerpResults.position} <= 5 then 0.60
        when ${hhtBlSerpResults.position} <= 10 then 0.40
        when ${hhtBlSerpResults.position} <= 20 then 0.15
        else 0 end)::float`,
      volumeVisibility: sql<number | null>`sum(case
        when ${hhtBlKeywords.searchVolume} is null then null
        when ${hhtBlSerpResults.position} = 1 then ${hhtBlKeywords.searchVolume} * 1.0
        when ${hhtBlSerpResults.position} = 2 then ${hhtBlKeywords.searchVolume} * 0.85
        when ${hhtBlSerpResults.position} = 3 then ${hhtBlKeywords.searchVolume} * 0.75
        when ${hhtBlSerpResults.position} <= 5 then ${hhtBlKeywords.searchVolume} * 0.60
        when ${hhtBlSerpResults.position} <= 10 then ${hhtBlKeywords.searchVolume} * 0.40
        when ${hhtBlSerpResults.position} <= 20 then ${hhtBlKeywords.searchVolume} * 0.15
        else 0 end)::float`,
    })
    .from(hhtBlSerpResults)
    .innerJoin(hhtBlKeywords, eq(hhtBlSerpResults.keywordId, hhtBlKeywords.id))
    .where(and(eq(hhtBlKeywords.runId, runId), inArray(hhtBlSerpResults.domain, domains)))
    .groupBy(hhtBlSerpResults.domain)

  for (const row of rows) {
    await db
      .update(hhtBlCandidateSites)
      .set({
        serpAppearances: row.appearances,
        top3Appearances: row.top3,
        top5Appearances: row.top5,
        top10Appearances: row.top10,
        uniqueKeywordCategories: row.categories,
        uniqueDestinations: row.destinations,
        weightedVisibility: row.visibility,
        weightedSearchVolumeVisibility: row.volumeVisibility,
        updatedAt: new Date(),
      })
      .where(and(eq(hhtBlCandidateSites.runId, runId), eq(hhtBlCandidateSites.domain, row.domain)))
  }
}

async function importCompetitors(
  db: Database,
  runId: number,
  report: string,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number }> {
  const seedDomain = String(params['domain'] ?? params['target'] ?? '')
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const domain = row['domain'] || row['neighbour']
    const normalizedDomain = normalizeHhtBlDomain(domain)
    if (!normalizedDomain) {
      skipped += 1
      continue
    }
    const candidateId = await upsertCandidate(db, {
      runId,
      domain: normalizedDomain,
      provenance: PROVENANCE[report] ?? report,
      seedDomain,
      depth: 1,
    })
    if (report === 'domain_organic_organic') {
      await db
        .insert(hhtBlSiteMetrics)
        .values({
          candidateSiteId: candidateId,
          organicKeywords: semrushInteger(row['organic_keywords']),
          estimatedOrganicTraffic: semrushInteger(row['organic_traffic']),
          estimatedTrafficValue: semrushNumber(row['organic_cost'] ?? row['organic_traffic_cost']),
        })
        .onConflictDoUpdate({
          target: hhtBlSiteMetrics.candidateSiteId,
          set: {
            organicKeywords: semrushInteger(row['organic_keywords']),
            estimatedOrganicTraffic: semrushInteger(row['organic_traffic']),
            estimatedTrafficValue: semrushNumber(row['organic_cost'] ?? row['organic_traffic_cost']),
            measuredAt: new Date(),
          },
        })
    }
    imported += 1
  }
  return { imported, skipped }
}

async function importMetrics(
  db: Database,
  runId: number,
  rawResponseId: number,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const target = row['target'] || String(params['target'] ?? '')
    const domain = normalizeHhtBlDomain(target)
    if (!domain) {
      skipped += 1
      continue
    }
    const candidateId = await upsertCandidate(db, { runId, domain, provenance: 'metrics' })
    await db
      .insert(hhtBlSiteMetrics)
      .values({
        candidateSiteId: candidateId,
        rawResponseId,
        authorityScore: semrushInteger(row['authority_score'] ?? row['ascore']),
        totalBacklinks: semrushInteger(row['backlinks_num'] ?? row['total']),
        referringDomains: semrushInteger(row['domains_num']),
        followBacklinks: semrushInteger(row['follows_num']),
        nofollowBacklinks: semrushInteger(row['nofollows_num']),
      })
      .onConflictDoUpdate({
        target: hhtBlSiteMetrics.candidateSiteId,
        set: {
          rawResponseId,
          authorityScore: semrushInteger(row['authority_score'] ?? row['ascore']),
          totalBacklinks: semrushInteger(row['backlinks_num'] ?? row['total']),
          referringDomains: semrushInteger(row['domains_num']),
          followBacklinks: semrushInteger(row['follows_num']),
          nofollowBacklinks: semrushInteger(row['nofollows_num']),
          measuredAt: new Date(),
        },
      })
    imported += 1
  }
  return { imported, skipped }
}

async function importMatrix(
  db: Database,
  runId: number,
  rawResponseId: number,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number }> {
  const targets = Array.isArray(params['targets']) ? params['targets'].map(String) : []
  const sitesByHeader = new Map<string, Awaited<ReturnType<typeof findResearchSite>>>()
  for (const target of targets) {
    sitesByHeader.set(normalizeSemrushHeader(target), await findResearchSite(db, runId, target))
  }
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const domain = row['domain']
    const normalizedDomain = normalizeHhtBlDomain(domain)
    if (!normalizedDomain) {
      skipped += 1
      continue
    }
    const refId = await upsertReferringDomain(db, {
      runId,
      domain: normalizedDomain,
      authorityScore: semrushInteger(row['domain_ascore'] ?? row['domain_authority_score']),
      domainScore: semrushInteger(row['domain_score']),
      researchSitesLinked: semrushInteger(row['matches_num']) ?? 0,
      totalBacklinks: semrushInteger(row['backlinks_num']) ?? 0,
    })
    for (const [header, site] of sitesByHeader) {
      const count = semrushInteger(row[header]) ?? 0
      if (count === 0) continue
      await db
        .insert(hhtBlSiteReferringDomains)
        .values({
          researchSiteId: site.id,
          referringDomainId: refId,
          backlinkCount: count,
          rawResponseId,
        })
        .onConflictDoUpdate({
          target: [hhtBlSiteReferringDomains.researchSiteId, hhtBlSiteReferringDomains.referringDomainId],
          set: { backlinkCount: count, rawResponseId },
        })
    }
    imported += 1
  }
  return { imported, skipped }
}

async function importReferringDomains(
  db: Database,
  runId: number,
  rawResponseId: number,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number }> {
  const site = await findResearchSite(db, runId, String(params['target'] ?? ''))
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    if (!normalizeHhtBlDomain(row['domain'])) {
      skipped += 1
      continue
    }
    const refId = await upsertReferringDomain(db, {
      runId,
      domain: row['domain']!,
      authorityScore: semrushInteger(row['domain_ascore'] ?? row['domain_authority_score']),
      domainScore: semrushInteger(row['domain_score']),
      totalBacklinks: semrushInteger(row['backlinks_num']) ?? 0,
      firstSeenAt: semrushTimestamp(row['first_seen']),
      lastSeenAt: semrushTimestamp(row['last_seen']),
    })
    await db
      .insert(hhtBlSiteReferringDomains)
      .values({
        researchSiteId: site.id,
        referringDomainId: refId,
        backlinkCount: semrushInteger(row['backlinks_num']) ?? 0,
        rawResponseId,
      })
      .onConflictDoUpdate({
        target: [hhtBlSiteReferringDomains.researchSiteId, hhtBlSiteReferringDomains.referringDomainId],
        set: { backlinkCount: semrushInteger(row['backlinks_num']) ?? 0, rawResponseId },
      })
    imported += 1
  }
  return { imported, skipped }
}

async function importBacklinks(
  db: Database,
  runId: number,
  rawResponseId: number,
  params: Record<string, unknown>,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; skipped: number; nofollow: number }> {
  const target = String(params['target'] ?? '')
  const site = await findResearchSite(db, runId, target)
  let imported = 0
  let skipped = 0
  let nofollow = 0
  for (const row of rows) {
    const sourceUrlRaw = row['source_url'] ?? ''
    const targetUrlRaw = row['target_url'] ?? ''
    const sourceUrl = normalizeHhtBlUrl(sourceUrlRaw)
    const targetUrl = normalizeHhtBlUrl(targetUrlRaw)
    const referringDomain = normalizeHhtBlDomain(sourceUrlRaw)
    const key = exactBacklinkKey({ sourceUrl: sourceUrlRaw, targetUrl: targetUrlRaw, researchSite: target })
    if (!sourceUrl || !targetUrl || !referringDomain || !key) {
      skipped += 1
      continue
    }
    const isNofollow = semrushBoolean(row['nofollow'])
    const follow = isNofollow === null ? null : !isNofollow
    if (follow === false) nofollow += 1
    const refId = await upsertReferringDomain(db, {
      runId,
      domain: referringDomain,
      firstSeenAt: semrushTimestamp(row['first_seen']),
      lastSeenAt: semrushTimestamp(row['last_seen']),
    })
    await db
      .insert(hhtBlBacklinks)
      .values({
        runId,
        researchSiteId: site.id,
        referringDomainId: refId,
        rawResponseId,
        exactKey: key,
        state: 'NORMALIZED',
        sourceUrlRaw,
        sourceUrl,
        sourceTitle: row['source_title'] || null,
        targetUrlRaw,
        targetUrl,
        targetTitle: row['target_title'] || null,
        anchor: row['anchor'] || null,
        follow,
        firstSeenAt: semrushTimestamp(row['first_seen']),
        lastSeenAt: semrushTimestamp(row['last_seen']),
        authorityScore: semrushInteger(row['page_ascore']),
        sourcePageScore: semrushInteger(row['page_score']),
        responseCode: semrushInteger(row['response_code']),
        sitewide: semrushBoolean(row['sitewide']),
        newLink: semrushBoolean(row['newlink']),
        lostLink: semrushBoolean(row['lostlink']),
      })
      .onConflictDoUpdate({
        target: [hhtBlBacklinks.runId, hhtBlBacklinks.exactKey],
        set: {
          rawResponseId,
          sourceTitle: row['source_title'] || null,
          targetTitle: row['target_title'] || null,
          anchor: row['anchor'] || null,
          follow,
          lastSeenAt: semrushTimestamp(row['last_seen']),
          authorityScore: semrushInteger(row['page_ascore']),
          sourcePageScore: semrushInteger(row['page_score']),
          responseCode: semrushInteger(row['response_code']),
          sitewide: semrushBoolean(row['sitewide']),
          newLink: semrushBoolean(row['newlink']),
          lostLink: semrushBoolean(row['lostlink']),
          updatedAt: new Date(),
        },
      })
    imported += 1
  }
  return { imported, skipped, nofollow }
}

export async function importHhtBlSemrushResponse(
  db: Database,
  runId: number,
  jobId: number | null,
  envelope: HhtSemrushEnvelope,
): Promise<HhtBlImportResult> {
  envelope = parseHhtSemrushEnvelope(envelope)
  const provisionalRows = envelope.body.trim()
    ? Math.max(0, envelope.body.trim().split(/\r?\n/).length - 1)
    : 0
  const rawResponseId = await upsertRawResponse(db, runId, jobId, envelope, provisionalRows)
  const rows = parseSemrushRows(envelope.body)
  if (rows.length !== provisionalRows) {
    await db
      .update(hhtBlRawResponses)
      .set({ rowsReceived: rows.length })
      .where(eq(hhtBlRawResponses.id, rawResponseId))
  }
  let recordsImported = 0
  let recordsSkipped = 0
  let nofollowRows = 0

  if (envelope.report === 'phrase_organic') {
    const result = await importSerp(db, runId, rawResponseId, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
  } else if (envelope.report === 'domain_rank') {
    const result = await importOrganicMetrics(db, runId, rawResponseId, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
  } else if (
    envelope.report === 'domain_organic_organic' ||
    envelope.report === 'backlinks_competitors'
  ) {
    const result = await importCompetitors(db, runId, envelope.report, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
  } else if (envelope.report === 'backlinks_comparison' || envelope.report === 'backlinks_overview') {
    const result = await importMetrics(db, runId, rawResponseId, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
  } else if (envelope.report === 'backlinks_matrix') {
    const result = await importMatrix(db, runId, rawResponseId, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
  } else if (envelope.report === 'backlinks_refdomains') {
    const result = await importReferringDomains(db, runId, rawResponseId, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
  } else if (envelope.report === 'backlinks') {
    const result = await importBacklinks(db, runId, rawResponseId, envelope.params, rows)
    recordsImported = result.imported
    recordsSkipped = result.skipped
    nofollowRows = result.nofollow
  }

  let jobStatus: 'PENDING' | 'COMPLETE' | null = null
  let nextOffset: number | null = null
  let stage: HhtBlStage = REPORT_STAGE[envelope.report] ?? 'serp_discovery'
  if (jobId !== null) {
    const [job] = await db.select().from(hhtBlJobs).where(eq(hhtBlJobs.id, jobId)).limit(1)
    if (!job || job.runId !== runId) throw new Error(`Job ${jobId} does not belong to run ${runId}`)
    stage = job.stage
    const [totals] = await db
      .select({
        rows: sql<number>`coalesce(sum(${hhtBlRawResponses.rowsReceived}), 0)::int`,
        units: sql<number | null>`sum(${hhtBlRawResponses.estimatedUnitsConsumed})::float`,
      })
      .from(hhtBlRawResponses)
      .where(eq(hhtBlRawResponses.jobId, jobId))
    const uniqueRowsReceived = totals?.rows ?? rows.length
    const page = nextSemrushPage({
      offset: job.offset,
      limit: job.limit,
      rowsReceived: rows.length,
      totalRowsReceived: Math.max(0, uniqueRowsReceived - rows.length),
      maxRows: job.rowsRequested,
    })
    const paginated = PAGINATED_REPORTS.has(envelope.report)
    jobStatus = paginated && !page.complete ? 'PENDING' : 'COMPLETE'
    nextOffset = paginated && !page.complete ? page.offset : null
    await db
      .update(hhtBlJobs)
      .set({
        status: jobStatus,
        offset: nextOffset ?? job.offset,
        recordsCompleted: uniqueRowsReceived,
        rowsReceived: uniqueRowsReceived,
        estimatedUnitsConsumed: totals?.units ?? null,
        accountIdentifier: envelope.accountIdentifier ?? job.accountIdentifier,
        lastSuccessAt: new Date(),
        error: null,
        updatedAt: new Date(),
        ...(jobStatus === 'COMPLETE' ? { finishedAt: new Date() } : {}),
      })
      .where(eq(hhtBlJobs.id, jobId))
  }

  await db
    .update(hhtBlRuns)
    .set({ status: 'RUNNING', currentStage: stage, waitingReason: null, error: null, updatedAt: new Date() })
    .where(eq(hhtBlRuns.id, runId))
  await db.insert(hhtBlRunEvents).values({
    runId,
    ...(jobId === null ? {} : { jobId }),
    stage,
    message: `Imported ${recordsImported}/${rows.length} ${envelope.report} rows`,
    provider: 'semrush_mcp',
    recordsProcessed: recordsImported,
    details: {
      rawResponseId,
      recordsSkipped,
      nofollowRows,
      nextOffset,
      creditConsumption: envelope.estimatedUnitsConsumed ?? 'unknown',
    },
  })

  return {
    rawResponseId,
    rowsReceived: rows.length,
    recordsImported,
    recordsSkipped,
    nofollowRows,
    jobStatus,
    nextOffset,
  }
}
