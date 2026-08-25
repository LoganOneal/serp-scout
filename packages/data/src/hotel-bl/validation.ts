import 'server-only'
import { load } from 'cheerio'
import pLimit from 'p-limit'
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'
import {
  hotelBlIdentitySimilarity,
  normalizeHotelBlUrl,
  validateHotelBlSourceUrl,
  type HotelBlEntityScope,
  type HotelBlEntityType,
  type HotelBlRelationshipType,
  type HotelBlUrlValidationResult,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hotelBlDiscoveredPages,
  hotelBlDomains,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlOpportunities,
  hotelBlRelationships,
  hotelBlRunEvents,
  hotelBlRuns,
} from '../schema.js'
import { fetchHotelBlPage, type HotelBlFetchResult } from './crawl.js'
import { recalculateHotelBlOpportunities } from './scoring.js'

interface ValidationIdentity {
  title: string | null
  headings: string[]
  lodgingNames: string[]
  organizationNames: string[]
  text: string
  matchedAddress: string | null
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => clean(value ?? '')).filter(Boolean))]
}

function jsonLdNodes(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  const queue: unknown[] = [value]
  let seen = 0
  while (queue.length > 0 && seen < 1_000) {
    const current = queue.shift()
    seen += 1
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }
    const row = current as Record<string, unknown>
    found.push(row)
    for (const child of Object.values(row)) if (child && typeof child === 'object') queue.push(child)
  }
  return found
}

function schemaTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

function schemaAddress(value: unknown): string | null {
  if (typeof value === 'string') return clean(value) || null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return unique([
    typeof row['streetAddress'] === 'string' ? row['streetAddress'] : null,
    typeof row['addressLocality'] === 'string' ? row['addressLocality'] : null,
    typeof row['addressRegion'] === 'string' ? row['addressRegion'] : null,
    typeof row['postalCode'] === 'string' ? row['postalCode'] : null,
    typeof row['addressCountry'] === 'string' ? row['addressCountry'] : null,
  ]).join(', ') || null
}

const LODGING_TYPES = new Set(['Hotel', 'Motel', 'Resort', 'LodgingBusiness', 'BedAndBreakfast', 'Hostel'])
const ORGANIZATION_TYPES = new Set(['Organization', 'Corporation', 'TravelAgency', 'TouristInformationCenter', 'GovernmentOrganization'])

export function extractHotelBlValidationIdentity(
  html: string | null,
  expectedHotelName?: string,
): ValidationIdentity {
  if (!html) return { title: null, headings: [], lodgingNames: [], organizationNames: [], text: '', matchedAddress: null }
  const $ = load(html)
  const title = clean($('title').first().text()) || null
  const headings = unique($('h1, h2, h3, h4').map((_, element) => $(element).text()).get()).slice(0, 300)
  const lodgingNames: string[] = []
  const organizationNames: string[] = []
  const addresses: Array<{ name: string | null; address: string }> = []
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      for (const node of jsonLdNodes(JSON.parse($(element).text()) as unknown)) {
        const types = schemaTypes(node['@type'])
        const name = typeof node['name'] === 'string' ? clean(node['name']) : null
        if (name && types.some((type) => LODGING_TYPES.has(type))) lodgingNames.push(name)
        if (name && types.some((type) => ORGANIZATION_TYPES.has(type))) organizationNames.push(name)
        const address = schemaAddress(node['address'])
        if (address) addresses.push({ name, address })
      }
    } catch {
      // Invalid third-party JSON-LD is not identity evidence.
    }
  })
  $('script, style, noscript, svg').remove()
  const text = clean($('body').text()).slice(0, 250_000)
  let matchedAddress: string | null = null
  if (expectedHotelName) {
    matchedAddress = addresses
      .sort((left, right) => hotelBlIdentitySimilarity(expectedHotelName, right.name ?? '') - hotelBlIdentitySimilarity(expectedHotelName, left.name ?? ''))
      .find((row) => hotelBlIdentitySimilarity(expectedHotelName, row.name ?? '') >= 0.6)?.address ?? null
    if (!matchedAddress) {
      const bestHeading = headings
        .map((heading) => ({ heading, score: hotelBlIdentitySimilarity(expectedHotelName, heading) }))
        .sort((left, right) => right.score - left.score)[0]
      if (bestHeading && bestHeading.score >= 0.65) {
        const index = text.toLowerCase().indexOf(bestHeading.heading.toLowerCase())
        const context = index >= 0 ? text.slice(index, index + 1_100) : ''
        matchedAddress = context.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .'-]{2,70}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Highway|Hwy|Route|Parkway|Pkwy|Court|Ct)\b[^|]{0,90}/i)?.[0]?.trim() ?? null
      }
    }
  }
  return {
    title,
    headings,
    lodgingNames: unique(lodgingNames),
    organizationNames: unique(organizationNames),
    text,
    matchedAddress,
  }
}

