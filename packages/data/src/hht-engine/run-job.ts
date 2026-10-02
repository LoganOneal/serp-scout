import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { load as loadHtml } from 'cheerio'
import {
  SERP_BANDS,
  bandForDepth,
  cacheFresh,
  chooseContact,
  classifyByRules,
  decideFilter,
  editorialPage,
  extractContactForms,
  extractEmails,
  geographicKeywords,
  groundStructuredGuestPostGuidelines,
  guestPostGuidelineReviewReasons,
  guestPostIsPrimary,
  guestPostKey,
  GUEST_POST_PATHS,
  insertionKey,
  insertionLeadStatus,
  judgeGuestPostPages,
  lexicalRejectReason,
  matchHhtTarget,
  nextKeywordStatus,
  normalizeContactEmail,
  normalizeFrontierKeyword,
  notificationForGads,
  opportunityExternalId,
  parseOrganicSerp,
  parseRankedKeywords,
  parseSitemapUrls,
  phraseOrganicParams,
  pickFrontierKeyword,
  priorityScore,
  publisherExternalId,
  registrableDomain,
  renderTemplate,
  semrushReplacementNotice,
  siteTypeNeedsGuestPost,
  structuredGuidelinesFromAnswer,
  type GuestPostStatus,
  type HhtInventoryPage,
  type KeywordStatus,
  type LeadStatus,
  type SiteType,
} from '@rnr/core'
import { loadEngineConfig } from './config.js'
import type { EngineDatabase } from './db.js'
import { GadsError, generateIdeas, pingGoogleAds } from './gads-client.js'
import { sendGmailNotification } from './gmail.js'
import { googleAdsEnv, googleServiceAccountCredentials } from './provider-secrets.js'
import { cachedEmbedding, cosineSimilarity, maxCachedSimilarity } from './embeddings.js'
import { requireLlmAnswer } from './llm-tasks.js'
import {
  enqueueJob,
  loadCredential,
  recordSemrushUnits,
  saveCredential,
  setGadsState,
  setSemrushState,
} from './jobs.js'
import {
  hhtEngineContactDomains,
  hhtEngineContacts,
  hhtEngineCrmEvents,
  hhtEngineDomains,
  hhtEngineDrafts,
  hhtEngineGoogleAdsUsage,
  hhtEngineHhtPages,
  hhtEngineJobs,
  hhtEngineKeywords,
  hhtEngineNotifications,
  hhtEngineOpportunities,
  hhtEngineOpportunityPages,
  hhtEnginePageRankings,
  hhtEnginePublisherPages,
  hhtEnginePublisherResearch,
  hhtEngineResponses,
  hhtEngineSerpResults,
  hhtEngineSerpScans,
  hhtEngineSystemState,
} from './schema.js'
import { SemrushMcpClient, SemrushMcpError } from './semrush-mcp.js'
import type { SemrushConnectorCredential } from './credential.js'

const SEMRUSH_JOBS = new Set([
  'EXPAND_KEYWORDS_SEMRUSH',
  'FETCH_SERP_BAND',
  'FETCH_DOMAIN_METRICS',
  'REVERIFY_RANKING',
])

const SITE_TYPES = new Set<string>([
  'editorial_blog', 'news_media', 'travel_guide', 'hotel_property', 'hotel_chain',
  'ota_booking', 'competitor_directory', 'forum_social_ugc', 'marketplace', 'search_engine', 'hht', 'unknown',
])

const OPEN_LEAD_STATUSES = ['DISCOVERED', 'QUALIFIED', 'CONTACT_ENRICHED', 'DRAFT_READY', 'HELD', 'READY_FOR_OUTREACH']

export async function runEngineJob(db: EngineDatabase, job: { id: number; type: string; payload: Record<string, unknown> }): Promise<void> {
  const state = await currentState(db)
  if (SEMRUSH_JOBS.has(job.type) && (state.semrush === 'EXHAUSTED' || state.semrush === 'AUTH_FAILURE')) {
    throw new SemrushMcpError(`Semrush is ${state.semrush}`, state.semrush === 'AUTH_FAILURE' ? 'auth' : 'exhausted')
  }
  if ((job.type === 'GADS_GENERATE_IDEAS' || job.type === 'GADS_FETCH_METRICS') && state.gads === 'GADS_AUTH_FAILURE') {
    throw new GadsError('Google Ads authorization failed', 'auth')
  }
  switch (job.type) {
    case 'SYNC_HHT_PAGES':
      return syncPages(db)
    case 'GADS_GENERATE_IDEAS':
    case 'GADS_FETCH_METRICS':
      return gadsIdeas(db, job.payload)
    case 'EXPAND_KEYWORDS_SEMRUSH':
      return expandSemrush(db, job)
    case 'GATE_KEYWORDS':
      return gateKeyword(db, job)
    case 'FETCH_SERP_BAND':
      return fetchSerp(db, job)
    case 'PROCESS_SERP_RESULTS':
      return processSerp(db, job.payload)
    case 'CLASSIFY_DOMAIN':
      return classifyDomain(db, job)
    case 'FETCH_DOMAIN_METRICS':
      return fetchAuthority(db, job)
    case 'CHECK_GUEST_POST_POLICY':
      return guestPost(db, job)
    case 'RUN_FILTERS':
      return runFilters(db, job)
    case 'QUALIFY_INSERTION':
      return qualifyInsertion(db, job)
    case 'REVERIFY_RANKING':
      return reverify(db, job)
    case 'MATCH_HHT_TARGET':
      return matchTarget(db, job)
    case 'FIND_CONTACT':
    case 'VALIDATE_CONTACT':
      return findContact(db, job.payload)
    case 'RENDER_DRAFT':
      return renderDraft(db, job)
    case 'SYNC_CRM':
      return syncCrm(db, job.payload)
    case 'PULL_CRM_STATUS':
      return pullCrm(db)
    case 'CHECK_SEMRUSH_HEALTH':
      return semrushHealth(db)
    case 'CHECK_GADS_HEALTH':
      return gadsHealth(db)
    case 'SEND_NOTIFICATION':
      return sendNotification(db, String(job.payload['message'] ?? ''), {
        subject: String(job.payload['subject'] ?? 'HHT backlink engine notification'),
        eventType: String(job.payload['eventType'] ?? 'generic'),
        attempt: Number(job.payload['attempt'] ?? 0),
      })
    case 'SEED_FRONTIER':
      return seedFrontier(db)
    default:
      throw new Error(`Unhandled job type ${job.type}`)
  }
}

async function syncPages(db: EngineDatabase): Promise<void> {
  const res = await fetch('https://www.hotelhottubs.com/sitemap.xml')
  if (!res.ok) throw new Error(`HHT sitemap HTTP ${res.status}`)
  const pages = parseSitemapUrls(await res.text())
  const config = loadEngineConfig()
  const existingPages = new Map(
    (await db.select().from(hhtEngineHhtPages)).map((page) => [page.url, page]),
  )
  for (const page of pages) {
    const stays = existingPages.get(page.url)?.verifiedStayCount ?? 0
    await db.insert(hhtEngineHhtPages).values({
      url: page.url,
      pageType: page.pageType,
      city: page.city,
      state: page.state,
      collection: page.collection,
      verifiedStayCount: stays,
      title: page.city ?? page.state ?? page.collection,
      lastSyncedAt: new Date(),
    }).onConflictDoUpdate({
      target: hhtEngineHhtPages.url,
      set: {
        pageType: page.pageType,
        city: page.city,
        state: page.state,
        collection: page.collection,
        verifiedStayCount: stays,
        lastSyncedAt: new Date(),
      },
    })
    if (page.pageType === 'city' && page.city && page.state) {
      for (const keyword of geographicKeywords(page.city, page.state, config.geoTemplates)) {
        await insertKeyword(db, { keyword, sourceType: 'geographic_expansion', city: page.city, state: page.state, depth: 0 })
      }
    }
  }
}

async function gadsIdeas(db: EngineDatabase, payload: Record<string, unknown>): Promise<void> {
  const config = loadEngineConfig()
  const seedType = payload['seedType'] === 'url' || payload['seedType'] === 'site' ? payload['seedType'] : 'keyword'
  const seed = String(payload['seed'] ?? '')
  if (!seed) return
  const depth = Number(payload['depth'] ?? 1)
  const sourceKeywordId = payload['sourceKeywordId'] == null ? null : Number(payload['sourceKeywordId'])
  const ideas = await generateIdeas({
    seedType,
    seed,
    geoTargetId: config.googleAdsGeoTargetId,
    languageId: config.googleAdsLanguageId,
    env: await googleAdsEnv(db),
  })
  await db.insert(hhtEngineGoogleAdsUsage).values({
    operation: `GenerateKeywordIdeas:${seedType}`,
  })
  const sourceType = seedType === 'keyword' ? 'google_keyword_idea' : seedType === 'url' ? 'google_url_seed' : 'google_site_seed'
  for (const idea of ideas) {
    await insertKeyword(db, {
      keyword: idea.keyword,
      sourceType,
      sourceKeywordId,
      depth,
      metrics: idea,
    })
  }
}

async function expandSemrush(db: EngineDatabase, job: { id: number; payload: Record<string, unknown> }): Promise<void> {
  const domain = String(job.payload['domain'] ?? '')
  if (!domain) return
  const source = job.payload['source'] === 'competitor_keyword' ? 'competitor_keyword' : 'publisher_keyword'
  const client = await semrush(db)
  const result = await client.executeReport('domain_organic', { domain, database: 'us', display_limit: 20 })
  await recordSemrushUnits(db, 'domain_organic', result.units, job.id)
  const depth = source === 'publisher_keyword' ? 0 : 1
  for (const keyword of parseRankedKeywords(result.data)) {
    await insertKeyword(db, { keyword, sourceType: source, sourceDomain: domain, depth })
  }
}

