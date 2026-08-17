import 'server-only'
import { readFile, writeFile } from 'node:fs/promises'
import { and, desc, eq, isNull } from 'drizzle-orm'
import pLimit from 'p-limit'
import {
  HHT_BL_MECHANISMS,
  parseHhtBlLinkAnalysis,
  parseHhtBlSiteClassification,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtBlBacklinks,
  hhtBlCandidateSites,
  hhtBlCrawlResults,
  hhtBlLinkAnalyses,
  hhtBlLinkContexts,
  hhtBlReferringDomains,
  hhtBlResearchSites,
  hhtBlRunEvents,
  hhtBlSiteClassifications,
} from '../schema.js'
import { crawlHhtBlPage, extractHhtBlLinkContext } from './crawl.js'

async function storeCrawl(
  db: Database,
  runId: number,
  url: string,
  kind: 'source' | 'target' | 'site_sample',
  options: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<number> {
  const [existing] = await db
    .select({ id: hhtBlCrawlResults.id })
    .from(hhtBlCrawlResults)
    .where(
      and(
        eq(hhtBlCrawlResults.runId, runId),
        eq(hhtBlCrawlResults.url, url),
        eq(hhtBlCrawlResults.kind, kind),
      ),
    )
    .limit(1)
  if (existing) return existing.id

  const result = await crawlHhtBlPage(url, options)
  const [inserted] = await db
    .insert(hhtBlCrawlResults)
    .values({
      runId,
      url,
      kind,
      httpStatus: result.httpStatus,
      canonicalUrl: result.canonicalUrl,
      title: result.title,
      pageText: result.pageText,
      rawHtml: result.rawHtml,
      contentHash: result.contentHash,
      attempts: result.attempts,
      error: result.error,
    })
    .onConflictDoNothing()
    .returning({ id: hhtBlCrawlResults.id })
  if (inserted) return inserted.id
  const [raced] = await db
    .select({ id: hhtBlCrawlResults.id })
    .from(hhtBlCrawlResults)
    .where(
      and(
        eq(hhtBlCrawlResults.runId, runId),
        eq(hhtBlCrawlResults.url, url),
        eq(hhtBlCrawlResults.kind, kind),
      ),
    )
    .limit(1)
  if (!raced) throw new Error(`Could not store crawl for ${url}`)
  return raced.id
}

export async function crawlHhtBlBacklinks(
  db: Database,
  runId: number,
  options: { limit?: number; concurrency?: number; timeoutMs?: number; maxAttempts?: number } = {},
): Promise<{ attempted: number; located: number; failed: number }> {
  const requested = options.limit ?? 100
  const candidates = await db
    .select({
      id: hhtBlBacklinks.id,
      researchSiteId: hhtBlBacklinks.researchSiteId,
      sourceUrl: hhtBlBacklinks.sourceUrl,
      targetUrl: hhtBlBacklinks.targetUrl,
      researchSitesLinked: hhtBlReferringDomains.researchSitesLinked,
      referringAuthority: hhtBlReferringDomains.authorityScore,
      pageAuthority: hhtBlBacklinks.authorityScore,
    })
    .from(hhtBlBacklinks)
    .innerJoin(
      hhtBlReferringDomains,
      eq(hhtBlBacklinks.referringDomainId, hhtBlReferringDomains.id),
    )
    .leftJoin(hhtBlLinkContexts, eq(hhtBlLinkContexts.backlinkId, hhtBlBacklinks.id))
    .where(
      and(
        eq(hhtBlBacklinks.runId, runId),
        eq(hhtBlBacklinks.follow, true),
        isNull(hhtBlLinkContexts.id),
      ),
    )
    .orderBy(
      desc(hhtBlReferringDomains.researchSitesLinked),
      desc(hhtBlReferringDomains.authorityScore),
      desc(hhtBlBacklinks.authorityScore),
    )
    .limit(Math.max(1_000, requested * 10))

  const bySite = new Map<number, typeof candidates>()
  for (const row of candidates) {
    bySite.set(row.researchSiteId, [...(bySite.get(row.researchSiteId) ?? []), row])
  }
  const rows: typeof candidates = []
  while (rows.length < requested) {
    let added = false
    for (const queue of bySite.values()) {
      const row = queue.shift()
      if (!row) continue
      rows.push(row)
      added = true
      if (rows.length === requested) break
    }
    if (!added) break
  }
  const limit = pLimit(options.concurrency ?? 5)
  let located = 0
  let failed = 0
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        try {
          const [sourceCrawlId, targetCrawlId] = await Promise.all([
            storeCrawl(db, runId, row.sourceUrl, 'source', options),
            storeCrawl(db, runId, row.targetUrl, 'target', options),
          ])
          const [source, target] = await Promise.all([
            db.select().from(hhtBlCrawlResults).where(eq(hhtBlCrawlResults.id, sourceCrawlId)).limit(1),
            db.select().from(hhtBlCrawlResults).where(eq(hhtBlCrawlResults.id, targetCrawlId)).limit(1),
          ])
          const context = source[0]?.rawHtml
            ? extractHhtBlLinkContext(source[0].rawHtml, row.sourceUrl, row.targetUrl)
            : {
                located: false,
                anchor: null,
                surroundingParagraph: null,
                surroundingSection: null,
                headingHierarchy: [],
                nearbyOutboundLinks: [],
                domContext: null,
              }
          await db
            .insert(hhtBlLinkContexts)
            .values({
              backlinkId: row.id,
              sourceCrawlId,
              targetCrawlId,
              ...context,
              targetSummary: target[0]?.pageText?.slice(0, 4_000) ?? null,
            })
            .onConflictDoUpdate({
              target: hhtBlLinkContexts.backlinkId,
              set: {
                sourceCrawlId,
                targetCrawlId,
                ...context,
                targetSummary: target[0]?.pageText?.slice(0, 4_000) ?? null,
              },
            })
          await db
            .update(hhtBlBacklinks)
            .set({ state: 'CRAWLED', updatedAt: new Date() })
            .where(eq(hhtBlBacklinks.id, row.id))
          if (context.located) located += 1
        } catch {
          failed += 1
        }
      }),
    ),
  )
  await db.insert(hhtBlRunEvents).values({
    runId,
    stage: 'crawling',
    level: failed > 0 ? 'warn' : 'info',
    message: `Crawled ${rows.length} backlink pairs; located ${located}; failed ${failed}`,
    recordsProcessed: rows.length - failed,
    details: { located, failed },
  })
  return { attempted: rows.length, located, failed }
}