function listingSourceUrl(hotel: typeof hotelBlHotels.$inferSelect): string | null {
  if (!hotel.existingHhtUrl) return null
  const absolute = normalizeHotelBlUrl(hotel.existingHhtUrl)
  if (absolute) return absolute.url
  const sourceHost = hotel.rawSource['source']?.trim().toLowerCase().replace(/^www\./, '')
  if (!sourceHost || !/^tub(?:hotels|stays)\.com$/.test(sourceHost)) return null
  try {
    return new URL(hotel.existingHhtUrl, `https://www.${sourceHost}`).toString()
  } catch {
    return null
  }
}

class HostStartLimiter {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly lastStarts = new Map<string, number>()

  constructor(private readonly delayMs: number) {}

  async wait(url: string): Promise<void> {
    const host = new URL(url).hostname
    const prior = this.tails.get(host) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(host, prior.then(() => current))
    await prior
    const waitMs = Math.max(0, (this.lastStarts.get(host) ?? 0) + this.delayMs - Date.now())
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    this.lastStarts.set(host, Date.now())
    release()
  }
}

const listingLimiter = new HostStartLimiter(250)
const candidateLimiter = new HostStartLimiter(125)
const listingCache = new Map<string, Promise<HotelBlFetchResult>>()

async function limitedFetch(url: string, kind: 'listing' | 'candidate'): Promise<HotelBlFetchResult> {
  const limiter = kind === 'listing' ? listingLimiter : candidateLimiter
  await limiter.wait(url)
  return fetchHotelBlPage(url, { timeoutMs: 12_000, maxAttempts: 2 })
}

async function fetchListing(url: string | null): Promise<HotelBlFetchResult> {
  if (!url) return { url: '', status: null, html: null, error: 'No valid HotelHotTubs listing URL.', lastModified: null }
  const cached = listingCache.get(url)
  if (cached) return cached
  const request = limitedFetch(url, 'listing')
  listingCache.set(url, request)
  return request
}