async function gateKeyword(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
): Promise<void> {
  const config = loadEngineConfig()
  const id = Number(job.payload['keywordId'])
  const [keyword] = await db.select().from(hhtEngineKeywords).where(eq(hhtEngineKeywords.id, id))
  if (!keyword || keyword.status === 'REJECTED_IRRELEVANT') return
  const pages = await db.select().from(hhtEngineHhtPages)
  const blocked = lexicalRejectReason(keyword.keyword, config.blockLists)
  const volumeKnown = keyword.avgMonthlySearches !== null || keyword.volumeHigh !== null
  const volumeHigh = keyword.volumeIsRange ? keyword.volumeHigh : keyword.avgMonthlySearches
  if (blocked || (volumeKnown && (volumeHigh ?? 0) <= 0)) {
    await db.update(hhtEngineKeywords).set({ status: 'REJECTED_IRRELEVANT', relevanceMethod: 'deterministic' }).where(eq(hhtEngineKeywords.id, id))
    return
  }
  const vector = await cachedEmbedding(db, 'keyword', String(keyword.id), keyword.keyword)
  const nearSimilarity = await maxCachedSimilarity(db, 'keyword', String(keyword.id), vector)
  if (nearSimilarity >= config.nearDuplicateSimilarity) {
    await db.update(hhtEngineKeywords).set({ status: 'REJECTED_IRRELEVANT', relevanceMethod: 'deterministic' }).where(eq(hhtEngineKeywords.id, id))
    return
  }
  const referenceVectors: number[][] = []
  for (const seed of config.seeds) {
    referenceVectors.push(await cachedEmbedding(db, 'seed', normalizeFrontierKeyword(seed), seed))
  }
  for (const page of pages) {
    const text = page.title ?? page.url
    referenceVectors.push(await cachedEmbedding(db, 'hht_page', String(page.id), text))
  }
  const similarity = referenceVectors.reduce(
    (best, reference) => Math.max(best, cosineSimilarity(vector, reference)),
    0,
  )
  let status: KeywordStatus
  let method: 'deterministic' | 'llm' = 'deterministic'
  if (similarity >= config.engine.llmRelevanceHigh) {
    status = 'QUEUED'
  } else if (similarity < config.engine.llmRelevanceLow) {
    status = 'REJECTED_IRRELEVANT'
  } else {
    method = 'llm'
    const answer = await requireLlmAnswer({
      db,
      job,
      taskType: 'keyword_relevance',
      entityType: 'keyword',
      entityId: String(keyword.id),
      taskInput: {
        keyword: keyword.keyword,
        question: 'Would a page ranking for this query plausibly mention hotels, hot tubs, jacuzzi rooms, romantic or couples stays, or lodging in a destination?',
      },
    })
    status = answer['decision'] === 'accept' ? 'QUEUED' : 'REJECTED_IRRELEVANT'
  }
  const cityPage = pages.find((page) => page.pageType === 'city' && page.city && keyword.keyword.toLowerCase().includes(page.city.toLowerCase()))
  const score = priorityScore({
    clusterYield: 0,
    relevanceScore: similarity,
    verifiedStayCount: cityPage?.verifiedStayCount ?? 0,
    sourceYield: 0,
    novel: keyword.maxSerpPositionScanned === 0,
    estimatedUnits: 200,
    avgMonthlySearches: keyword.avgMonthlySearches,
    volumeLow: keyword.volumeLow,
    volumeHigh: keyword.volumeHigh,
    volumeIsRange: keyword.volumeIsRange,
    explore: keyword.sourceType === 'publisher_keyword',
  }, config.engine)
  const depth = keyword.sourceType === 'publisher_keyword' && similarity < config.engine.llmRelevanceHigh
    ? config.expansionDepthCap
    : keyword.expansionDepth
  await db.update(hhtEngineKeywords).set({
    status,
    relevanceScore: similarity,
    relevanceMethod: method,
    priorityScore: cityPage ? score : score * 0.5,
    normalizedKeyword: normalizeFrontierKeyword(keyword.keyword),
    expansionDepth: depth,
  }).where(eq(hhtEngineKeywords.id, id))
  if (status === 'QUEUED') {
    await enqueueJob(db, { type: 'FETCH_SERP_BAND', idempotencyKey: `serp:${id}:1`, payload: { keywordId: id } })
  }
}

async function fetchSerp(db: EngineDatabase, job: { id: number; payload: Record<string, unknown> }): Promise<void> {
  const config = loadEngineConfig()
  const keywordId = Number(job.payload['keywordId'])
  const [keyword] = await db.select().from(hhtEngineKeywords).where(eq(hhtEngineKeywords.id, keywordId))
  if (!keyword) return
  const rescan = job.payload['rescan'] === true
  const band = rescan ? SERP_BANDS[0] : bandForDepth(keyword.maxSerpPositionScanned)
  if (!band || band.positionEnd > config.engine.maxSerpDepth) return
  const client = await semrush(db)
  const result = await client.executeReport('phrase_organic', phraseOrganicParams(keyword.keyword, band))
  await recordSemrushUnits(db, 'phrase_organic', result.units, job.id)
  const [scan] = await db.insert(hhtEngineSerpScans).values({
    keywordId,
    band: band.band,
    displayOffset: band.displayOffset,
    displayLimit: band.displayLimit,
    unitsSpent: result.units,
  }).returning()
  if (!scan) return
  const rows = parseOrganicSerp(result.data, band.displayOffset)
  const seen = new Set<string>()
  for (const row of rows) {
    const root = registrableDomain(row.domain)?.domain ?? row.domain
    seen.add(root)
    await db.insert(hhtEngineSerpResults).values({
      keywordId,
      scanId: scan.id,
      url: row.url,
      canonicalUrl: row.url,
      rootDomain: root,
      position: row.position,
      band: band.band,
    })
  }
  const freshDomains = [...seen].filter((domain) => {
    const ruled = classifyByRules(domain, config.siteRules)
    return ruled === null || siteTypeNeedsGuestPost(ruled)
  })
  const units = result.units || rows.length * 10 || 1
  const next = rescan ? null : nextKeywordStatus({
    status: asKeywordStatus(keyword.status),
    consecutiveLowYieldBands: keyword.consecutiveLowYieldBands,
    band: { newQualifiedDomains: freshDomains.length, reachedMaxDepth: band.positionEnd >= config.engine.maxSerpDepth },
    lowYieldThreshold: config.engine.lowYieldDomainThreshold,
  })
  await db.update(hhtEngineSerpScans).set({ newQualifiedDomains: freshDomains.length }).where(eq(hhtEngineSerpScans.id, scan.id))
  await db.update(hhtEngineKeywords).set({
    status: next?.status ?? keyword.status,
    consecutiveLowYieldBands: next?.consecutiveLowYieldBands ?? keyword.consecutiveLowYieldBands,
    maxSerpPositionScanned: Math.max(keyword.maxSerpPositionScanned, band.positionEnd),
    uniqueDomainsSeen: keyword.uniqueDomainsSeen + seen.size,
    newDomainsDiscovered: freshDomains.length,
    marginalDomainYield: freshDomains.length / units,
    lastSerpScanAt: new Date(),
  }).where(eq(hhtEngineKeywords.id, keywordId))
  await enqueueJob(db, {
    type: 'PROCESS_SERP_RESULTS',
    idempotencyKey: `process:${scan.id}`,
    payload: { scanId: scan.id, keywordId, keyword: keyword.keyword },
  })
  if (!rescan && freshDomains.length >= config.engine.lowYieldDomainThreshold && keyword.expansionDepth < config.expansionDepthCap) {
    await enqueueJob(db, {
      type: 'GADS_GENERATE_IDEAS',
      idempotencyKey: `ideas:keyword:${keywordId}`,
      payload: { seedType: 'keyword', seed: keyword.keyword, depth: keyword.expansionDepth + 1, sourceKeywordId: keywordId },
    })
  }
}

async function processSerp(db: EngineDatabase, payload: Record<string, unknown>): Promise<void> {
  const scanId = Number(payload['scanId'])
  const keyword = String(payload['keyword'] ?? '')
  const rows = await db.select().from(hhtEngineSerpResults).where(eq(hhtEngineSerpResults.scanId, scanId))
  for (const row of rows) {
    await db.insert(hhtEngineDomains).values({ rootDomain: row.rootDomain }).onConflictDoUpdate({
      target: hhtEngineDomains.rootDomain,
      set: { lastSeenAt: new Date() },
    })
    await enqueueJob(db, {
      type: 'CLASSIFY_DOMAIN',
      idempotencyKey: `classify:${row.rootDomain}:${dayBucket(180)}`,
      payload: { rootDomain: row.rootDomain, sampleUrl: row.url },
    })
    await db.insert(hhtEnginePublisherPages).values({
      canonicalUrl: row.canonicalUrl,
      rootDomain: row.rootDomain,
    }).onConflictDoNothing()
    const [page] = await db.select().from(hhtEnginePublisherPages).where(eq(hhtEnginePublisherPages.canonicalUrl, row.canonicalUrl))
    if (!page) continue
    await db.insert(hhtEnginePageRankings).values({
      pageId: page.id,
      keywordId: row.keywordId,
      keyword,
      position: row.position,
    })
    if (row.position <= 10 && row.band === 1) {
      await enqueueJob(db, {
        type: 'QUALIFY_INSERTION',
        idempotencyKey: `insert:${page.id}:${row.keywordId}`,
        payload: { pageId: page.id, keywordId: row.keywordId, position: row.position, keyword },
      })
    }
  }
}