export async function writeHhtBlLinkAnalysisQueue(
  db: Database,
  runId: number,
  path: string,
  limit = 100,
): Promise<number> {
  const rows = await db
    .select({
      backlinkId: hhtBlBacklinks.id,
      sourceDomain: hhtBlReferringDomains.domain,
      sourcePageTitle: hhtBlBacklinks.sourceTitle,
      sourceSection: hhtBlLinkContexts.surroundingSection,
      anchor: hhtBlLinkContexts.anchor,
      competitorDomain: hhtBlCandidateSites.domain,
      competitorTargetUrl: hhtBlBacklinks.targetUrl,
      competitorTargetSummary: hhtBlLinkContexts.targetSummary,
      analogousSitesLinked: hhtBlReferringDomains.researchSitesLinked,
      authorityScore: hhtBlReferringDomains.authorityScore,
    })
    .from(hhtBlBacklinks)
    .innerJoin(hhtBlReferringDomains, eq(hhtBlBacklinks.referringDomainId, hhtBlReferringDomains.id))
    .innerJoin(hhtBlResearchSites, eq(hhtBlBacklinks.researchSiteId, hhtBlResearchSites.id))
    .innerJoin(hhtBlCandidateSites, eq(hhtBlResearchSites.candidateSiteId, hhtBlCandidateSites.id))
    .innerJoin(hhtBlLinkContexts, eq(hhtBlLinkContexts.backlinkId, hhtBlBacklinks.id))
    .leftJoin(hhtBlLinkAnalyses, eq(hhtBlLinkAnalyses.backlinkId, hhtBlBacklinks.id))
    .where(
      and(
        eq(hhtBlBacklinks.runId, runId),
        eq(hhtBlLinkContexts.located, true),
        isNull(hhtBlLinkAnalyses.id),
      ),
    )
    .orderBy(
      desc(hhtBlReferringDomains.researchSitesLinked),
      desc(hhtBlReferringDomains.authorityScore),
    )
    .limit(limit)
  await writeFile(
    path,
    rows
      .map((row) => JSON.stringify({ ...row, allowedMechanisms: HHT_BL_MECHANISMS }))
      .join('\n') + (rows.length > 0 ? '\n' : ''),
    'utf8',
  )
  return rows.length
}

