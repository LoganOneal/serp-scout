import 'server-only'
import pLimit from 'p-limit'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  classifyHotelBlPageType,
  isHotelBlEditorialPageType,
  normalizeHotelBlUrl,
  type HotelBlRelationshipType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hotelBlContacts,
  hotelBlDiscoveredPages,
  hotelBlDomains,
  hotelBlEditorialLinks,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlRelationships,
  hotelBlRunEvents,
  hotelBlRuns,
} from '../schema.js'
import {
  conventionalHotelBlPaths,
  extractHotelBlPage,
  extractHotelBlSitemapIndexUrls,
  extractHotelBlSitemapUrls,
  fetchHotelBlPage,
  HOTEL_BL_CRAWL_CONFIG,
  hotelBlContentHash,
  parseHotelBlRobots,
} from './crawl.js'
import { recalculateHotelBlOpportunities } from './scoring.js'
import { executeHotelBlUrlValidation } from './validation.js'

type ClaimedJob = typeof hotelBlJobs.$inferSelect

async function claimHotelBlJob(db: Database, runId: number): Promise<ClaimedJob | null> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE hotel_bl_jobs
       SET status = 'running',
           claimed_at = now(),
           attempts = attempts + 1,
           updated_at = now(),
           error = NULL
     WHERE id = (
       SELECT id FROM hotel_bl_jobs
        WHERE run_id = ${runId}
          AND status = 'pending'
          AND stage IN ('crawl_homepage', 'crawl_alternate_entities')
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
       AND status = 'pending'
    RETURNING id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null
  const [job] = await db.select().from(hotelBlJobs).where(eq(hotelBlJobs.id, id)).limit(1)
  return job ?? null
}

export async function redriveStaleHotelBlJobs(db: Database, runId: number): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE hotel_bl_jobs
       SET status = 'pending', claimed_at = NULL, updated_at = now(),
           error = COALESCE(error || ' ', '') || 'Re-driven after a stale worker claim.'
     WHERE run_id = ${runId}
       AND status = 'running'
       AND claimed_at < now() - interval '30 minutes'
    RETURNING id
  `)
  return (rows as unknown as Array<{ id: number }>).length
}

async function robotsPolicy(origin: string): Promise<string | null> {
  const result = await fetchHotelBlPage(new URL('/robots.txt', origin).toString(), { maxAttempts: 1 })
  return result.status === 200 ? result.html : null
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

async function upsertAlternateEntity(
  db: Database,
  input: {
    runId: number
    sourceDomainId: number
    entity: ReturnType<typeof extractHotelBlPage>['alternateEntities'][number]
    sourceUrl: string
  },
): Promise<number> {
  const [existingDomain] = await db
    .select({
      id: hotelBlDomains.id,
      entityName: hotelBlDomains.entityName,
      entityType: hotelBlDomains.entityType,
    })
    .from(hotelBlDomains)
    .where(eq(hotelBlDomains.domain, input.entity.domain))
    .limit(1)
  let domainId = existingDomain?.id
  if (!domainId) {
    const [inserted] = await db
      .insert(hotelBlDomains)
      .values({
        lastRunId: input.runId,
        domain: input.entity.domain,
        rootDomain: input.entity.rootDomain,
        canonicalUrl: `https://${input.entity.domain}/`,
        entityName: input.entity.entityName,
        entityType: input.entity.relationshipType,
        siteControlType:
          input.entity.relationshipType === 'management_company' ? 'management_company_site' : 'unknown',
        siteControlConfidence: input.entity.confidence,
        siteControlReason: `Discovered from explicit ${input.entity.relationshipType.replaceAll('_', ' ')} evidence.`,
        needsReview: input.entity.confidence < 0.75,
      })
      .returning({ id: hotelBlDomains.id })
    domainId = inserted?.id
  }
  if (!domainId) throw new Error(`Could not upsert alternate domain ${input.entity.domain}`)

  if (existingDomain) {
    await db
      .update(hotelBlDomains)
      .set({
        lastRunId: input.runId,
        entityName: existingDomain.entityName ?? input.entity.entityName,
        entityType:
          existingDomain.entityType && existingDomain.entityType !== 'unknown'
            ? existingDomain.entityType
            : input.entity.relationshipType,
        updatedAt: new Date(),
      })
      .where(eq(hotelBlDomains.id, domainId))
  }

  const [sourceDomain] = await db
    .select({ hotelCount: hotelBlDomains.hotelCount })
    .from(hotelBlDomains)
    .where(eq(hotelBlDomains.id, input.sourceDomainId))
    .limit(1)
  const sourceRelationships = await db
    .select({ hotelId: hotelBlRelationships.hotelId, sourceUrl: hotelBlRelationships.sourceUrl })
    .from(hotelBlRelationships)
    .where(eq(hotelBlRelationships.domainId, input.sourceDomainId))
  const evidencePath = new URL(input.sourceUrl).pathname.replace(/\/$/, '') || '/'
  const hotels = sourceRelationships.filter((relationship) => {
    if ((sourceDomain?.hotelCount ?? 0) <= 3) return true
    const source = normalizeHotelBlUrl(relationship.sourceUrl)
    if (!source) return false
    const propertyPath = new URL(source.url).pathname.replace(/\/$/, '') || '/'
    if (propertyPath === '/') return false
    return evidencePath === propertyPath || evidencePath.startsWith(`${propertyPath}/`)
  })
  for (const { hotelId } of hotels) {
    await db
      .insert(hotelBlRelationships)
      .values({
        hotelId,
        domainId,
        relationshipType: input.entity.relationshipType,
        confidence: input.entity.confidence,
        source: 'deterministic_page_extraction',
        sourceUrl: input.sourceUrl,
        evidence: [input.entity.evidence, input.entity.url],
        needsReview: input.entity.confidence < 0.75,
      })
      .onConflictDoUpdate({
        target: [
          hotelBlRelationships.hotelId,
          hotelBlRelationships.domainId,
          hotelBlRelationships.relationshipType,
        ],
        set: {
          confidence: input.entity.confidence,
          sourceUrl: input.sourceUrl,
          evidence: [input.entity.evidence, input.entity.url],
          updatedAt: new Date(),
        },
      })
  }
  await db.execute(sql`
    update hotel_bl_domains
       set hotel_count = (
             select count(distinct hotel_id)::int
               from hotel_bl_relationships
              where domain_id = ${domainId}
           ),
           singleton_domain = (
             select count(distinct hotel_id) = 1
               from hotel_bl_relationships
              where domain_id = ${domainId}
           ),
           updated_at = now()
     where id = ${domainId}
  `)
  await db
    .insert(hotelBlJobs)
    .values({
      runId: input.runId,
      domainId,
      stage: 'crawl_alternate_entities',
      requestKey: `crawl:${domainId}`,
      configuration: { seedUrls: [input.entity.url], discoveredFrom: input.sourceUrl },
    })
    .onConflictDoNothing()
  return domainId
}