async function classifyDomain(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
): Promise<void> {
  const config = loadEngineConfig()
  const rootDomain = String(job.payload['rootDomain'] ?? '')
  const ruled = classifyByRules(rootDomain, config.siteRules)
  let siteType: SiteType = ruled ?? 'unknown'
  if (!ruled) {
    const sample = String(job.payload['sampleUrl'] ?? `https://${rootDomain}`)
    const html = await fetchText(sample)
    const answer = await requireLlmAnswer({
      db,
      job,
      taskType: 'site_type',
      entityType: 'domain',
      entityId: rootDomain,
      taskInput: { root_domain: rootDomain, sample_url: sample, html_excerpt: html.slice(0, 4_000) },
    })
    siteType = asSiteType(String(answer['site_type'] ?? 'unknown'))
  }
  await db.update(hhtEngineDomains).set({ siteType, lastSeenAt: new Date() }).where(eq(hhtEngineDomains.rootDomain, rootDomain))
  if (!siteTypeNeedsGuestPost(siteType) && siteType !== 'unknown') {
    await db.update(hhtEngineOpportunities).set({
      filterStatus: 'EXCLUDED',
      filterReasons: [siteType],
      status: 'REJECTED',
    }).where(and(
      eq(hhtEngineOpportunities.rootDomain, rootDomain),
      inArray(hhtEngineOpportunities.status, OPEN_LEAD_STATUSES),
    ))
    return
  }
  if (siteTypeNeedsGuestPost(siteType)) {
    await enqueueJob(db, { type: 'CHECK_GUEST_POST_POLICY', idempotencyKey: `guest:${rootDomain}:${dayBucket(60)}`, payload: { rootDomain } })
    await enqueueJob(db, { type: 'FETCH_DOMAIN_METRICS', idempotencyKey: `authority:${rootDomain}:${dayBucket(60)}`, payload: { rootDomain } })
  }
}

async function fetchAuthority(db: EngineDatabase, job: { id: number; payload: Record<string, unknown> }): Promise<void> {
  const rootDomain = String(job.payload['rootDomain'] ?? '')
  const client = await semrush(db)
  const result = await client.executeReport('backlinks_overview', { target: rootDomain, target_type: 'root_domain' })
  await recordSemrushUnits(db, 'backlinks_overview', result.units, job.id)
  const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
  const score = Number(text.match(/ascore[^\d]*(\d+)/i)?.[1])
  if (Number.isFinite(score)) {
    await db.update(hhtEngineDomains).set({ semrushAuthorityScore: score }).where(eq(hhtEngineDomains.rootDomain, rootDomain))
  }
}

async function guestPost(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
): Promise<void> {
  const rootDomain = String(job.payload['rootDomain'] ?? '')
  const [prior] = await db.select().from(hhtEnginePublisherResearch).where(eq(hhtEnginePublisherResearch.rootDomain, rootDomain))
  if (prior && cacheFresh(prior.checkedAt, new Date(), 60)) return
  const pages = []
  for (const path of GUEST_POST_PATHS) {
    const url = `https://${rootDomain}${path}`
    const text = await fetchText(url)
    pages.push({ url, text, ok: text.length > 0 })
  }
  let judged = judgeGuestPostPages(pages)
  let guidelines = structuredGuidelinesFromAnswer({})
  if (pages.some((page) => page.ok)) {
    const answer = await requireLlmAnswer({
      db,
      job,
      taskType: 'guest_post_policy',
      entityType: 'domain',
      entityId: rootDomain,
      taskInput: {
        root_domain: rootDomain,
        pages: pages.map((page) => guidelinePageContent(page.url, page.text)),
        instruction: [
          'Determine guest-post acceptance and extract every structured guideline field.',
          'Use null, false, or [] when a field is not stated.',
          'submission_url must be the actual mailto, form, Google Form, or other submission destination; do not use the evidence page unless it is itself the destination.',
          'Every non-empty guideline field must cite one of the supplied page URLs in evidence.',
          'Set ai_content_prohibited only when AI-assisted content is explicitly prohibited.',
          'Set paid_or_sponsored only when payment or sponsorship is required, not merely offered.',
        ].join(' '),
      },
    })
    judged = {
      ...judged,
      status: String(answer['status']) as GuestPostStatus,
      evidenceUrl: answer['evidence_url'] === null ? null : String(answer['evidence_url'] ?? ''),
      requirements: answer['requirements'] === null ? null : String(answer['requirements'] ?? ''),
      inconclusive: false,
    }
    guidelines = groundStructuredGuestPostGuidelines(
      structuredGuidelinesFromAnswer(answer),
      pages.filter((page) => page.ok).map((page) => page.url),
    )
  }
  const sellsPlacements = judged.sellsPlacements || guidelines.paidOrSponsored
  await db.insert(hhtEnginePublisherResearch).values({
    rootDomain,
    guestPostStatus: judged.status,
    evidenceUrl: judged.evidenceUrl,
    requirements: judged.requirements,
    sellsPlacements,
    checkedAt: new Date(),
  }).onConflictDoUpdate({
    target: hhtEnginePublisherResearch.rootDomain,
    set: {
      guestPostStatus: judged.status,
      evidenceUrl: judged.evidenceUrl,
      requirements: judged.requirements,
      sellsPlacements,
      checkedAt: new Date(),
    },
  })
  await db.update(hhtEngineDomains).set({
    guestPostStatus: judged.status,
    guestPostEvidenceUrl: judged.evidenceUrl,
    guestPostRequirements: judged.requirements,
    submissionMethod: guidelines.submissionMethod,
    submissionUrl: guidelines.submissionUrl,
    pitchTopicCount: guidelines.pitchTopicCount,
    pitchContentStage: guidelines.pitchContentStage,
    requiredSubjectLineFormat: guidelines.requiredSubjectLineFormat,
    acceptedTopics: guidelines.acceptedTopics,
    excludedTopics: guidelines.excludedTopics,
    wordCount: guidelines.wordCount,
    linkPolicy: guidelines.linkPolicy,
    samplesRequired: guidelines.samplesRequired,
    bioRequired: guidelines.bioRequired,
    aiContentPolicy: guidelines.aiContentPolicy,
    aiContentProhibited: guidelines.aiContentProhibited,
    paidOrSponsored: guidelines.paidOrSponsored,
    guidelineEvidence: guidelines.evidence,
    sellsPlacements,
  }).where(eq(hhtEngineDomains.rootDomain, rootDomain))
  if (!guestPostIsPrimary(judged.status)) return
  const key = guestPostKey(rootDomain)
  await db.insert(hhtEngineOpportunities).values({
    canonicalKey: key,
    externalId: opportunityExternalId(key),
    rootDomain,
    type: 'guest_post',
    status: 'QUALIFIED',
    primaryThread: true,
    publisherExternalId: publisherExternalId(rootDomain),
  }).onConflictDoNothing()
  const [saved] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!saved) return
  const reviewReasons = guestPostGuidelineReviewReasons(guidelines)
  if (reviewReasons.length) {
    await db.update(hhtEngineOpportunities).set({
      filterStatus: 'REVIEW',
      filterReasons: reviewReasons,
    }).where(eq(hhtEngineOpportunities.id, saved.id))
    return
  }
  await enqueueJob(db, { type: 'RUN_FILTERS', idempotencyKey: `filter:${key}`, payload: { canonicalKey: key } })
  await enqueueJob(db, { type: 'MATCH_HHT_TARGET', idempotencyKey: `match:${key}`, payload: { canonicalKey: key } })
}

async function runFilters(db: EngineDatabase, job: { id: number; payload: Record<string, unknown> }): Promise<void> {
  const config = loadEngineConfig()
  const key = String(job.payload['canonicalKey'] ?? '')
  const [opportunity] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!opportunity) return
  const [domain] = await db.select().from(hhtEngineDomains).where(eq(hhtEngineDomains.rootDomain, opportunity.rootDomain))
  const siteType = asSiteType(domain?.siteType)
  let linksToHht = false
  let editorial = true
  if (opportunity.type === 'link_insertion') {
    const url = insertionUrl(opportunity.canonicalKey)
    const [page] = await db.select().from(hhtEnginePublisherPages).where(eq(hhtEnginePublisherPages.canonicalUrl, url))
    editorial = editorialPage(page?.pageType ?? null)
    const html = await fetchText(url)
    linksToHht = /hotelhottubs\.com/i.test(html)
    if (page) {
      await db.update(hhtEnginePublisherPages).set({ linksToHht, linksToHhtCheckedAt: new Date() }).where(eq(hhtEnginePublisherPages.id, page.id))
    }
  } else {
    const client = await semrush(db)
    const result = await client.executeReport('backlinks', {
      target: opportunity.rootDomain,
      target_type: 'root_domain',
      display_limit: 20,
    })
    await recordSemrushUnits(db, 'backlinks', result.units, job.id)
    linksToHht = /hotelhottubs\.com/i.test(result.raw)
  }
  const contactRows = await db.select().from(hhtEngineContactDomains).where(eq(hhtEngineContactDomains.rootDomain, opportunity.rootDomain))
  let blocked = domain?.blocked ?? false
  let contactedWithinCooldown = false
  for (const link of contactRows) {
    const [contact] = await db.select().from(hhtEngineContacts).where(eq(hhtEngineContacts.id, link.contactId))
    if (!contact) continue
    if (contact.blocked) blocked = true
    if (cacheFresh(contact.lastContactedAt, new Date(), config.engine.contactCooldownDays)) contactedWithinCooldown = true
  }
  const decision = decideFilter({
    rootDomain: opportunity.rootDomain,
    siteType,
    onCompetitorList: config.competitors.includes(opportunity.rootDomain),
    editorial,
    linksToHht,
    blocked,
    contactedWithinCooldown,
    declinedWithinCooldown: false,
    sellsPlacements: domain?.sellsPlacements ?? false,
    highOutboundLinks: false,
    highSponsoredShare: false,
    unrelatedTopicSpread: false,
    trafficDownHard: false,
    parasitePage: false,
    hasContact: true,
    contextualFit: null,
  })
  const status = decision.status === 'EXCLUDED' ? 'REJECTED' : opportunity.status
  await db.update(hhtEngineOpportunities).set({
    filterStatus: decision.status,
    filterReasons: decision.reasons,
    status,
  }).where(eq(hhtEngineOpportunities.id, opportunity.id))
  if (decision.status === 'EXCLUDED') return
  await enqueueJob(db, { type: 'FIND_CONTACT', idempotencyKey: `contact:${key}`, payload: { canonicalKey: key } })
  await enqueueJob(db, {
    type: 'EXPAND_KEYWORDS_SEMRUSH',
    idempotencyKey: `expand:publisher:${opportunity.rootDomain}`,
    payload: { domain: opportunity.rootDomain, source: 'publisher_keyword' },
  })
  if (opportunity.type === 'link_insertion') {
    await enqueueJob(db, {
      type: 'GADS_GENERATE_IDEAS',
      idempotencyKey: `ideas:url:${insertionUrl(opportunity.canonicalKey)}`,
      payload: { seedType: 'url', seed: insertionUrl(opportunity.canonicalKey), depth: 1 },
    })
  }
}

