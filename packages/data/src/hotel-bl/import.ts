import 'server-only'
import { parse } from 'csv-parse/sync'
import { eq, inArray, sql } from 'drizzle-orm'
import {
  classifyHotelBlSiteControl,
  hotelBlBrandControlSegment,
  hotelBlSourceRelationshipType,
  hotelBlSourceKey,
  normalizeHotelBlUrl,
  type HotelBlSiteControlType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hotelBlDomains,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlRelationships,
  hotelBlRunEvents,
  hotelBlRuns,
} from '../schema.js'
import { recalculateHotelBlOpportunities } from './scoring.js'

const HEADER_ALIASES = {
  hotelName: ['hotel_name', 'hotel', 'property_name', 'property', 'name', 'title'],
  city: ['city', 'locality', 'town'],
  state: ['state', 'state_code', 'province', 'region'],
  country: ['country', 'country_code'],
  existingHhtUrl: ['existing_hht_url', 'hht_url', 'hotelhottubs_url', 'hotel_hot_tubs_url', 'listing_url'],
  sourceUrl: ['source_url', 'site_url', 'direct_link', 'external_url', 'hotel_website', 'website', 'target_url', 'url', 'final_url', 'host'],
  sourceLinkType: ['source_link_type', 'link_type', 'classification', 'type'],
  brandName: ['brand_name', 'brand', 'chain'],
} as const

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function first(row: Record<string, string>, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = row[alias]?.trim()
    if (value) return value
  }
  return null
}

function chunks<T>(values: T[], size = 350): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

export interface HotelBlInventoryRow {
  hotelName: string
  city: string | null
  state: string | null
  country: string | null
  existingHhtUrl: string | null
  sourceUrl: string | null
  sourceLinkType: string | null
  brandName: string | null
  rawSource: Record<string, string>
}

export interface HotelBlInventoryParseResult {
  rows: HotelBlInventoryRow[]
  skippedRows: number
  duplicateRows: number
  headers: string[]
}