async function crawlDomainJob(db: Database, job: ClaimedJob): Promise<number> {
  if (!job.domainId) throw new Error('A crawl job is missing its domain.')
  const [domain] = await db.select().from(hotelBlDomains).where(eq(hotelBlDomains.id, job.domainId)).limit(1)
  if (!domain) throw new Error(`Domain ${job.domainId} no longer exists.`)
  await db
    .update(hotelBlDomains)
    .set({ crawlStatus: 'running', crawlError: null, updatedAt: new Date() })
    .where(eq(hotelBlDomains.id, domain.id))
  const configuration = job.configuration as { seedUrls?: string[]; centralizedBrand?: boolean }
  const seeds = unique((configuration.seedUrls ?? [domain.canonicalUrl]).filter((url) => normalizeHotelBlUrl(url)))
  const origin = new URL(domain.canonicalUrl).origin
  const robots = await robotsPolicy(origin)
  const allows = (url: string): boolean => !robots || parseHotelBlRobots(robots, new URL(url).pathname)
  const targets = new Map<string, Date | null>()
  const seedSet = new Set<string>()
  for (const seed of seeds) {
    if (!allows(seed)) continue
    targets.set(seed, null)
    seedSet.add(seed)
  }

  const sitemap = await fetchHotelBlPage(new URL('/sitemap.xml', origin).toString(), { maxAttempts: 1 })
  if (sitemap.html) {
    const sitemapBodies = [sitemap.html]
    for (const nestedUrl of extractHotelBlSitemapIndexUrls(sitemap.html)) {
      const normalizedNested = normalizeHotelBlUrl(nestedUrl)
      if (!normalizedNested || normalizedNested.hostname !== domain.domain || !allows(normalizedNested.url)) continue
      const nested = await fetchHotelBlPage(normalizedNested.url, { maxAttempts: 1 })
      if (nested.html) sitemapBodies.push(nested.html)
    }
    for (const entry of sitemapBodies.flatMap((body) => extractHotelBlSitemapUrls(body))) {
      const normalized = normalizeHotelBlUrl(entry.url)
      if (!normalized || normalized.hostname !== domain.domain || !allows(normalized.url)) continue
      if (classifyHotelBlPageType(normalized.url) !== 'other') targets.set(normalized.url, entry.lastModified)
      if (targets.size >= HOTEL_BL_CRAWL_CONFIG.maxPagesPerDomain) break
    }
  }

  let crawled = 0
  const visited = new Set<string>()
  const queue = [...targets.keys()].map((url) => ({ url, depth: seedSet.has(url) ? 0 : 1 }))
  let conventionalAdded = false
  while (queue.length > 0 && crawled < HOTEL_BL_CRAWL_CONFIG.maxPagesPerDomain) {
    const { url: requestedUrl, depth } = queue.shift()!
    if (visited.has(requestedUrl) || !allows(requestedUrl)) continue
    visited.add(requestedUrl)
    if (crawled > 0) await new Promise((resolve) => setTimeout(resolve, HOTEL_BL_CRAWL_CONFIG.perDomainDelayMs))
    const fetched = await fetchHotelBlPage(requestedUrl)
    const normalizedFetched = normalizeHotelBlUrl(fetched.url) ?? normalizeHotelBlUrl(requestedUrl)
    if (!normalizedFetched) continue
    let extracted: ReturnType<typeof extractHotelBlPage> | null = null
    if (fetched.html) extracted = extractHotelBlPage(fetched.html, normalizedFetched.url)
    const pageType = extracted?.pageType ?? classifyHotelBlPageType(normalizedFetched.url)
    const [page] = await db
      .insert(hotelBlDiscoveredPages)
      .values({
        domainId: domain.id,
        url: normalizedFetched.url,
        pageType,
        title: extracted?.title ?? null,
        statusCode: fetched.status,
        lastModifiedOrDetectedDate: fetched.lastModified ?? targets.get(requestedUrl) ?? null,
        externalLinkCount: extracted?.externalLinkCount ?? 0,
        externalPressLinkCount: extracted?.editorialLinks.length ?? 0,
        dofollowExternalPressLinkCount: extracted?.editorialLinks.filter((link) => link.followed).length ?? 0,
        lastContentDate: extracted?.latestContentDate ?? null,
        dateConfidence: extracted?.dateConfidence ?? null,
        rawHtml: fetched.html,
        contentHash: fetched.html ? hotelBlContentHash(fetched.html) : null,
        error: fetched.error,
        crawlTimestamp: new Date(),
      })
      .onConflictDoUpdate({
        target: [hotelBlDiscoveredPages.domainId, hotelBlDiscoveredPages.url],
        set: {
          pageType,
          title: extracted?.title ?? null,
          statusCode: fetched.status,
          lastModifiedOrDetectedDate: fetched.lastModified ?? targets.get(requestedUrl) ?? null,
          externalLinkCount: extracted?.externalLinkCount ?? 0,
          externalPressLinkCount: extracted?.editorialLinks.length ?? 0,
          dofollowExternalPressLinkCount: extracted?.editorialLinks.filter((link) => link.followed).length ?? 0,
          lastContentDate: extracted?.latestContentDate ?? null,
          dateConfidence: extracted?.dateConfidence ?? null,
          rawHtml: fetched.html,
          contentHash: fetched.html ? hotelBlContentHash(fetched.html) : null,
          error: fetched.error,
          crawlTimestamp: new Date(),
        },
      })
      .returning({ id: hotelBlDiscoveredPages.id })
    if (!page) throw new Error(`Could not store crawl evidence for ${requestedUrl}`)
    crawled += 1
    if (!extracted) continue

    for (const link of extracted.editorialLinks) {
      await db
        .insert(hotelBlEditorialLinks)
        .values({ pageId: page.id, ...link, editorial: true })
        .onConflictDoUpdate({
          target: [
            hotelBlEditorialLinks.pageId,
            hotelBlEditorialLinks.destinationUrlHash,
            hotelBlEditorialLinks.anchorTextHash,
          ],
          set: { rel: link.rel, nofollow: link.nofollow, sponsored: link.sponsored, ugc: link.ugc, followed: link.followed },
        })
    }
    for (const contact of extracted.contacts) {
      await db
        .insert(hotelBlContacts)
        .values({ domainId: domain.id, sourceUrl: extracted.url, ...contact })
        .onConflictDoNothing()
    }
    if (!domain.entityType || domain.entityType === 'property' || domain.entityType === 'brand') {
      for (const entity of extracted.alternateEntities) {
        await upsertAlternateEntity(db, { runId: job.runId, sourceDomainId: domain.id, entity, sourceUrl: extracted.url })
      }
    }
    for (const internalUrl of extracted.relevantInternalUrls) {
      if (
        depth < HOTEL_BL_CRAWL_CONFIG.maxDepth &&
        !visited.has(internalUrl) &&
        queue.length + crawled < HOTEL_BL_CRAWL_CONFIG.maxPagesPerDomain
      ) {
        queue.push({ url: internalUrl, depth: depth + 1 })
      }
    }
    if (!conventionalAdded && crawled === 1 && queue.length < 2 && !configuration.centralizedBrand) {
      conventionalAdded = true
      for (const path of conventionalHotelBlPaths(origin)) {
        if (!visited.has(path) && allows(path) && queue.length + crawled < HOTEL_BL_CRAWL_CONFIG.maxPagesPerDomain) {
          queue.push({ url: path, depth: 1 })
        }
      }
    }
  }

  const pages = await db
    .select({
      pageType: hotelBlDiscoveredPages.pageType,
      statusCode: hotelBlDiscoveredPages.statusCode,
      externalPressLinkCount: hotelBlDiscoveredPages.externalPressLinkCount,
      dofollowExternalPressLinkCount: hotelBlDiscoveredPages.dofollowExternalPressLinkCount,
      lastContentDate: hotelBlDiscoveredPages.lastContentDate,
      lastModified: hotelBlDiscoveredPages.lastModifiedOrDetectedDate,
      dateConfidence: hotelBlDiscoveredPages.dateConfidence,
      rawHtml: hotelBlDiscoveredPages.rawHtml,
    })
    .from(hotelBlDiscoveredPages)
    .where(eq(hotelBlDiscoveredPages.domainId, domain.id))
  const contacts = await db.select().from(hotelBlContacts).where(eq(hotelBlContacts.domainId, domain.id))
  const externalPressLinkCount = pages.reduce((sum, page) => sum + page.externalPressLinkCount, 0)
  const followed = pages.reduce((sum, page) => sum + page.dofollowExternalPressLinkCount, 0)
  const dated = pages
    .filter((page) => isHotelBlEditorialPageType(page.pageType))
    .map((page) => ({ date: page.lastContentDate ?? page.lastModified, confidence: page.dateConfidence ?? (page.lastModified ? 0.6 : null) }))
    .filter((row): row is { date: Date; confidence: number } => row.date !== null && row.confidence !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
  const latest = dated[0]
  const pressTypes = new Set(pages.filter((page) => page.statusCode && page.statusCode < 400).map((page) => page.pageType))
  await db
    .update(hotelBlDomains)
    .set({
      crawlStatus: pages.some((page) => page.statusCode && page.statusCode < 400) ? 'complete' : 'failed',
      lastCrawledAt: new Date(),
      crawlError: pages.some((page) => page.statusCode && page.statusCode < 400) ? null : 'No eligible page returned a successful HTML response.',
      hasPressPage: pressTypes.has('press') || pressTypes.has('media'),
      hasAwardsPage: pressTypes.has('awards') || pressTypes.has('accolades'),
      hasBlogOrNews: ['blog', 'news', 'journal', 'stories'].some((type) => pressTypes.has(type as never)),
      hasExternalPressLinks: externalPressLinkCount > 0,
      externalPressLinkCount,
      dofollowExternalPressLinkCount: followed,
      pressLinkRatio: externalPressLinkCount > 0 ? followed / externalPressLinkCount : null,
      latestPressDate: latest?.date ?? null,
      freshnessDays: latest ? Math.max(0, Math.floor((Date.now() - latest.date.getTime()) / 86_400_000)) : null,
      freshnessConfidence: latest?.confidence ?? null,
      hasNamedPrContact: contacts.some((contact) => contact.name && ['pr', 'media', 'marketing'].includes(contact.contactType)),
      hasPrEmail: contacts.some((contact) => contact.email && ['pr', 'media', 'marketing'].includes(contact.contactType)),
      hasPressKit: pages.some((page) => /press kit|media kit/i.test(page.rawHtml ?? '')),
      updatedAt: new Date(),
    })
    .where(eq(hotelBlDomains.id, domain.id))
  return crawled
}

async function finishJob(db: Database, job: ClaimedJob, result: { records?: number; error?: string }): Promise<void> {
  const failed = Boolean(result.error)
  await db
    .update(hotelBlJobs)
    .set({
      status: failed ? 'failed' : 'complete',
      recordsProcessed: result.records ?? 0,
      lastSuccessAt: failed ? null : new Date(),
      error: result.error ?? null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(hotelBlJobs.id, job.id))
  await db.insert(hotelBlRunEvents).values({
    runId: job.runId,
    jobId: job.id,
    domainId: job.domainId,
    stage: job.stage,
    level: failed ? 'error' : 'info',
    message: failed ? result.error! : `Completed ${job.stage}; stored ${result.records ?? 0} page records.`,
  })
}

export async function executeHotelBlRun(
  db: Database,
  runId: number,
  options: { concurrency?: number } = {},
): Promise<{ processed: number; failed: number; opportunities: number }> {
  await executeHotelBlUrlValidation(db, runId, { concurrency: Math.max(4, options.concurrency ?? 5) })
  await redriveStaleHotelBlJobs(db, runId)
  await db
    .update(hotelBlRuns)
    .set({ status: 'running', currentStage: 'crawl_homepage', startedAt: new Date(), error: null, updatedAt: new Date() })
    .where(eq(hotelBlRuns.id, runId))
  let processed = 0
  let failed = 0
  const limit = pLimit(Math.max(1, Math.min(10, options.concurrency ?? HOTEL_BL_CRAWL_CONFIG.concurrency)))
  const workers = Array.from({ length: options.concurrency ?? HOTEL_BL_CRAWL_CONFIG.concurrency }, () =>
    limit(async () => {
      while (true) {
        const job = await claimHotelBlJob(db, runId)
        if (!job) return
        try {
          const records = await crawlDomainJob(db, job)
          processed += 1
          await finishJob(db, job, { records })
        } catch (error) {
          failed += 1
          const message = error instanceof Error ? error.message : String(error)
          if (job.domainId) {
            await db
              .update(hotelBlDomains)
              .set({ crawlStatus: 'failed', crawlError: message, lastCrawledAt: new Date(), updatedAt: new Date() })
              .where(eq(hotelBlDomains.id, job.domainId))
          }
          await finishJob(db, job, { error: message })
        }
      }
    }),
  )
  await Promise.all(workers)
  const scored = await recalculateHotelBlOpportunities(db, runId)
  const [crawlTotals] = await db
    .select({
      processed: sql<number>`count(*) filter (where ${hotelBlJobs.status} = 'complete')::int`,
      failed: sql<number>`count(*) filter (where ${hotelBlJobs.status} = 'failed')::int`,
    })
    .from(hotelBlJobs)
    .where(
      and(
        eq(hotelBlJobs.runId, runId),
        inArray(hotelBlJobs.stage, ['crawl_homepage', 'crawl_alternate_entities']),
      ),
    )
  processed = crawlTotals?.processed ?? processed
  failed = crawlTotals?.failed ?? failed
  const [pendingSemrush] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hotelBlJobs)
    .where(and(eq(hotelBlJobs.runId, runId), eq(hotelBlJobs.stage, 'semrush_enrichment'), eq(hotelBlJobs.status, 'pending')))
  await db
    .update(hotelBlRuns)
    .set({
      status: (pendingSemrush?.count ?? 0) > 0 ? 'waiting_for_semrush' : 'complete',
      currentStage: (pendingSemrush?.count ?? 0) > 0 ? 'semrush_enrichment' : 'calculate_priorities',
      finishedAt: new Date(),
      progress: { processedDomains: processed, failedDomains: failed, opportunities: scored.opportunities, semrushJobsPending: pendingSemrush?.count ?? 0 },
      updatedAt: new Date(),
    })
    .where(eq(hotelBlRuns.id, runId))
  return { processed, failed, opportunities: scored.opportunities }
}

export async function retryFailedHotelBlJobs(db: Database, runId: number): Promise<number> {
  const rows = await db
    .update(hotelBlJobs)
    .set({ status: 'pending', error: null, claimedAt: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(hotelBlJobs.runId, runId), eq(hotelBlJobs.status, 'failed')))
    .returning({ id: hotelBlJobs.id })
  await db
    .update(hotelBlDomains)
    .set({ crawlStatus: 'pending', crawlError: null, updatedAt: new Date() })
    .where(
      inArray(
        hotelBlDomains.id,
        rows.length === 0
          ? [-1]
          : await db
              .select({ domainId: hotelBlJobs.domainId })
              .from(hotelBlJobs)
              .where(inArray(hotelBlJobs.id, rows.map((row) => row.id)))
              .then((items) => items.map((item) => item.domainId).filter((id): id is number => id !== null)),
      ),
    )
  return rows.length
}