async function qualifyInsertion(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
): Promise<void> {
  const pageId = Number(job.payload['pageId'])
  const position = Number(job.payload['position'])
  const keyword = String(job.payload['keyword'] ?? '')
  const [page] = await db.select().from(hhtEnginePublisherPages).where(eq(hhtEnginePublisherPages.id, pageId))
  if (!page || position > 10 || !editorialPage(page.pageType)) return
  const [domain] = await db.select().from(hhtEngineDomains).where(eq(hhtEngineDomains.rootDomain, page.rootDomain))
  const siteType = asSiteType(domain?.siteType)
  if (siteType !== 'unknown' && !siteTypeNeedsGuestPost(siteType)) return
  const guestStatus = asGuestPost(domain?.guestPostStatus ?? null)
  const key = insertionKey(page.rootDomain, page.canonicalUrl)
  const status = insertionLeadStatus(guestStatus)
  await db.insert(hhtEngineOpportunities).values({
    canonicalKey: key,
    externalId: opportunityExternalId(key),
    rootDomain: page.rootDomain,
    type: 'link_insertion',
    status,
    bestKeyword: keyword,
    bestPosition: position,
    sourceKeyword: keyword,
    publisherExternalId: publisherExternalId(page.rootDomain),
    primaryThread: !guestPostIsPrimary(guestStatus),
  }).onConflictDoNothing()
  const [saved] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!saved) return
  const contextual = await requireLlmAnswer({
    db,
    job,
    taskType: 'contextual_fit',
    entityType: 'opportunity',
    entityId: String(saved.id),
    taskInput: {
      source_url: page.canonicalUrl,
      article_title: page.title,
      ranking_keyword: keyword,
      target_topic: 'HotelHotTubs.com destination and hotel-with-hot-tub pages',
    },
  })
  if (contextual['fits'] !== true) {
    await db.update(hhtEngineOpportunities).set({
      status: 'REJECTED',
      filterStatus: 'EXCLUDED',
      filterReasons: ['contextual_fit'],
    }).where(eq(hhtEngineOpportunities.id, saved.id))
    return
  }
  const suggestion = await requireLlmAnswer({
    db,
    job,
    taskType: 'insertion_suggestion',
    entityType: 'opportunity',
    entityId: String(saved.id),
    taskInput: {
      source_url: page.canonicalUrl,
      article_title: page.title,
      ranking_keyword: keyword,
      instruction: 'Write one line naming the section where an HHT link fits.',
    },
  })
  await db.update(hhtEngineOpportunities).set({
    insertionSuggestion: String(suggestion['suggestion']),
  }).where(eq(hhtEngineOpportunities.id, saved.id))
  await db.insert(hhtEngineOpportunityPages).values({
    opportunityId: saved.id,
    canonicalUrl: page.canonicalUrl,
    title: page.title,
    bestPosition: position,
    keyword,
  }).onConflictDoNothing()
  await enqueueJob(db, { type: 'MATCH_HHT_TARGET', idempotencyKey: `match:${key}`, payload: { canonicalKey: key } })
  await enqueueJob(db, { type: 'RUN_FILTERS', idempotencyKey: `filter:${key}`, payload: { canonicalKey: key } })
}

async function reverify(db: EngineDatabase, job: { id: number; payload: Record<string, unknown> }): Promise<void> {
  const config = loadEngineConfig()
  const key = String(job.payload['canonicalKey'] ?? '')
  const [opportunity] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!opportunity || opportunity.type !== 'link_insertion' || opportunity.status === 'HELD') return
  const url = insertionUrl(key)
  const [page] = await db.select().from(hhtEnginePublisherPages).where(eq(hhtEnginePublisherPages.canonicalUrl, url))
  const rankings = page
    ? await db.select().from(hhtEnginePageRankings).where(eq(hhtEnginePageRankings.pageId, page.id))
    : []
  const recent = rankings.some((row) => row.position <= 10 && cacheFresh(row.observedAt, new Date(), config.engine.rankingReverifyDays))
  if (recent) {
    await db.update(hhtEngineOpportunities).set({ status: 'READY_FOR_OUTREACH' }).where(eq(hhtEngineOpportunities.id, opportunity.id))
    await enqueueJob(db, { type: 'SYNC_CRM', idempotencyKey: `crm:${key}:ready`, payload: { canonicalKey: key } })
    return
  }
  const phrase = opportunity.bestKeyword
  if (!phrase) {
    await db.update(hhtEngineOpportunities).set({ status: 'DEMOTED' }).where(eq(hhtEngineOpportunities.id, opportunity.id))
    return
  }
  const client = await semrush(db)
  const band = SERP_BANDS[0]
  if (!band) return
  const result = await client.executeReport('phrase_organic', phraseOrganicParams(phrase, { ...band, displayLimit: 10, positionEnd: 10 }))
  await recordSemrushUnits(db, 'phrase_organic', result.units, job.id)
  const still = parseOrganicSerp(result.data).some((row) => row.url === url && row.position <= 10)
  await db.update(hhtEngineOpportunities).set({ status: still ? 'READY_FOR_OUTREACH' : 'DEMOTED' }).where(eq(hhtEngineOpportunities.id, opportunity.id))
  await enqueueJob(db, { type: 'SYNC_CRM', idempotencyKey: `crm:${key}:${still ? 'ready' : 'demoted'}`, payload: { canonicalKey: key } })
}

async function matchTarget(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
): Promise<void> {
  const key = String(job.payload['canonicalKey'] ?? '')
  const [opportunity] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!opportunity) return
  const pages = await inventory(db)
  const sourceText = `${opportunity.bestKeyword ?? ''} ${opportunity.sourceKeyword ?? ''} ${opportunity.rootDomain}`
  let match = matchHhtTarget(sourceText, pages)
  if (match.matchConfidence < 0.7) {
    const answer = await requireLlmAnswer({
      db,
      job,
      taskType: 'target_page_match',
      entityType: 'opportunity',
      entityId: String(opportunity.id),
      taskInput: {
        source_text: sourceText,
        candidates: pages.map((page) => ({
          url: page.url,
          page_type: page.pageType,
          city: page.city,
          state: page.state,
          collection: page.collection,
        })),
      },
    })
    const target = String(answer['target_hht_url'] ?? '')
    if (pages.some((page) => page.url === target)) {
      match = {
        ...match,
        targetHhtUrl: target,
        secondaryHhtUrl: answer['secondary_hht_url'] === null ? null : String(answer['secondary_hht_url'] ?? ''),
        matchConfidence: 0.65,
        weakTargetMatch: false,
      }
    }
  }
  await db.update(hhtEngineOpportunities).set({
    targetHhtUrl: match.targetHhtUrl,
    secondaryHhtUrl: match.secondaryHhtUrl,
    matchRule: match.matchRule,
    matchConfidence: match.matchConfidence,
    weakTargetMatch: match.weakTargetMatch,
    noHhtCityPage: match.noHhtCityPage,
  }).where(eq(hhtEngineOpportunities.id, opportunity.id))
}

async function findContact(db: EngineDatabase, payload: Record<string, unknown>): Promise<void> {
  const key = String(payload['canonicalKey'] ?? '')
  const [opportunity] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!opportunity || opportunity.filterStatus === 'EXCLUDED') return
  const [domain] = await db.select().from(hhtEngineDomains).where(eq(hhtEngineDomains.rootDomain, opportunity.rootDomain))
  const baseUrl = `https://${opportunity.rootDomain}`
  const html = await fetchText(opportunity.type === 'link_insertion' ? insertionUrl(key) : baseUrl)
  const source = opportunity.type === 'guest_post' ? 'guidelines' : 'general'
  const emails = extractEmails(html).map((email) => ({ name: null, role: null, email, formUrl: null, source }))
  const forms = extractContactForms(html, baseUrl).map((formUrl) => ({
    name: null, role: null, email: null, formUrl, source: 'form',
  }))
  const overrideCandidates = opportunity.type === 'guest_post' && domain?.submissionMethod
    ? await guidelineSubmissionCandidates(domain, baseUrl)
    : null
  const chosen = chooseContact(
    opportunity.type === 'guest_post' ? 'guest_post' : 'link_insertion',
    overrideCandidates ?? [...emails, ...forms],
  )
  if (!chosen) {
    await db.update(hhtEngineOpportunities).set({
      filterStatus: 'EXCLUDED',
      status: 'REJECTED',
      filterReasons: ['no_contact'],
    }).where(eq(hhtEngineOpportunities.id, opportunity.id))
    return
  }
  const emailNormalized = chosen.email ? normalizeContactEmail(chosen.email) : null
  const [existing] = emailNormalized
    ? await db.select().from(hhtEngineContacts).where(eq(hhtEngineContacts.emailNormalized, emailNormalized))
    : chosen.formUrl
      ? await db.select().from(hhtEngineContacts).where(eq(hhtEngineContacts.formUrl, chosen.formUrl))
      : []
  if (existing?.blocked || existing?.validationStatus === 'BOUNCED' || existing?.validationStatus === 'INVALID') {
    await db.update(hhtEngineOpportunities).set({
      filterStatus: 'EXCLUDED',
      status: 'BLOCKED',
      filterReasons: ['contact_suppressed'],
    }).where(eq(hhtEngineOpportunities.id, opportunity.id))
    return
  }
  const contact = existing ?? (await db.insert(hhtEngineContacts).values({
    emailNormalized,
    name: chosen.name,
    role: chosen.role,
    email: chosen.email,
    formUrl: chosen.formUrl,
    method: chosen.method,
    source: chosen.source,
  }).returning())[0]
  if (contact) {
    await db.insert(hhtEngineContactDomains).values({ contactId: contact.id, rootDomain: opportunity.rootDomain }).onConflictDoNothing()
  }
  if (opportunity.status !== 'HELD') {
    await db.update(hhtEngineOpportunities).set({ status: 'CONTACT_ENRICHED' }).where(eq(hhtEngineOpportunities.id, opportunity.id))
  }
  await enqueueJob(db, { type: 'RENDER_DRAFT', idempotencyKey: `draft:${key}`, payload: { canonicalKey: key } })
}

