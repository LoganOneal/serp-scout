import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { createDb, type Database } from '../db.js'
import {
  hotelBlContentOpportunities,
  hotelBlDomains,
  hotelBlHotels,
  hotelBlJobs,
  hotelBlOpportunities,
  hotelBlRelationships,
  hotelBlRuns,
} from '../schema.js'
import { resetSchema } from '../test-support/schema-sql.js'
import { importHotelBlInventory } from './import.js'

// Deliberately require a feature-specific throwaway target. Falling back to
// DATABASE_URL or the shared E2E_DATABASE_URL would let this suite create/drop
// its isolated schema on an unrelated database.
const DB_URL = process.env['HOTEL_BL_E2E_DATABASE_URL']
const SCHEMA = 'rnr_hotel_bl_e2e'

let db: Database
let raw: postgres.Sql

describe.skipIf(!DB_URL)('Hotel Backlink Scout inventory e2e ($0, no network)', () => {
  beforeAll(async () => {
    const admin = postgres(DB_URL!, { max: 1, onnotice: () => {} })
    await resetSchema(admin, SCHEMA)
    await admin.end({ timeout: 5 })
    const created = createDb(DB_URL!, { searchPath: SCHEMA })
    db = created.db
    raw = created.sql
  })

  afterAll(async () => {
    if (raw) await raw.end({ timeout: 5 })
    const admin = postgres(DB_URL!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
    await admin.end({ timeout: 5 })
  })

  it('applies the real migration and imports a representative inventory idempotently', async () => {
    const csv = `Hotel Name,City,State,Country,HHT URL,Direct Link,Link Type,Notes
Cedar House Hotel,Austin,TX,US,https://hotelhottubs.com/cedar,https://cedarhousehotel.com/,Direct,independent
Cedar House Hotel,Austin,TX,US,https://hotelhottubs.com/cedar,https://cedarhousehotel.com/?utm_source=duplicate,Direct,duplicate
Hilton Austin,Austin,TX,US,,https://hilton.com/en/hotels/austin,Brand,central
Hilton Dallas,Dallas,TX,US,,https://hilton.com/en/hotels/dallas,Brand,central
Broken Hotel,Houston,TX,US,,not a url,Unknown,manual review`
    const result = await importHotelBlInventory(db, { csv, filename: 'sample.csv', runName: 'Sample' })
    expect(result).toMatchObject({
      hotels: 4,
      domains: 2,
      relationships: 3,
      duplicateRows: 1,
      skippedRows: 0,
      crawlJobs: 2,
    })

    const [run] = await db.select().from(hotelBlRuns).where(eq(hotelBlRuns.id, result.runId))
    expect(run).toMatchObject({ status: 'ready', currentStage: 'crawl_homepage' })

    const hotels = await db.select().from(hotelBlHotels).where(eq(hotelBlHotels.lastRunId, result.runId))
    expect(hotels).toHaveLength(4)
    expect(hotels.find((hotel) => hotel.hotelName === 'Cedar House Hotel')).toMatchObject({
      siteControlType: 'independent_property',
      rawSource: expect.objectContaining({ notes: 'independent' }),
    })
    expect(hotels.find((hotel) => hotel.hotelName === 'Broken Hotel')).toMatchObject({ needsReview: true })

    const domains = await db.select().from(hotelBlDomains).where(eq(hotelBlDomains.lastRunId, result.runId))
    expect(domains.find((domain) => domain.domain === 'hilton.com')).toMatchObject({
      hotelCount: 2,
      centralizedBrand: true,
      siteControlType: 'brand_property_page',
    })

    const [relationshipCount] = await db.select({ value: sql<number>`count(*)::int` }).from(hotelBlRelationships)
    const [opportunityCount] = await db.select({ value: sql<number>`count(*)::int` }).from(hotelBlOpportunities)
    const [jobCount] = await db.select({ value: sql<number>`count(*)::int` }).from(hotelBlJobs)
    expect(relationshipCount?.value).toBe(3)
    expect(opportunityCount?.value).toBe(3)
    expect(jobCount?.value).toBe(2)

    const content = await db.select().from(hotelBlContentOpportunities).where(eq(hotelBlContentOpportunities.runId, result.runId))
    expect(content.some((item) => item.contentType === 'city_roundup' && item.geography === 'Austin, TX')).toBe(true)
    expect(content.some((item) => item.contentType === 'state_roundup' && item.geography === 'TX')).toBe(true)
  })
})