function slug(value: string | null): string {
  return (value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function currentListingUrls(hotel: typeof hotelBlHotels.$inferSelect, legacyUrl: string | null): string[] {
  const sourceHost = hotel.rawSource['source']?.trim().toLowerCase().replace(/^www\./, '')
  const city = slug(hotel.city)
  const state = slug(hotel.state)
  if (sourceHost === 'tubstays.com' && city && state) {
    return [`https://www.tubstays.com/${state}/${city}`]
  }
  if (sourceHost === 'tubhotels.com') {
    return unique([
      city ? `https://www.tubhotels.com/hotels-with-jacuzzi-in-room-in-${city}/` : null,
      city ? `https://www.tubhotels.com/hotels-in-${city}-with-jacuzzi-in-room/` : null,
      state ? `https://www.tubhotels.com/${state}-hotels-with-jacuzzi-in-room/` : null,
    ])
  }
  return legacyUrl ? [legacyUrl] : []
}

async function fetchCurrentListing(
  hotel: typeof hotelBlHotels.$inferSelect,
  legacyUrl: string | null,
): Promise<{ fetch: HotelBlFetchResult; identity: ValidationIdentity; lookupUrl: string | null }> {
  let firstSuccess: { fetch: HotelBlFetchResult; identity: ValidationIdentity; lookupUrl: string } | null = null
  let lastFailure: HotelBlFetchResult = { url: legacyUrl ?? '', status: null, html: null, error: 'No valid HotelHotTubs listing URL.', lastModified: null }
  for (const lookupUrl of currentListingUrls(hotel, legacyUrl)) {
    const fetched = await fetchListing(lookupUrl)
    const identity = extractHotelBlValidationIdentity(fetched.html, hotel.hotelName)
    if (fetched.status && fetched.status < 400 && fetched.html) {
      const matched = Math.max(
        ...identity.headings.map((name) => hotelBlIdentitySimilarity(hotel.hotelName, name)),
        ...identity.lodgingNames.map((name) => hotelBlIdentitySimilarity(hotel.hotelName, name)),
        hotelBlIdentitySimilarity(hotel.hotelName, identity.text),
      ) >= 0.6
      const success = { fetch: fetched, identity, lookupUrl }
      firstSuccess ??= success
      if (matched) return success
    } else {
      lastFailure = fetched
    }
  }
  return firstSuccess ?? { fetch: lastFailure, identity: extractHotelBlValidationIdentity(lastFailure.html, hotel.hotelName), lookupUrl: null }
}

async function cachedCandidate(
  db: Database,
  domainId: number | null,
  sourceUrl: string | null,
): Promise<HotelBlFetchResult | null> {
  if (!domainId || !sourceUrl) return null
  const normalized = normalizeHotelBlUrl(sourceUrl)
  if (!normalized) return null
  const pages = await db
    .select({ url: hotelBlDiscoveredPages.url, status: hotelBlDiscoveredPages.statusCode, html: hotelBlDiscoveredPages.rawHtml })
    .from(hotelBlDiscoveredPages)
    .where(and(
      eq(hotelBlDiscoveredPages.domainId, domainId),
      isNotNull(hotelBlDiscoveredPages.rawHtml),
      lt(hotelBlDiscoveredPages.statusCode, 400),
    ))
    .limit(12)
  const sourcePath = new URL(normalized.url).pathname.replace(/\/$/, '') || '/'
  const exact = pages.find((page) => normalizeHotelBlUrl(page.url)?.url === normalized.url)
  const samePath = pages.find((page) => {
    const parsed = normalizeHotelBlUrl(page.url)
    return parsed && (new URL(parsed.url).pathname.replace(/\/$/, '') || '/') === sourcePath
  })
  const page = exact ?? samePath
  return page ? { url: page.url, status: page.status, html: page.html, error: null, lastModified: null } : null
}

function relationshipType(result: HotelBlUrlValidationResult): HotelBlRelationshipType {
  if (result.entityScope === 'locality') return 'locality'
  if (result.entityType === 'hotel_brand') return 'brand'
  if (result.entityType === 'hotel_property') return 'property'
  return 'other'
}

function observedEntityName(
  result: HotelBlUrlValidationResult,
  hotelName: string,
  candidate: ValidationIdentity,
  hostname: string | null,
): string | null {
  if (result.entityScope === 'hotel') return candidate.lodgingNames[0] ?? hotelName
  return candidate.organizationNames[0] ?? candidate.headings[0] ?? candidate.title ?? hostname
}

type ValidationJob = typeof hotelBlJobs.$inferSelect

async function claimValidationJob(db: Database, runId: number): Promise<ValidationJob | null> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE hotel_bl_jobs
       SET status = 'running', claimed_at = now(), attempts = attempts + 1,
           updated_at = now(), error = NULL
     WHERE id = (
       SELECT id FROM hotel_bl_jobs
        WHERE run_id = ${runId} AND status = 'pending' AND stage = 'validate_urls'
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

async function completeValidationJob(
  db: Database,
  job: ValidationJob,
  result: { error?: string },
): Promise<void> {
  await db.update(hotelBlJobs).set({
    status: result.error ? 'failed' : 'complete',
    recordsProcessed: result.error ? 0 : 1,
    lastSuccessAt: result.error ? null : new Date(),
    error: result.error ?? null,
    finishedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(hotelBlJobs.id, job.id))
  if (result.error) {
    await db.insert(hotelBlRunEvents).values({
      runId: job.runId,
      jobId: job.id,
      domainId: job.domainId,
      stage: 'validate_urls',
      level: 'error',
      message: result.error,
    })
  }
}

async function validateJob(db: Database, job: ValidationJob): Promise<HotelBlUrlValidationResult> {
  const configuration = job.configuration as { hotelId?: number; relationshipId?: number | null }
  if (!configuration.hotelId) throw new Error(`Validation job #${job.id} has no hotelId.`)
  const [hotel] = await db.select().from(hotelBlHotels).where(eq(hotelBlHotels.id, configuration.hotelId)).limit(1)
  if (!hotel) throw new Error(`Hotel #${configuration.hotelId} no longer exists.`)
  const sourceListing = listingSourceUrl(hotel)
  const currentListing = await fetchCurrentListing(hotel, sourceListing)
  const listingFetch = currentListing.fetch
  const listingIdentity = currentListing.identity

  let candidateFetch = await cachedCandidate(db, job.domainId, hotel.sourceUrl)
  if (!candidateFetch && hotel.sourceUrl) candidateFetch = await limitedFetch(hotel.sourceUrl, 'candidate')
  candidateFetch ??= { url: hotel.sourceUrl ?? '', status: null, html: null, error: 'No candidate URL.', lastModified: null }
  const candidateIdentity = extractHotelBlValidationIdentity(candidateFetch.html, hotel.hotelName)
  const result = validateHotelBlSourceUrl({
    hotelName: hotel.hotelName,
    city: hotel.city,
    state: hotel.state,
    sourceUrl: hotel.sourceUrl,
    sourceLinkType: hotel.sourceLinkType,
    listingUrl: sourceListing,
    listingStatus: listingFetch.status,
    listingFinalUrl: listingFetch.url,
    listingProminentNames: [...listingIdentity.headings, ...listingIdentity.lodgingNames],
    listingText: listingIdentity.text,
    listingAddress: listingIdentity.matchedAddress,
    candidateStatus: candidateFetch.status,
    candidateFinalUrl: candidateFetch.url,
    candidateTitle: candidateIdentity.title,
    candidateHeadings: candidateIdentity.headings.slice(0, 8),
    candidateLodgingNames: candidateIdentity.lodgingNames,
    candidateOrganizationNames: candidateIdentity.organizationNames,
    candidateText: candidateIdentity.text,
  })
  const normalizedCandidate = normalizeHotelBlUrl(candidateFetch.url)
  const entityName = observedEntityName(result, hotel.hotelName, candidateIdentity, normalizedCandidate?.hostname ?? null)
  const now = new Date()
  const confirmedHotel = result.entityScope === 'hotel' && ['confirmed', 'corrected_redirect'].includes(result.status)
  const hotelSiteControl = result.entityScope === 'hotel'
    ? hotel.siteControlType
    : result.entityScope === 'locality' || result.entityScope === 'other'
      ? 'non_hotel_or_bad_match' as const
      : 'unknown' as const
  await db.update(hotelBlHotels).set({
    sourceEntityScope: result.entityScope,
    sourceEntityType: result.entityType,
    listingSourceUrl: sourceListing,
    listingFinalUrl: listingFetch.url || null,
    listingStatusCode: listingFetch.status,
    listingMatched: result.listingMatched,
    listingAddress: listingIdentity.matchedAddress,
    candidateFinalUrl: candidateFetch.url || null,
    urlValidationStatus: result.status,
    urlValidationConfidence: result.confidence,
    urlValidationReason: result.reason,
    urlValidationEvidence: {
      expected: { hotelName: hotel.hotelName, city: hotel.city, state: hotel.state },
      listing: {
        requestedUrl: sourceListing,
        lookupUrl: currentListing.lookupUrl,
        finalUrl: listingFetch.url || null,
        status: listingFetch.status,
        error: listingFetch.error,
        nameScore: result.listingNameScore,
        matchedAddress: listingIdentity.matchedAddress,
      },
      candidate: {
        requestedUrl: hotel.sourceUrl,
        finalUrl: candidateFetch.url || null,
        status: candidateFetch.status,
        error: candidateFetch.error,
        nameScore: result.candidateNameScore,
        cityMatched: result.cityMatched,
        stateMatched: result.stateMatched,
        prominentNames: unique([candidateIdentity.title, ...candidateIdentity.headings.slice(0, 12), ...candidateIdentity.lodgingNames]).slice(0, 20),
        organizationNames: candidateIdentity.organizationNames.slice(0, 10),
      },
    },
    canonicalPropertyDomain: confirmedHotel ? normalizedCandidate?.hostname ?? null : null,
    siteControlType: hotelSiteControl,
    siteControlConfidence: result.confidence,
    siteControlReason: result.reason,
    needsReview: !confirmedHotel,
    urlValidatedAt: now,
    updatedAt: now,
  }).where(eq(hotelBlHotels.id, hotel.id))

  if (configuration.relationshipId) {
    const nextRelationship = relationshipType(result)
    await db.update(hotelBlRelationships).set({
      relationshipType: nextRelationship,
      entityScope: result.entityScope,
      entityType: result.entityType,
      entityName,
      confidence: result.confidence,
      evidence: [hotel.sourceUrl ?? '', result.reason, sourceListing ?? ''].filter(Boolean),
      urlValidationStatus: result.status,
      urlValidationConfidence: result.confidence,
      urlValidationReason: result.reason,
      candidateFinalUrl: candidateFetch.url || null,
      needsReview: ['mismatch', 'unreachable', 'missing', 'ambiguous'].includes(result.status),
      validatedAt: now,
      updatedAt: now,
    }).where(eq(hotelBlRelationships.id, configuration.relationshipId))
    await db.update(hotelBlOpportunities).set({
      relationshipType: nextRelationship,
      needsReview: !confirmedHotel,
      updatedAt: now,
    }).where(eq(hotelBlOpportunities.relationshipId, configuration.relationshipId))
  }
  return result
}

export async function queueHotelBlUrlValidationJobs(db: Database, runId: number): Promise<number> {
  const hotels = await db
    .select({
      hotelId: hotelBlHotels.id,
      relationshipId: hotelBlRelationships.id,
      domainId: hotelBlRelationships.domainId,
    })
    .from(hotelBlHotels)
    .leftJoin(
      hotelBlRelationships,
      and(eq(hotelBlRelationships.hotelId, hotelBlHotels.id), eq(hotelBlRelationships.source, 'inventory_csv')),
    )
    .where(eq(hotelBlHotels.lastRunId, runId))
  let queued = 0
  for (let index = 0; index < hotels.length; index += 400) {
    const rows = hotels.slice(index, index + 400).map((hotel) => ({
      runId,
      domainId: hotel.domainId,
      stage: 'validate_urls' as const,
      requestKey: `validate-url:${hotel.hotelId}`,
      configuration: { hotelId: hotel.hotelId, relationshipId: hotel.relationshipId },
    }))
    const inserted = await db.insert(hotelBlJobs).values(rows).onConflictDoNothing().returning({ id: hotelBlJobs.id })
    queued += inserted.length
  }
  await db.update(hotelBlRuns).set({
    status: 'validating_urls',
    currentStage: 'validate_urls',
    finishedAt: null,
    updatedAt: new Date(),
  }).where(eq(hotelBlRuns.id, runId))
  return queued
}

async function aggregateValidatedDomains(db: Database, runId: number): Promise<void> {
  await db.execute(sql`
    WITH weighted AS (
      SELECT r.domain_id,
             r.entity_scope,
             r.entity_type,
             r.entity_name,
             r.url_validation_confidence,
             r.id,
             count(*) OVER (PARTITION BY r.domain_id, r.entity_scope, r.entity_type) AS role_count
        FROM hotel_bl_relationships r
        JOIN hotel_bl_hotels h ON h.id = r.hotel_id
       WHERE h.last_run_id = ${runId}
         AND r.validated_at IS NOT NULL
    ), ranked AS (
      SELECT weighted.*,
             row_number() OVER (
               PARTITION BY weighted.domain_id
               ORDER BY
                 CASE weighted.entity_scope WHEN 'hotel' THEN 1 WHEN 'locality' THEN 2 WHEN 'other' THEN 3 ELSE 4 END,
                 weighted.role_count DESC,
                 weighted.url_validation_confidence DESC NULLS LAST,
                 weighted.id
             ) AS position
        FROM weighted
    )
    UPDATE hotel_bl_domains d
       SET entity_scope = ranked.entity_scope,
           entity_type = ranked.entity_type,
           entity_name = COALESCE(ranked.entity_name, d.entity_name),
           site_control_type = CASE
             WHEN ranked.entity_scope IN ('locality', 'other') THEN 'non_hotel_or_bad_match'
             WHEN ranked.entity_scope = 'hotel' AND ranked.entity_type = 'hotel_brand' THEN 'brand_property_page'
             WHEN ranked.entity_scope = 'hotel' AND ranked.entity_type = 'hotel_property' AND d.site_control_type = 'non_hotel_or_bad_match'
               THEN CASE WHEN d.singleton_domain THEN 'independent_property' ELSE 'property_microsite' END
             ELSE d.site_control_type
           END,
           site_control_reason = CASE
             WHEN ranked.entity_scope = 'locality' THEN 'Validated as a locality or destination organization, not a hotel-controlled website.'
             WHEN ranked.entity_scope = 'other' THEN 'Validated as a third-party non-hotel entity.'
             WHEN ranked.entity_scope = 'hotel' AND ranked.entity_type = 'hotel_brand' THEN 'Validated as a hotel-brand website.'
             WHEN ranked.entity_scope = 'hotel' AND ranked.entity_type = 'hotel_property' AND d.site_control_type = 'non_hotel_or_bad_match' THEN 'Validated as a hotel property website.'
             ELSE d.site_control_reason
           END,
           needs_review = ranked.entity_scope = 'unknown',
           updated_at = now()
      FROM ranked
     WHERE ranked.position = 1
       AND d.id = ranked.domain_id
  `)
}

export async function executeHotelBlUrlValidation(
  db: Database,
  runId: number,
  options: { concurrency?: number; limit?: number; force?: boolean } = {},
): Promise<{ processed: number; failed: number; pending: number; results: Record<string, number> }> {
  await queueHotelBlUrlValidationJobs(db, runId)
  if (options.force) {
    await db.update(hotelBlJobs).set({
      status: 'pending',
      attempts: 0,
      claimedAt: null,
      finishedAt: null,
      error: null,
      updatedAt: new Date(),
    }).where(and(
      eq(hotelBlJobs.runId, runId),
      eq(hotelBlJobs.stage, 'validate_urls'),
      sql`${hotelBlJobs.status} in ('complete', 'failed')`,
    ))
  }
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8))
  const limit = pLimit(concurrency)
  let processed = 0
  let failed = 0
  let claimed = 0
  const results: Record<string, number> = {}
  await Promise.all(Array.from({ length: concurrency }, () => limit(async () => {
    while (true) {
      if (options.limit && claimed >= options.limit) return
      claimed += 1
      const job = await claimValidationJob(db, runId)
      if (!job) return
      try {
        const result = await validateJob(db, job)
        processed += 1
        results[result.status] = (results[result.status] ?? 0) + 1
        await completeValidationJob(db, job, {})
      } catch (error) {
        failed += 1
        await completeValidationJob(db, job, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  })))
  await aggregateValidatedDomains(db, runId)
  const scored = await recalculateHotelBlOpportunities(db, runId)
  const [pendingSemrush] = await db.select({ count: sql<number>`count(*)::int` }).from(hotelBlJobs).where(and(
    eq(hotelBlJobs.runId, runId),
    eq(hotelBlJobs.stage, 'semrush_enrichment'),
    eq(hotelBlJobs.status, 'pending'),
  ))
  const [pendingValidation] = await db.select({ count: sql<number>`count(*)::int` }).from(hotelBlJobs).where(and(
    eq(hotelBlJobs.runId, runId),
    eq(hotelBlJobs.stage, 'validate_urls'),
    eq(hotelBlJobs.status, 'pending'),
  ))
  const [validationTotals] = await db.select({
    processed: sql<number>`count(*) filter (where ${hotelBlJobs.status} = 'complete')::int`,
    failed: sql<number>`count(*) filter (where ${hotelBlJobs.status} = 'failed')::int`,
  }).from(hotelBlJobs).where(and(eq(hotelBlJobs.runId, runId), eq(hotelBlJobs.stage, 'validate_urls')))
  processed = validationTotals?.processed ?? processed
  failed = validationTotals?.failed ?? failed
  await db.insert(hotelBlRunEvents).values({
    runId,
    stage: 'validate_urls',
    level: failed > 0 ? 'warning' : 'info',
    message: `Validated ${processed} HotelHotTubs inventory URLs; ${failed} validation jobs failed.`,
    details: { results },
  })
  await db.update(hotelBlRuns).set({
    status: (pendingValidation?.count ?? 0) > 0 ? 'validating_urls' : (pendingSemrush?.count ?? 0) > 0 ? 'waiting_for_semrush' : 'complete',
    currentStage: (pendingValidation?.count ?? 0) > 0 ? 'validate_urls' : (pendingSemrush?.count ?? 0) > 0 ? 'semrush_enrichment' : 'calculate_priorities',
    progress: {
      validatedHotels: processed,
      failedUrlValidations: failed,
      ...Object.fromEntries(Object.entries(results).map(([key, value]) => [`url_${key}`, value])),
      opportunities: scored.opportunities,
    },
    finishedAt: (pendingValidation?.count ?? 0) > 0 ? null : new Date(),
    updatedAt: new Date(),
  }).where(eq(hotelBlRuns.id, runId))
  return { processed, failed, pending: pendingValidation?.count ?? 0, results }
}

interface StoredValidationEvidence {
  listing?: {
    status?: number | null
    nameScore?: number | null
  }
  candidate?: {
    status?: number | null
    finalUrl?: string | null
    cityMatched?: boolean
    stateMatched?: boolean
    prominentNames?: string[]
    organizationNames?: string[]
  }
}

/** Replays deterministic classification against stored HTTP evidence; no URL is fetched. */
export async function reclassifyStoredHotelBlUrlValidations(
  db: Database,
  runId: number,
  options: { status?: string; hotelId?: number } = {},
): Promise<{ processed: number; results: Record<string, number> }> {
  const hotels = await db.select().from(hotelBlHotels).where(and(
    eq(hotelBlHotels.lastRunId, runId),
    isNotNull(hotelBlHotels.urlValidatedAt),
    ...(options.status ? [sql`${hotelBlHotels.urlValidationStatus} = ${options.status}`] : []),
    ...(options.hotelId ? [eq(hotelBlHotels.id, options.hotelId)] : []),
  ))
  const results: Record<string, number> = {}
  const replayLimit = pLimit(12)
  await Promise.all(hotels.map((hotel) => replayLimit(async () => {
    const evidence = hotel.urlValidationEvidence as StoredValidationEvidence
    const prominentNames = evidence.candidate?.prominentNames ?? []
    const organizationNames = evidence.candidate?.organizationNames ?? []
    const candidateText = [
      ...prominentNames,
      ...organizationNames,
      evidence.candidate?.cityMatched ? hotel.city : null,
      evidence.candidate?.stateMatched ? hotel.state : null,
    ].filter((value): value is string => Boolean(value)).join(' ')
    const result = validateHotelBlSourceUrl({
      hotelName: hotel.hotelName,
      city: hotel.city,
      state: hotel.state,
      sourceUrl: hotel.sourceUrl,
      sourceLinkType: hotel.sourceLinkType,
      listingStatus: evidence.listing?.status ?? hotel.listingStatusCode,
      listingProminentNames: hotel.listingMatched ? [hotel.hotelName] : [],
      candidateStatus: evidence.candidate?.status ?? null,
      candidateFinalUrl: evidence.candidate?.finalUrl ?? hotel.candidateFinalUrl,
      candidateTitle: prominentNames[0] ?? null,
      candidateHeadings: prominentNames,
      candidateOrganizationNames: organizationNames,
      candidateText,
    })
    results[result.status] = (results[result.status] ?? 0) + 1
    const normalizedCandidate = normalizeHotelBlUrl(evidence.candidate?.finalUrl ?? hotel.candidateFinalUrl ?? hotel.sourceUrl)
    const confirmedHotel = result.entityScope === 'hotel' && ['confirmed', 'corrected_redirect'].includes(result.status)
    const nextSiteControl = result.entityScope === 'hotel'
      ? result.entityType === 'hotel_brand'
        ? 'brand_property_page' as const
        : confirmedHotel && hotel.siteControlType === 'non_hotel_or_bad_match'
          ? 'independent_property' as const
          : hotel.siteControlType === 'non_hotel_or_bad_match' ? 'unknown' as const : hotel.siteControlType
      : result.entityScope === 'locality' || result.entityScope === 'other'
        ? 'non_hotel_or_bad_match' as const
        : 'unknown' as const
    const now = new Date()
    await db.update(hotelBlHotels).set({
      sourceEntityScope: result.entityScope,
      sourceEntityType: result.entityType,
      urlValidationStatus: result.status,
      urlValidationConfidence: result.confidence,
      urlValidationReason: result.reason,
      urlValidationEvidence: sql`${hotelBlHotels.urlValidationEvidence} || ${JSON.stringify({ replay: {
        classifierVersion: 6,
        replayedAt: now.toISOString(),
        conflictingState: result.conflictingState,
      } })}::jsonb`,
      canonicalPropertyDomain: confirmedHotel ? normalizedCandidate?.hostname ?? null : null,
      siteControlType: nextSiteControl,
      siteControlConfidence: result.confidence,
      siteControlReason: result.reason,
      needsReview: !confirmedHotel,
      updatedAt: now,
    }).where(eq(hotelBlHotels.id, hotel.id))

    const [sourceRelationship] = await db.select().from(hotelBlRelationships).where(and(
      eq(hotelBlRelationships.hotelId, hotel.id),
      eq(hotelBlRelationships.source, 'inventory_csv'),
    )).limit(1)
    if (sourceRelationship) {
      const nextRelationship = relationshipType(result)
      await db.update(hotelBlRelationships).set({
        relationshipType: nextRelationship,
        entityScope: result.entityScope,
        entityType: result.entityType,
        confidence: result.confidence,
        urlValidationStatus: result.status,
        urlValidationConfidence: result.confidence,
        urlValidationReason: result.reason,
        candidateFinalUrl: evidence.candidate?.finalUrl ?? hotel.candidateFinalUrl,
        needsReview: ['mismatch', 'unreachable', 'missing', 'ambiguous'].includes(result.status),
        updatedAt: now,
      }).where(eq(hotelBlRelationships.id, sourceRelationship.id))
      await db.update(hotelBlOpportunities).set({
        relationshipType: nextRelationship,
        needsReview: !confirmedHotel,
        updatedAt: now,
      }).where(eq(hotelBlOpportunities.relationshipId, sourceRelationship.id))
    }
  })))
  await aggregateValidatedDomains(db, runId)
  const scored = await recalculateHotelBlOpportunities(db, runId)
  await db.insert(hotelBlRunEvents).values({
    runId,
    stage: 'validate_urls',
    level: 'info',
    message: `Reclassified ${hotels.length} stored URL validations without additional network calls.`,
    details: { classifierVersion: 6, statusFilter: options.status ?? null, hotelIdFilter: options.hotelId ?? null, results },
  })
  const statusCounts = await db.select({
    status: hotelBlHotels.urlValidationStatus,
    count: sql<number>`count(*)::int`,
  }).from(hotelBlHotels).where(and(
    eq(hotelBlHotels.lastRunId, runId),
    isNotNull(hotelBlHotels.urlValidatedAt),
  )).groupBy(hotelBlHotels.urlValidationStatus)
  const allResults = Object.fromEntries(statusCounts.flatMap((row) => row.status ? [[row.status, row.count]] : []))
  const validatedHotelCount = statusCounts.reduce((sum, row) => sum + row.count, 0)
  const [pendingSemrush] = await db.select({ count: sql<number>`count(*)::int` }).from(hotelBlJobs).where(and(
    eq(hotelBlJobs.runId, runId),
    eq(hotelBlJobs.stage, 'semrush_enrichment'),
    eq(hotelBlJobs.status, 'pending'),
  ))
  await db.update(hotelBlRuns).set({
    status: (pendingSemrush?.count ?? 0) > 0 ? 'waiting_for_semrush' : 'complete',
    currentStage: (pendingSemrush?.count ?? 0) > 0 ? 'semrush_enrichment' : 'calculate_priorities',
    progress: {
      validatedHotels: validatedHotelCount,
      ...Object.fromEntries(Object.entries(allResults).map(([key, value]) => [`url_${key}`, value])),
      opportunities: scored.opportunities,
    },
    finishedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(hotelBlRuns.id, runId))
  return { processed: hotels.length, results }
}