async function renderDraft(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
): Promise<void> {
  const key = String(job.payload['canonicalKey'] ?? '')
  const [opportunity] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!opportunity) return
  const [domain] = await db.select().from(hhtEngineDomains).where(eq(hhtEngineDomains.rootDomain, opportunity.rootDomain))
  const pages = await db.select().from(hhtEngineOpportunityPages).where(eq(hhtEngineOpportunityPages.opportunityId, opportunity.id))
  const links = await db.select().from(hhtEngineContactDomains).where(eq(hhtEngineContactDomains.rootDomain, opportunity.rootDomain))
  const contactId = links[0]?.contactId
  const [contact] = contactId == null ? [] : await db.select().from(hhtEngineContacts).where(eq(hhtEngineContacts.id, contactId))
  const personalization = opportunity.type === 'guest_post'
    ? await prepareGuestPostPersonalization(db, job, opportunity, domain)
    : null
  if (opportunity.type === 'guest_post' && !personalization) return
  const channel = contact?.method === 'CONTACT_FORM' ? 'contact_form' : 'email'
  const templateId = `${opportunity.type === 'guest_post' ? 'guest_post' : 'link_insertion'}.${channel}`
  let template = ''
  try {
    template = await readFile(`config/hht-engine/templates/${templateId}`, 'utf8')
  } catch {
    await sendNotification(
      db,
      `Missing outreach template for ${templateId}. Drafting for that type is blocked.`,
      { subject: 'HHT engine: missing outreach template', eventType: `missing_template:${templateId}` },
    )
    throw new Error(`Missing outreach template ${templateId}`)
  }
  const [hhtPage] = opportunity.targetHhtUrl
    ? await db.select().from(hhtEngineHhtPages).where(eq(hhtEngineHhtPages.url, opportunity.targetHhtUrl))
    : []
  const article = pages[0]
  let rendered: { subject: string; body: string }
  try {
    rendered = renderTemplate(template, {
      publisherName: domain?.displayName ?? opportunity.rootDomain,
      contactName: contact?.name ?? '',
      articleTitle: article?.title ?? '',
      articleUrl: opportunity.type === 'link_insertion' ? insertionUrl(key) : '',
      rankingKeyword: opportunity.bestKeyword ?? opportunity.sourceKeyword ?? '',
      serpPosition: opportunity.bestPosition ? String(opportunity.bestPosition) : '',
      city: hhtPage?.city ?? '',
      state: hhtPage?.state ?? '',
      targetHhtUrl: opportunity.targetHhtUrl ?? '',
      secondaryHhtUrl: opportunity.secondaryHhtUrl ?? '',
      insertionSuggestion: opportunity.insertionSuggestion ?? '',
      guestPostRequirements: domain?.guestPostRequirements ?? '',
      pitchTopics: personalization?.pitchTopics.map((topic, index) => (
        `${index + 1}. ${topic.title} — ${topic.targetHhtUrl}`
      )).join('\n') ?? '',
      fitLine: personalization?.fitLine ?? '',
      subjectLine: domain?.requiredSubjectLineFormat ?? personalization?.subjectLine ?? '',
      submissionMethod: domain?.submissionMethod ?? '',
      submissionUrl: domain?.submissionUrl ?? '',
      pitchTopicCount: domain?.pitchTopicCount ? String(domain.pitchTopicCount) : '',
      pitchContentStage: domain?.pitchContentStage ?? '',
      requiredSubjectLineFormat: domain?.requiredSubjectLineFormat ?? '',
      acceptedTopics: (domain?.acceptedTopics ?? []).join(', '),
      excludedTopics: (domain?.excludedTopics ?? []).join(', '),
      wordCount: domain?.wordCount ?? '',
      linkPolicy: domain?.linkPolicy ?? '',
      samplesRequired: domain?.samplesRequired ? 'yes' : 'no',
      bioRequired: domain?.bioRequired ? 'yes' : 'no',
      aiContentPolicy: domain?.aiContentPolicy ?? '',
      paidOrSponsored: domain?.paidOrSponsored ? 'yes' : 'no',
      guidelineEvidence: formatGuidelineEvidence(domain?.guidelineEvidence),
    }, {
      requireSubject: channel === 'email',
      maxBodyLength: channel === 'contact_form' ? 1_000 : undefined,
    })
    if (opportunity.type === 'guest_post' && channel === 'email') {
      rendered.subject = domain?.requiredSubjectLineFormat ?? personalization?.subjectLine ?? rendered.subject
    }
  } catch (error) {
    await sendNotification(
      db,
      `Template ${templateId} cannot render: ${error instanceof Error ? error.message : String(error)}`,
      { subject: 'HHT engine: missing outreach template', eventType: `missing_template:${templateId}` },
    )
    throw error
  }
  await db.insert(hhtEngineDrafts).values({
    opportunityId: opportunity.id,
    templateId,
    subject: rendered.subject,
    body: rendered.body,
  }).onConflictDoUpdate({
    target: hhtEngineDrafts.opportunityId,
    set: { subject: rendered.subject, body: rendered.body, templateId },
  })
  if (opportunity.status !== 'HELD') {
    await db.update(hhtEngineOpportunities).set({ status: 'DRAFT_READY' }).where(eq(hhtEngineOpportunities.id, opportunity.id))
  }
  if (opportunity.type === 'link_insertion' && opportunity.status !== 'HELD') {
    await enqueueJob(db, { type: 'REVERIFY_RANKING', idempotencyKey: `reverify:${key}`, payload: { canonicalKey: key } })
    return
  }
  await enqueueJob(db, { type: 'SYNC_CRM', idempotencyKey: `crm:${key}:draft`, payload: { canonicalKey: key } })
}

async function syncCrm(db: EngineDatabase, payload: Record<string, unknown>): Promise<void> {
  const key = String(payload['canonicalKey'] ?? '')
  const [opportunity] = await db.select().from(hhtEngineOpportunities).where(eq(hhtEngineOpportunities.canonicalKey, key))
  if (!opportunity) return
  const leadStatus = opportunity.status === 'DRAFT_READY' ? 'READY_FOR_REVIEW' : opportunity.status
  if (leadStatus !== opportunity.status) {
    await db.update(hhtEngineOpportunities).set({ status: leadStatus }).where(eq(hhtEngineOpportunities.id, opportunity.id))
  }
  if (loadEngineConfig().crmEnabled) {
    throw new Error('CRM adapter is enabled, but connection is intentionally out of scope; set crm_enabled: false')
  }
}

async function pullCrm(db: EngineDatabase): Promise<void> {
  void db
  if (loadEngineConfig().crmEnabled) {
    throw new Error('CRM status pull is disabled until the CRM integration phase')
  }
}

async function notifySemrushReplacement(
  db: EngineDatabase,
  reason: 'authorization failed' | 'credits exhausted',
): Promise<void> {
  const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  const queued = await db.select().from(hhtEngineJobs).where(eq(hhtEngineJobs.status, 'blocked_on_semrush'))
  await sendNotification(
    db,
    semrushReplacementNotice({
      reason,
      pausedAt: (state?.semrushPausedAt ?? new Date()).toISOString(),
      unitsUsed: state?.unitsUsed ?? 0,
      queuedJobs: queued.length,
    }),
    {
      subject: 'HHT engine: replace the Semrush account in the Cursor MCP connector',
      eventType: `semrush_${state?.semrushState.toLowerCase() ?? 'unavailable'}`,
    },
  )
}

async function semrushHealth(db: EngineDatabase): Promise<void> {
  const [before] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  let credential: SemrushConnectorCredential
  try {
    credential = await semrushCredential(db)
  } catch {
    const changed = await setSemrushState(db, 'AUTH_FAILURE')
    if (changed) await notifySemrushReplacement(db, 'authorization failed')
    return
  }
  const client = new SemrushMcpClient(credential, fetch, (next) => saveCredential(db, next))
  try {
    await client.listReports('domain_overview')
  } catch (error) {
    if (error instanceof SemrushMcpError && (error.kind === 'auth' || error.kind === 'exhausted')) {
      const changed = await setSemrushState(db, error.kind === 'auth' ? 'AUTH_FAILURE' : 'EXHAUSTED')
      if (changed) await notifySemrushReplacement(db, error.kind === 'auth' ? 'authorization failed' : 'credits exhausted')
      return
    }
    throw error
  }
  const replaced = accountReplaced(credential, before?.semrushPausedAt ?? null)
  const authRecovered = before?.semrushState === 'AUTH_FAILURE'
  const creditsReplaced = before?.semrushState === 'EXHAUSTED' && replaced
  if (before?.semrushState === 'EXHAUSTED' && !replaced) return
  const changed = await setSemrushState(db, 'RUNNING')
  if (authRecovered || creditsReplaced) {
    await resumeJobs(db, 'blocked_on_semrush')
    await sendNotification(
      db,
      `Semrush resumed at ${new Date().toISOString()}. The connector credential is valid. Queued Semrush jobs are running again.`,
      { subject: 'HHT engine: Semrush resumed', eventType: 'semrush_resumed' },
    )
  }
  void changed
}