export function parseHotelBlInventoryCsv(csv: string): HotelBlInventoryParseResult {
  const parsed = parse(csv, {
    bom: true,
    columns: (headers: string[]) => headers.map(normalizeHeader),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>
  const headers = parsed[0] ? Object.keys(parsed[0]) : []
  const deduped = new Map<string, HotelBlInventoryRow>()
  let skippedRows = 0
  let duplicateRows = 0
  for (const rawSource of parsed) {
    const hotelName = first(rawSource, HEADER_ALIASES.hotelName)
    if (!hotelName) {
      skippedRows += 1
      continue
    }
    const city = first(rawSource, HEADER_ALIASES.city)
    const state = first(rawSource, HEADER_ALIASES.state)
    const sourceUrlRaw = first(rawSource, HEADER_ALIASES.sourceUrl)
    const sourceUrl = normalizeHotelBlUrl(sourceUrlRaw)?.url ?? sourceUrlRaw
    const row: HotelBlInventoryRow = {
      hotelName,
      city,
      state,
      country: first(rawSource, HEADER_ALIASES.country),
      existingHhtUrl: normalizeHotelBlUrl(first(rawSource, HEADER_ALIASES.existingHhtUrl))?.url ?? first(rawSource, HEADER_ALIASES.existingHhtUrl),
      sourceUrl,
      sourceLinkType: first(rawSource, HEADER_ALIASES.sourceLinkType),
      brandName: first(rawSource, HEADER_ALIASES.brandName),
      rawSource,
    }
    const key = hotelBlSourceKey({ hotelName, city, state, sourceUrl })
    if (deduped.has(key)) duplicateRows += 1
    else deduped.set(key, row)
  }
  return { rows: [...deduped.values()], skippedRows, duplicateRows, headers }
}

export interface ImportHotelBlInventoryResult {
  runId: number
  hotels: number
  domains: number
  relationships: number
  duplicateRows: number
  skippedRows: number
  crawlJobs: number
}

export async function importHotelBlInventory(
  db: Database,
  input: { csv: string; filename?: string | null; runName?: string | null },
): Promise<ImportHotelBlInventoryResult> {
  const parsed = parseHotelBlInventoryCsv(input.csv)
  if (parsed.rows.length === 0) throw new Error('The CSV contains no rows with a recognizable hotel name.')

  const [run] = await db
    .insert(hotelBlRuns)
    .values({
      name: input.runName?.trim() || `Hotel inventory ${new Date().toISOString().slice(0, 10)}`,
      sourceFilename: input.filename?.trim() || null,
      status: 'importing',
      currentStage: 'import',
      startedAt: new Date(),
      configuration: {
        crawl: { concurrency: 5, timeoutMs: 15_000, maxAttempts: 3, maxPagesPerDomain: 10, maxDepth: 1 },
        semrushFeasibilityThreshold: 50,
      },
      progress: { inputRows: parsed.rows.length, skippedRows: parsed.skippedRows, duplicateRows: parsed.duplicateRows },
    })
    .returning()
  if (!run) throw new Error('Could not create the Hotel Backlink Scout run.')

  const domainSeedByHost = new Map<string, { rootDomain: string; sourceUrls: string[]; hotelNames: string[]; hotelKeys: string[] }>()
  for (const row of parsed.rows) {
    const normalized = normalizeHotelBlUrl(row.sourceUrl)
    if (!normalized) continue
    const seed = domainSeedByHost.get(normalized.hostname) ?? {
      rootDomain: normalized.rootDomain,
      sourceUrls: [],
      hotelNames: [],
      hotelKeys: [],
    }
    if (!seed.sourceUrls.includes(normalized.url)) seed.sourceUrls.push(normalized.url)
    if (!seed.hotelNames.includes(row.hotelName)) seed.hotelNames.push(row.hotelName)
    const hotelKey = hotelBlSourceKey({ hotelName: row.hotelName, city: row.city, state: row.state, sourceUrl: row.sourceUrl })
    if (!seed.hotelKeys.includes(hotelKey)) seed.hotelKeys.push(hotelKey)
    domainSeedByHost.set(normalized.hostname, seed)
  }

  const classifications = new Map<string, ReturnType<typeof classifyHotelBlSiteControl>>()
  for (const row of parsed.rows) {
    const normalized = normalizeHotelBlUrl(row.sourceUrl)
    if (!normalized || classifications.has(normalized.hostname)) continue
    const seed = domainSeedByHost.get(normalized.hostname)!
    classifications.set(
      normalized.hostname,
      classifyHotelBlSiteControl({
        hotelName: row.hotelName,
        hostname: normalized.hostname,
        rootDomain: normalized.rootDomain,
        sourceUrl: normalized.url,
        sourceLinkType: row.sourceLinkType,
        hotelCount: seed.hotelKeys.length,
      }),
    )
  }

  const domainRows = [...domainSeedByHost.entries()].map(([domain, seed]) => {
    const classification = classifications.get(domain)!
    return {
      lastRunId: run.id,
      domain,
      rootDomain: seed.rootDomain,
      canonicalUrl: `https://${domain}/`,
      entityName: classification.brandName ?? (seed.hotelKeys.length === 1 ? seed.hotelNames[0]! : null),
      entityType: classification.siteControlType === 'management_company_site' ? 'management_company' : classification.centralizedBrand ? 'brand' : 'property',
      siteControlType: classification.siteControlType,
      siteControlConfidence: classification.confidence,
      siteControlReason: classification.reason,
      hotelCount: seed.hotelKeys.length,
      singletonDomain: seed.hotelKeys.length === 1,
      centralizedBrand: classification.centralizedBrand,
      needsReview: classification.confidence < 0.6,
      updatedAt: new Date(),
    }
  })
  const domainIds = new Map<string, number>()
  for (const batch of chunks(domainRows)) {
    const returned = await db
      .insert(hotelBlDomains)
      .values(batch)
      .onConflictDoUpdate({
        target: hotelBlDomains.domain,
        set: {
          lastRunId: run.id,
          rootDomain: sql`excluded.root_domain`,
          canonicalUrl: sql`excluded.canonical_url`,
          hotelCount: sql`excluded.hotel_count`,
          singletonDomain: sql`excluded.singleton_domain`,
          entityName: sql`excluded.entity_name`,
          entityType: sql`excluded.entity_type`,
          siteControlType: sql`excluded.site_control_type`,
          siteControlConfidence: sql`excluded.site_control_confidence`,
          siteControlReason: sql`excluded.site_control_reason`,
          centralizedBrand: sql`excluded.centralized_brand`,
          needsReview: sql`excluded.needs_review`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: hotelBlDomains.id, domain: hotelBlDomains.domain })
    for (const domain of returned) domainIds.set(domain.domain, domain.id)
  }

  const hotelRows = parsed.rows.map((row) => {
    const normalized = normalizeHotelBlUrl(row.sourceUrl)
    const classification = normalized
      ? classifications.get(normalized.hostname)!
      : classifyHotelBlSiteControl({ hotelName: row.hotelName, hostname: null, rootDomain: null, sourceUrl: null, sourceLinkType: row.sourceLinkType, hotelCount: 0 })
    return {
      lastRunId: run.id,
      sourceKey: hotelBlSourceKey({ hotelName: row.hotelName, city: row.city, state: row.state, sourceUrl: row.sourceUrl }),
      hotelName: row.hotelName,
      city: row.city,
      state: row.state,
      country: row.country,
      existingHhtUrl: row.existingHhtUrl,
      sourceUrl: normalized?.url ?? row.sourceUrl,
      sourceLinkType: row.sourceLinkType,
      canonicalPropertyDomain: normalized?.hostname ?? null,
      brandName: row.brandName ?? classification.brandName,
      siteControlType: classification.siteControlType,
      siteControlConfidence: classification.confidence,
      siteControlReason: classification.reason,
      brandControlSegment: hotelBlBrandControlSegment({
        sourceLinkType: row.sourceLinkType,
        siteControlType: classification.siteControlType,
        centralizedBrand: classification.centralizedBrand,
      }),
      rawSource: row.rawSource,
      needsReview: !normalized || classification.confidence < 0.6,
      updatedAt: new Date(),
    }
  })
  const hotelIds = new Map<string, number>()
  for (const batch of chunks(hotelRows)) {
    const returned = await db
      .insert(hotelBlHotels)
      .values(batch)
      .onConflictDoUpdate({
        target: hotelBlHotels.sourceKey,
        set: {
          lastRunId: run.id,
          hotelName: sql`excluded.hotel_name`,
          city: sql`excluded.city`,
          state: sql`excluded.state`,
          country: sql`excluded.country`,
          existingHhtUrl: sql`excluded.existing_hht_url`,
          sourceUrl: sql`excluded.source_url`,
          sourceLinkType: sql`excluded.source_link_type`,
          canonicalPropertyDomain: sql`excluded.canonical_property_domain`,
          brandName: sql`coalesce(excluded.brand_name, ${hotelBlHotels.brandName})`,
          brandControlSegment: sql`excluded.brand_control_segment`,
          siteControlType: sql`excluded.site_control_type`,
          siteControlConfidence: sql`excluded.site_control_confidence`,
          siteControlReason: sql`excluded.site_control_reason`,
          rawSource: sql`excluded.raw_source`,
          needsReview: sql`excluded.needs_review`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: hotelBlHotels.id, sourceKey: hotelBlHotels.sourceKey })
    for (const hotel of returned) hotelIds.set(hotel.sourceKey, hotel.id)
  }

  const relationships: Array<typeof hotelBlRelationships.$inferInsert> = []
  for (const row of parsed.rows) {
    const normalized = normalizeHotelBlUrl(row.sourceUrl)
    const sourceKey = hotelBlSourceKey({ hotelName: row.hotelName, city: row.city, state: row.state, sourceUrl: row.sourceUrl })
    const hotelId = hotelIds.get(sourceKey)
    if (!hotelId) continue
    const classification = normalized ? classifications.get(normalized.hostname) : undefined
    if (!normalized) continue
    relationships.push({
      hotelId,
      domainId: domainIds.get(normalized.hostname)!,
      relationshipType: hotelBlSourceRelationshipType({
        sourceLinkType: row.sourceLinkType,
        siteControlType: classification?.siteControlType ?? 'unknown',
        centralizedBrand: classification?.centralizedBrand ?? false,
      }),
      confidence: classification?.confidence ?? 0.5,
      source: 'inventory_csv',
      sourceUrl: normalized.url,
      evidence: [normalized.url, classification?.reason ?? 'Imported property website'],
      needsReview: (classification?.confidence ?? 0) < 0.6,
      updatedAt: new Date(),
    })
  }
  for (const batch of chunks(relationships)) {
    await db
      .insert(hotelBlRelationships)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          hotelBlRelationships.hotelId,
          hotelBlRelationships.domainId,
          hotelBlRelationships.relationshipType,
        ],
        set: {
          confidence: sql`excluded.confidence`,
          source: sql`excluded.source`,
          sourceUrl: sql`excluded.source_url`,
          evidence: sql`excluded.evidence`,
          needsReview: sql`excluded.needs_review`,
          updatedAt: new Date(),
        },
      })
  }

  const crawlJobRows: Array<typeof hotelBlJobs.$inferInsert> = []
  for (const [domain, seed] of domainSeedByHost) {
    const domainId = domainIds.get(domain)!
    const classification = classifications.get(domain)!
    crawlJobRows.push({
      runId: run.id,
      domainId,
      stage: 'crawl_homepage',
      requestKey: `crawl:${domainId}`,
      configuration: {
        seedUrls: classification.centralizedBrand ? seed.sourceUrls.slice(0, 3) : [seed.sourceUrls[0]],
        centralizedBrand: classification.centralizedBrand,
      },
    })
  }
  let crawlJobs = 0
  for (const batch of chunks(crawlJobRows)) {
    const inserted = await db
      .insert(hotelBlJobs)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: hotelBlJobs.id })
    crawlJobs += inserted.length
  }

  await recalculateHotelBlOpportunities(db, run.id)
  await db.insert(hotelBlRunEvents).values({
    runId: run.id,
    stage: 'import',
    message: `Imported ${hotelRows.length} hotels across ${domainRows.length} canonical domains.`,
    details: { skippedRows: parsed.skippedRows, duplicateRows: parsed.duplicateRows, headers: parsed.headers },
  })
  await db
    .update(hotelBlRuns)
    .set({
      status: 'ready',
      currentStage: 'crawl_homepage',
      progress: {
        hotels: hotelRows.length,
        domains: domainRows.length,
        relationships: relationships.length,
        crawlJobs,
        skippedRows: parsed.skippedRows,
        duplicateRows: parsed.duplicateRows,
      },
      updatedAt: new Date(),
    })
    .where(eq(hotelBlRuns.id, run.id))

  return {
    runId: run.id,
    hotels: hotelRows.length,
    domains: domainRows.length,
    relationships: relationships.length,
    duplicateRows: parsed.duplicateRows,
    skippedRows: parsed.skippedRows,
    crawlJobs,
  }
}

export async function latestHotelBlRun(db: Database) {
  const [run] = await db.select().from(hotelBlRuns).orderBy(sql`${hotelBlRuns.createdAt} desc`).limit(1)
  return run ?? null
}