export async function importHhtBlLinkAnalyses(
  db: Database,
  path: string,
  options: { provider?: string; model?: string } = {},
): Promise<number> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean)
  let imported = 0
  for (const line of lines) {
    const row = JSON.parse(line) as { backlinkId?: unknown; analysis?: unknown }
    if (!Number.isInteger(row.backlinkId)) throw new Error('analysis row needs an integer backlinkId')
    const analysis = parseHhtBlLinkAnalysis(row.analysis)
    await db
      .insert(hhtBlLinkAnalyses)
      .values({
        backlinkId: Number(row.backlinkId),
        provider: options.provider ?? 'codex',
        model: options.model ?? 'session',
        mechanism: analysis.mechanism,
        mechanismConfidence: analysis.mechanismConfidence,
        editorial: analysis.editorial,
        likelyPaid: analysis.likelyPaid,
        replicable: analysis.replicable,
        replicabilityScore: analysis.replicabilityScore,
        hotelHotTubsRelevance: analysis.hotelHotTubsRelevance,
        requiresNewAsset: analysis.requiresNewAsset,
        requiredAssetType: analysis.requiredAssetType,
        likelyContactRole: analysis.likelyContactRole,
        recommendedAction: analysis.recommendedAction,
        facts: analysis.facts,
        inferences: analysis.inferences,
        evidence: analysis.evidence,
        rawOutput: row.analysis as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: hhtBlLinkAnalyses.backlinkId,
        set: {
          provider: options.provider ?? 'codex',
          model: options.model ?? 'session',
          mechanism: analysis.mechanism,
          mechanismConfidence: analysis.mechanismConfidence,
          editorial: analysis.editorial,
          likelyPaid: analysis.likelyPaid,
          replicable: analysis.replicable,
          replicabilityScore: analysis.replicabilityScore,
          hotelHotTubsRelevance: analysis.hotelHotTubsRelevance,
          requiresNewAsset: analysis.requiresNewAsset,
          requiredAssetType: analysis.requiredAssetType,
          likelyContactRole: analysis.likelyContactRole,
          recommendedAction: analysis.recommendedAction,
          facts: analysis.facts,
          inferences: analysis.inferences,
          evidence: analysis.evidence,
          rawOutput: row.analysis as Record<string, unknown>,
          analyzedAt: new Date(),
        },
      })
    await db.update(hhtBlBacklinks).set({ state: 'ANALYZED', updatedAt: new Date() }).where(eq(hhtBlBacklinks.id, Number(row.backlinkId)))
    imported += 1
  }
  return imported
}

export async function importHhtBlSiteClassifications(
  db: Database,
  path: string,
  options: { model?: string } = {},
): Promise<number> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean)
  let imported = 0
  for (const line of lines) {
    const row = JSON.parse(line) as { candidateSiteId?: unknown; classification?: unknown }
    if (!Number.isInteger(row.candidateSiteId)) {
      throw new Error('classification row needs an integer candidateSiteId')
    }
    const candidateSiteId = Number(row.candidateSiteId)
    const classification = parseHhtBlSiteClassification(row.classification)
    await db
      .insert(hhtBlSiteClassifications)
      .values({ candidateSiteId, ...classification, model: options.model ?? 'codex-session' })
      .onConflictDoUpdate({
        target: hhtBlSiteClassifications.candidateSiteId,
        set: { ...classification, model: options.model ?? 'codex-session', classifiedAt: new Date() },
      })
    await db
      .update(hhtBlCandidateSites)
      .set({ state: 'CLASSIFIED', updatedAt: new Date() })
      .where(eq(hhtBlCandidateSites.id, candidateSiteId))
    imported += 1
  }
  return imported
}