async function gadsHealth(db: EngineDatabase): Promise<void> {
  try {
    await pingGoogleAds(await googleAdsEnv(db))
  } catch (error) {
    if (error instanceof GadsError && error.kind === 'auth') {
      const changed = await setGadsState(db, 'GADS_AUTH_FAILURE')
      if (changed) await sendNotification(
        db,
        `${notificationForGads('GADS_AUTH_FAILURE', 'Google Ads OAuth refresh token or developer token') ?? 'Google Ads authorization failed.'} Run \`pnpm engine auth:google-ads\`.`,
        { subject: 'HHT engine: Google Ads authorization failed', eventType: 'gads_auth_failure' },
      )
      return
    }
    if (error instanceof GadsError && error.kind === 'rate_limit') {
      await setGadsState(db, 'GADS_RATE_LIMITED')
      return
    }
    throw error
  }
  const changed = await setGadsState(db, 'GADS_RUNNING')
  if (changed) {
    await resumeJobs(db, 'blocked_on_gads')
    await sendNotification(
      db,
      notificationForGads('GADS_RUNNING', 'Google Ads') ?? 'Google Ads keyword planning is running again.',
      { subject: 'HHT engine: Google Ads resumed', eventType: 'gads_resumed' },
    )
  }
}

export async function seedFrontier(db: EngineDatabase): Promise<void> {
  const state = await currentState(db)
  const config = loadEngineConfig()
  await enqueueJob(db, {
    type: 'SYNC_HHT_PAGES',
    idempotencyKey: `sync:hht-pages:${dayBucket(1)}`,
    payload: {},
  })
  for (const seed of config.seeds) {
    await insertKeyword(db, { keyword: seed, sourceType: 'seed', depth: 0 })
    if (state.gads !== 'GADS_AUTH_FAILURE') {
      await enqueueJob(db, {
        type: 'GADS_GENERATE_IDEAS',
        idempotencyKey: `ideas:seed:${normalizeFrontierKeyword(seed)}`,
        payload: { seedType: 'keyword', seed, depth: 1 },
      })
    }
  }
  if (state.gads !== 'GADS_AUTH_FAILURE') {
    await enqueueJob(db, {
      type: 'GADS_GENERATE_IDEAS',
      idempotencyKey: 'ideas:site:hotelhottubs.com',
      payload: { seedType: 'site', seed: 'hotelhottubs.com', depth: 1 },
    })
  }
  const research = await db.select().from(hhtEnginePublisherResearch)
  for (const row of research) {
    if (cacheFresh(row.checkedAt, new Date(), 60)) continue
    await enqueueJob(db, {
      type: 'CHECK_GUEST_POST_POLICY',
      idempotencyKey: `guest:${row.rootDomain}:${dayBucket(60)}`,
      payload: { rootDomain: row.rootDomain },
    })
    if (state.semrush === 'RUNNING' || state.semrush === 'LOW_CREDITS') {
      await enqueueJob(db, {
        type: 'FETCH_DOMAIN_METRICS',
        idempotencyKey: `authority:${row.rootDomain}:${dayBucket(60)}`,
        payload: { rootDomain: row.rootDomain },
      })
    }
  }
  if (state.semrush === 'RUNNING' || state.semrush === 'LOW_CREDITS') {
    for (const domain of config.competitors) {
      await enqueueJob(db, {
        type: 'EXPAND_KEYWORDS_SEMRUSH',
        idempotencyKey: `expand:competitor:${domain}`,
        payload: { domain, source: 'competitor_keyword' },
      })
    }
    await enqueueNextSerp(db)
  }
}

async function enqueueNextSerp(db: EngineDatabase): Promise<void> {
  const config = loadEngineConfig()
  const rows = await db.select().from(hhtEngineKeywords)
  const now = new Date()
  const actionable = rows.flatMap((row) => {
    if (row.status === 'REJECTED_IRRELEVANT' || row.status === 'NEW') return []
    const next = bandForDepth(row.maxSerpPositionScanned)
    const threshold = next?.band === 2
      ? config.band2MinNewDomains
      : next?.band === 3
        ? config.band3MinNewDomains
        : 0
    const earned = next !== null && (next.band === 1 || row.newDomainsDiscovered >= threshold)
    if (earned && next && next.positionEnd <= config.engine.maxSerpDepth) {
      return [{ row, band: next.band, rescan: false }]
    }
    const staleDays = row.status === 'SATURATED' || row.status === 'LOW_YIELD' ? 180 : 30
    if (row.maxSerpPositionScanned > 0 && !cacheFresh(row.lastSerpScanAt, now, staleDays)) {
      return [{ row, band: 1 as const, rescan: true }]
    }
    return []
  })
  const picked = pickFrontierKeyword(actionable.map((item) => ({
    id: item.row.id,
    priorityScore: item.row.priorityScore,
    cluster: item.row.semanticCluster,
    city: item.row.geoCity,
    sourceType: item.row.sourceType,
    scanned: item.row.maxSerpPositionScanned > 0 && !item.rescan,
  })), config.engine.exploreShare, rows.length)
  const match = actionable.find((item) => item.row.id === picked?.id)
  if (!match) return
  const day = now.toISOString().slice(0, 10)
  await enqueueJob(db, {
    type: 'FETCH_SERP_BAND',
    idempotencyKey: match.rescan ? `rescan:${match.row.id}:1:${day}` : `serp:${match.row.id}:${match.band}`,
    payload: { keywordId: match.row.id, rescan: match.rescan },
  })
}

export async function remindIfDue(db: EngineDatabase): Promise<void> {
  const config = loadEngineConfig()
  const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  if (!state) return
  if (state.semrushState === 'EXHAUSTED' || state.semrushState === 'AUTH_FAILURE') {
    const queued = await db.select().from(hhtEngineJobs).where(eq(hhtEngineJobs.status, 'blocked_on_semrush'))
    await remind(
      db,
      'semrush_reminder',
      config.reminderHours,
      semrushReplacementNotice({
        reason: state.semrushState === 'AUTH_FAILURE' ? 'authorization failed' : 'credits exhausted',
        pausedAt: (state.semrushPausedAt ?? new Date()).toISOString(),
        unitsUsed: state.unitsUsed,
        queuedJobs: queued.length,
      }),
      'HHT engine: replace the Semrush account in the Cursor MCP connector',
    )
  }
  if (state.gadsState === 'GADS_AUTH_FAILURE') {
    await remind(
      db,
      'gads_auth_reminder',
      config.reminderHours,
      `${notificationForGads('GADS_AUTH_FAILURE', 'Google Ads OAuth refresh token or developer token') ?? 'Google Ads authorization failed.'} Run \`pnpm engine auth:google-ads\`.`,
      'HHT engine: Google Ads authorization failed',
    )
  }
  if (state.gadsState === 'GADS_RATE_LIMITED' && state.gadsPausedAt && !cacheFresh(state.gadsPausedAt, new Date(), config.gadsRateLimitNotifyHours / 24)) {
    await remind(
      db,
      'gads_rate_reminder',
      config.gadsRateLimitNotifyHours,
      notificationForGads('GADS_RATE_LIMITED', 'Google Ads') ?? 'Google Ads keyword planning is rate-limited.',
      'HHT engine: Google Ads rate-limited over 6 hours',
    )
  }
}

export async function sendNotification(
  db: EngineDatabase,
  message: string,
  options: { subject?: string; eventType?: string; attempt?: number } = {},
): Promise<void> {
  const subject = options.subject ?? 'HHT backlink engine notification'
  const eventType = options.eventType ?? 'generic'
  const attempt = options.attempt ?? 0
  try {
    const credentials = await googleServiceAccountCredentials(db)
    const messageId = await sendGmailNotification({ credentials, subject, text: message })
    await db.insert(hhtEngineNotifications).values({
      channel: 'email',
      eventType,
      subject,
      payload: message,
      deliveryResult: `gmail_ok:${messageId}`,
      attempts: attempt + 1,
    })
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    const nextAttemptAt = new Date(Date.now() + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** attempt))
    await db.insert(hhtEngineNotifications).values({
      channel: 'email',
      eventType,
      subject,
      payload: message,
      deliveryResult: `gmail_error:${failure.slice(0, 300)}`,
      attempts: attempt + 1,
      nextAttemptAt,
    })
    if (attempt < 4) {
      await enqueueJob(db, {
        type: 'SEND_NOTIFICATION',
        idempotencyKey: `notification:${eventType}:${attempt + 1}:${Math.floor(nextAttemptAt.getTime() / 60_000)}`,
        payload: { message, subject, eventType, attempt: attempt + 1 },
      })
      await db.update(hhtEngineJobs).set({ runAfter: nextAttemptAt }).where(eq(
        hhtEngineJobs.idempotencyKey,
        `notification:${eventType}:${attempt + 1}:${Math.floor(nextAttemptAt.getTime() / 60_000)}`,
      ))
    }
  }
}

async function remind(
  db: EngineDatabase,
  eventType: string,
  hours: number,
  message: string,
  subject: string,
): Promise<void> {
  const [last] = await db.select().from(hhtEngineNotifications).where(eq(hhtEngineNotifications.eventType, eventType)).orderBy(desc(hhtEngineNotifications.id)).limit(1)
  if (last && cacheFresh(last.createdAt, new Date(), hours / 24)) return
  await sendNotification(db, message, { subject, eventType })
}

async function notifyCrmOutage(db: EngineDatabase): Promise<void> {
  const config = loadEngineConfig()
  const events = await db.select().from(hhtEngineCrmEvents).orderBy(desc(hhtEngineCrmEvents.id)).limit(20)
  if (events.some((event) => event.result === 'ok')) return
  const oldest = events.at(-1)
  if (!oldest || cacheFresh(oldest.createdAt, new Date(), config.crmOutageNotifyMinutes / (60 * 24))) return
  await remind(
    db,
    'crm_outage',
    config.crmOutageNotifyMinutes / 60,
    `CRM sync has been failing since ${oldest.createdAt.toISOString()}. Leads stay queued locally.`,
    'HHT engine: CRM sync outage',
  )
}

async function insertKeyword(db: EngineDatabase, input: {
  keyword: string
  sourceType: string
  sourceKeywordId?: number | null
  sourceDomain?: string | null
  city?: string | null
  state?: string | null
  depth: number
  metrics?: { avgMonthlySearches: number | null; volumeLow: number | null; volumeHigh: number | null; volumeIsRange: boolean }
}): Promise<void> {
  const config = loadEngineConfig()
  const normalized = normalizeFrontierKeyword(input.keyword)
  if (!normalized || input.depth > config.expansionDepthCap) return
  if (input.sourceType !== 'seed' && input.sourceType !== 'manual') {
    const counted = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM hht_engine.keywords
       WHERE created_at > now() - interval '1 day' AND source_type NOT IN ('seed', 'manual')
    `)
    const count = Number((counted as unknown as Array<{ count: string }>)[0]?.count ?? 0)
    if (count >= config.dailyKeywordCap) return
  }
  const [row] = await db.insert(hhtEngineKeywords).values({
    keyword: input.keyword,
    normalizedKeyword: normalized,
    sourceType: input.sourceType,
    sourceKeywordId: input.sourceKeywordId ?? null,
    sourceDomain: input.sourceDomain ?? null,
    geoCity: input.city ?? null,
    geoState: input.state ?? null,
    avgMonthlySearches: input.metrics?.avgMonthlySearches ?? null,
    volumeLow: input.metrics?.volumeLow ?? null,
    volumeHigh: input.metrics?.volumeHigh ?? null,
    volumeIsRange: input.metrics?.volumeIsRange ?? false,
    volumeSource: input.metrics ? 'google_ads' : null,
    expansionDepth: input.depth,
    priorityScore: priorityScore({
      clusterYield: 0,
      relevanceScore: 0.5,
      verifiedStayCount: 0,
      sourceYield: 0,
      novel: true,
      estimatedUnits: 200,
      avgMonthlySearches: input.metrics?.avgMonthlySearches ?? null,
      volumeLow: input.metrics?.volumeLow ?? null,
      volumeHigh: input.metrics?.volumeHigh ?? null,
      volumeIsRange: input.metrics?.volumeIsRange ?? false,
      explore: input.sourceType === 'publisher_keyword',
    }),
    status: 'NEW',
  }).onConflictDoNothing().returning()
  if (row) await enqueueJob(db, { type: 'GATE_KEYWORDS', idempotencyKey: `gate:${row.id}`, payload: { keywordId: row.id } })
}

async function inventory(db: EngineDatabase): Promise<HhtInventoryPage[]> {
  const rows = await db.select().from(hhtEngineHhtPages)
  return rows.map((row) => ({
    url: row.url,
    pageType: row.pageType as HhtInventoryPage['pageType'],
    city: row.city,
    state: row.state,
    collection: row.collection,
    verifiedStayCount: row.verifiedStayCount,
    title: row.title,
  }))
}

async function semrush(db: EngineDatabase): Promise<SemrushMcpClient> {
  const credential = await semrushCredential(db)
  return new SemrushMcpClient(credential, fetch, (next) => saveCredential(db, next))
}

async function semrushCredential(db: EngineDatabase): Promise<SemrushConnectorCredential> {
  const stored = await loadCredential(db)
  if (stored) return stored
  throw new SemrushMcpError('Vault secret semrush_oauth_token is not synced', 'auth')
}

async function currentState(db: EngineDatabase): Promise<{ semrush: string; gads: string }> {
  const [row] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  return { semrush: row?.semrushState ?? 'RUNNING', gads: row?.gadsState ?? 'GADS_RUNNING' }
}

async function resumeJobs(db: EngineDatabase, status: 'blocked_on_semrush' | 'blocked_on_gads'): Promise<void> {
  await db.update(hhtEngineJobs).set({
    status: 'pending',
    lockedBy: null,
    heartbeatAt: null,
    runAfter: new Date(),
    updatedAt: new Date(),
  }).where(eq(hhtEngineJobs.status, status))
}

function accountReplaced(credential: SemrushConnectorCredential, pausedAt: Date | null): boolean {
  if (!pausedAt || credential.cursorUpdatedAtMs === null) return false
  return credential.cursorUpdatedAtMs > pausedAt.getTime()
}

interface PublisherContextItem {
  title: string
  url: string
}

interface GroundedGuestPostPersonalization {
  pitchTopics: Array<{ title: string; targetHhtUrl: string; citations: string[] }>
  fitLine: string
  fitLineCitations: string[]
  subjectLine: string
  subjectLineCitations: string[]
}

async function prepareGuestPostPersonalization(
  db: EngineDatabase,
  job: { id: number; payload: Record<string, unknown> },
  opportunity: typeof hhtEngineOpportunities.$inferSelect,
  domain: typeof hhtEngineDomains.$inferSelect | undefined,
): Promise<GroundedGuestPostPersonalization | null> {
  if (!domain) return null
  const config = loadEngineConfig()
  const context = await publisherPersonalizationContext(db, opportunity.rootDomain)
  const hhtPages = await inventory(db)
  const topicCount = domain.pitchTopicCount ?? config.guestPostTopicDefaultCount
  const answer = await requireLlmAnswer({
    db,
    job,
    taskType: 'guest_post_personalization',
    entityType: 'opportunity',
    entityId: String(opportunity.id),
    taskInput: {
      root_domain: opportunity.rootDomain,
      guidelines: {
        submission_method: domain.submissionMethod,
        submission_url: domain.submissionUrl,
        pitch_topic_count: topicCount,
        pitch_content_stage: domain.pitchContentStage,
        required_subject_line_format: domain.requiredSubjectLineFormat,
        accepted_topics: domain.acceptedTopics ?? [],
        excluded_topics: domain.excludedTopics ?? [],
        word_count: domain.wordCount,
        link_policy: domain.linkPolicy,
        samples_required: domain.samplesRequired,
        bio_required: domain.bioRequired,
        ai_content_policy: domain.aiContentPolicy,
        paid_or_sponsored: domain.paidOrSponsored,
        evidence: domain.guidelineEvidence ?? {},
      },
      recent_posts: context.recentPosts,
      categories: context.categories,
      hht_page_inventory: hhtPages.map((page) => ({
        url: page.url,
        title: page.title,
        page_type: page.pageType,
        city: page.city,
        state: page.state,
        collection: page.collection,
      })),
      limits: {
        pitch_topic_count: topicCount,
        topic_max_chars: config.guestPostTopicMaxChars,
        fit_line_max_chars: config.guestPostFitLineMaxChars,
        subject_line_max_chars: config.guestPostSubjectLineMaxChars,
      },
      instruction: [
        'Return exactly the requested number of pitch topics.',
        'Ground each topic in the publisher recent_posts or categories and map it to one HHT inventory URL.',
        'Do not propose a topic that is a near-duplicate of a recent post.',
        'Ground fit_line in a real publisher URL.',
        domain.requiredSubjectLineFormat
          ? 'Return subject_line as null because the guidelines dictate it.'
          : 'Generate and ground subject_line.',
        'Every generated object must include its grounding URLs in citations.',
      ].join(' '),
    },
  })
  const grounded = await groundGuestPostPersonalization({
    db,
    opportunityId: opportunity.id,
    answer,
    context,
    guidelineUrls: Object.values(domain.guidelineEvidence ?? {}),
    hhtPages,
    topicCount,
    topicMaxChars: config.guestPostTopicMaxChars,
    fitLineMaxChars: config.guestPostFitLineMaxChars,
    subjectLineMaxChars: config.guestPostSubjectLineMaxChars,
    requireGeneratedSubject: !domain.requiredSubjectLineFormat,
    nearDuplicateSimilarity: config.nearDuplicateSimilarity,
    topicFitMinimum: config.engine.llmRelevanceLow,
  })
  const reviewReasons: string[] = []
  if (grounded.pitchTopics.length !== topicCount) reviewReasons.push('guest_post_pitch_topics_ungrounded')
  if (!grounded.fitLine) reviewReasons.push('guest_post_fit_line_ungrounded')
  if (!domain.requiredSubjectLineFormat && !grounded.subjectLine) reviewReasons.push('guest_post_subject_line_ungrounded')
  if (reviewReasons.length) {
    await db.update(hhtEngineOpportunities).set({
      filterStatus: 'REVIEW',
      filterReasons: reviewReasons,
    }).where(eq(hhtEngineOpportunities.id, opportunity.id))
    return null
  }
  await db.update(hhtEngineOpportunities).set({
    guestPostPitchTopics: grounded.pitchTopics,
    guestPostFitLine: grounded.fitLine,
    guestPostFitLineCitations: grounded.fitLineCitations,
    guestPostSubjectLine: grounded.subjectLine || null,
    guestPostSubjectLineCitations: grounded.subjectLineCitations,
  }).where(eq(hhtEngineOpportunities.id, opportunity.id))
  return grounded
}

async function publisherPersonalizationContext(
  db: EngineDatabase,
  rootDomain: string,
): Promise<{ recentPosts: PublisherContextItem[]; categories: PublisherContextItem[] }> {
  const recentPosts = new Map<string, PublisherContextItem>()
  const categories = new Map<string, PublisherContextItem>()
  for (const sourceUrl of [`https://${rootDomain}`, `https://${rootDomain}/blog`]) {
    const html = await fetchText(sourceUrl)
    if (!html) continue
    const $ = loadHtml(html)
    $('article a[href], h2 a[href], h3 a[href]').each((_index, element) => {
      const title = $(element).text().replace(/\s+/g, ' ').trim()
      const url = sameDomainUrl($(element).attr('href'), sourceUrl, rootDomain)
      if (url && title.length >= 5) recentPosts.set(url, { title, url })
    })
    $('a[href*="/category/"], a[href*="/categories/"], a[href*="/topic/"], a[href*="/topics/"]').each((_index, element) => {
      const title = $(element).text().replace(/\s+/g, ' ').trim()
      const url = sameDomainUrl($(element).attr('href'), sourceUrl, rootDomain)
      if (url && title.length >= 2) categories.set(url, { title, url })
    })
  }
  const known = await db.select().from(hhtEnginePublisherPages).where(eq(hhtEnginePublisherPages.rootDomain, rootDomain))
  for (const page of known) {
    if (page.title && !recentPosts.has(page.canonicalUrl)) {
      recentPosts.set(page.canonicalUrl, { title: page.title, url: page.canonicalUrl })
    }
  }
  return {
    recentPosts: [...recentPosts.values()].slice(0, 20),
    categories: [...categories.values()].slice(0, 50),
  }
}

async function groundGuestPostPersonalization(input: {
  db: EngineDatabase
  opportunityId: number
  answer: Record<string, unknown>
  context: { recentPosts: PublisherContextItem[]; categories: PublisherContextItem[] }
  guidelineUrls: string[]
  hhtPages: HhtInventoryPage[]
  topicCount: number
  topicMaxChars: number
  fitLineMaxChars: number
  subjectLineMaxChars: number
  requireGeneratedSubject: boolean
  nearDuplicateSimilarity: number
  topicFitMinimum: number
}): Promise<GroundedGuestPostPersonalization> {
  const publisherUrls = new Set([
    ...input.context.recentPosts.map((item) => item.url),
    ...input.context.categories.map((item) => item.url),
    ...input.guidelineUrls,
  ])
  const hhtUrls = new Set(input.hhtPages.map((page) => page.url))
  const pitchTopics: GroundedGuestPostPersonalization['pitchTopics'] = []
  const rawTopics = Array.isArray(input.answer['pitch_topics']) ? input.answer['pitch_topics'] : []
  for (let index = 0; index < rawTopics.length && pitchTopics.length < input.topicCount; index += 1) {
    const topic = recordValue(rawTopics[index])
    const title = stringValue(topic['title'])
    const targetHhtUrl = stringValue(topic['target_hht_url'])
    const citations = groundedCitations(topic['citations'], publisherUrls)
    if (!title || title.length > input.topicMaxChars || !hhtUrls.has(targetHhtUrl) || citations.length === 0) continue
    const topicEmbedding = await cachedEmbedding(
      input.db,
      'guest_post_topic',
      `${input.opportunityId}:${index}:${textHash(title)}`,
      title,
    )
    let nearDuplicate = false
    let maxNicheSimilarity = 0
    for (const post of input.context.recentPosts) {
      const postEmbedding = await cachedEmbedding(
        input.db,
        'publisher_post_title',
        `${post.url}:${textHash(post.title)}`,
        post.title,
      )
      const similarity = cosineSimilarity(topicEmbedding, postEmbedding)
      maxNicheSimilarity = Math.max(maxNicheSimilarity, similarity)
      if (similarity >= input.nearDuplicateSimilarity) {
        nearDuplicate = true
        break
      }
    }
    if (nearDuplicate) continue
    for (const category of input.context.categories) {
      const categoryEmbedding = await cachedEmbedding(
        input.db,
        'publisher_category',
        `${category.url}:${textHash(category.title)}`,
        category.title,
      )
      maxNicheSimilarity = Math.max(maxNicheSimilarity, cosineSimilarity(topicEmbedding, categoryEmbedding))
    }
    if (maxNicheSimilarity < input.topicFitMinimum) continue
    pitchTopics.push({
      title,
      targetHhtUrl,
      citations: [...new Set([...citations, targetHhtUrl])],
    })
  }
  const fit = recordValue(input.answer['fit_line'])
  const fitLine = stringValue(fit['text'])
  const fitLineCitations = groundedCitations(fit['citations'], publisherUrls)
  const groundedFitLine = fitLine
    && fitLine.length <= input.fitLineMaxChars
    && isSingleSentence(fitLine)
    && fitLineCitations.length
    ? fitLine
    : ''
  const subject = recordValue(input.answer['subject_line'])
  const subjectLine = stringValue(subject['text'])
  const subjectAllowed = new Set([...publisherUrls, ...hhtUrls])
  const subjectLineCitations = groundedCitations(subject['citations'], subjectAllowed)
  const groundedSubject = input.requireGeneratedSubject
    && subjectLine
    && subjectLine.length <= input.subjectLineMaxChars
    && subjectLineCitations.length
    ? subjectLine
    : ''
  return {
    pitchTopics,
    fitLine: groundedFitLine,
    fitLineCitations: groundedFitLine ? fitLineCitations : [],
    subjectLine: groundedSubject,
    subjectLineCitations: groundedSubject ? subjectLineCitations : [],
  }
}

function groundedCitations(value: unknown, allowed: Set<string>): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && allowed.has(item)))]
    : []
}

function sameDomainUrl(value: string | undefined, baseUrl: string, rootDomain: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value, baseUrl)
    return registrableDomain(url.hostname)?.domain === rootDomain ? url.toString() : null
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isSingleSentence(value: string): boolean {
  return !value.includes('\n') && (value.match(/[.!?](?:\s|$)/g)?.length ?? 0) <= 1
}

function textHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function formatGuidelineEvidence(value: Record<string, string> | null | undefined): string {
  return Object.entries(value ?? {}).map(([field, url]) => `${field}: ${url}`).join('\n')
}

function guidelinePageContent(url: string, html: string): {
  url: string
  text: string
  links: Array<{ text: string; url: string }>
} {
  if (!html) return { url, text: '', links: [] }
  const $ = loadHtml(html)
  $('script, style, noscript, svg').remove()
  const links: Array<{ text: string; url: string }> = []
  $('a[href]').each((_index, element) => {
    const href = absoluteHttpUrl($(element).attr('href') ?? '', url)
    const text = $(element).text().replace(/\s+/g, ' ').trim()
    if (href && text) links.push({ text, url: href })
  })
  return {
    url,
    text: $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20_000),
    links: links.slice(0, 100),
  }
}

async function guidelineSubmissionCandidates(
  domain: typeof hhtEngineDomains.$inferSelect,
  baseUrl: string,
): Promise<Array<{
  name: null
  role: null
  email: string | null
  formUrl: string | null
  source: string
}>> {
  const method = domain.submissionMethod
  const target = domain.submissionUrl?.trim() ?? ''
  const evidenceUrl = domain.guidelineEvidence?.['submission_method']
  if (method === 'email') {
    const directEmails = extractEmails(target.replace(/^mailto:/i, ''))
    if (directEmails.length) {
      return directEmails.map((email) => ({
        name: null, role: null, email, formUrl: null, source: 'guidelines_submission_email',
      }))
    }
    const evidenceHtml = evidenceUrl ? await fetchText(evidenceUrl) : ''
    return extractEmails(evidenceHtml).map((email) => ({
      name: null, role: null, email, formUrl: null, source: 'guidelines_submission_email',
    }))
  }
  if (method === 'form' || method === 'google_form' || method === 'other') {
    const formUrl = absoluteHttpUrl(target, baseUrl)
    if (formUrl) {
      return [{
        name: null,
        role: null,
        email: null,
        formUrl,
        source: `guidelines_submission_${method}`,
      }]
    }
  }
  return []
}

function absoluteHttpUrl(value: string, baseUrl: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return ''
    return (await res.text()).slice(0, 100_000)
  } catch {
    return ''
  }
}

function dayBucket(days: number): number {
  return Math.floor(Date.now() / (days * 24 * 60 * 60 * 1000))
}

function insertionUrl(canonicalKey: string): string {
  const parts = canonicalKey.split('+')
  return parts[1] ?? ''
}

function asSiteType(value: string | null | undefined): SiteType {
  return value && SITE_TYPES.has(value) ? value as SiteType : 'unknown'
}

function asGuestPost(value: string | null): GuestPostStatus | null {
  if (value === 'ACCEPTS' || value === 'LIKELY_ACCEPTS' || value === 'UNKNOWN' || value === 'LIKELY_REJECTS' || value === 'DOES_NOT_ACCEPT') return value
  return null
}

function asKeywordStatus(value: string): KeywordStatus {
  if (
    value === 'NEW' || value === 'QUEUED' || value === 'ACTIVE' || value === 'LOW_YIELD_AT_CURRENT_DEPTH' ||
    value === 'SATURATED' || value === 'LOW_YIELD' || value === 'REJECTED_IRRELEVANT'
  ) return value
  return 'ACTIVE'
}

function isLeadStatus(value: string): value is LeadStatus {
  return value === 'REJECTED' || value === 'NO_RESPONSE' || value === 'DECLINED_BY_HHT' || value === 'CONTACTED'
}

export async function sweepStaleJobs(db: EngineDatabase, timeoutMinutes = 15): Promise<void> {
  await db.execute(sql`
    UPDATE hht_engine.jobs
       SET status = 'pending', locked_by = null, heartbeat_at = null, updated_at = now()
     WHERE status = 'running' AND heartbeat_at < now() - (${timeoutMinutes} || ' minutes')::interval
  `)
}
