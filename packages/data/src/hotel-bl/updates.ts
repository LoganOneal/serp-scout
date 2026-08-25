import 'server-only'
import { eq } from 'drizzle-orm'
import type {
  HotelBlContentType,
  HotelBlOpportunityStatus,
  HotelBlRelationshipType,
  HotelBlSiteControlType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  hotelBlDomains,
  hotelBlHotels,
  hotelBlOpportunities,
  hotelBlRelationships,
  hotelBlRuns,
} from '../schema.js'
import { recalculateHotelBlOpportunities } from './scoring.js'

export async function failHotelBlRun(db: Database, runId: number, error: string): Promise<void> {
  await db.update(hotelBlRuns).set({ status: 'failed', error, updatedAt: new Date() }).where(eq(hotelBlRuns.id, runId))
}

export async function updateHotelBlOpportunity(
  db: Database,
  opportunityId: number,
  patch: { status?: HotelBlOpportunityStatus; manualRecommendedContentType?: HotelBlContentType | null },
): Promise<void> {
  const [updated] = await db
    .update(hotelBlOpportunities)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(hotelBlOpportunities.id, opportunityId))
    .returning({ hotelId: hotelBlOpportunities.hotelId })
  if (!updated || patch.manualRecommendedContentType === undefined) return
  const [hotel] = await db
    .select({ runId: hotelBlHotels.lastRunId })
    .from(hotelBlHotels)
    .where(eq(hotelBlHotels.id, updated.hotelId))
    .limit(1)
  if (hotel?.runId) await recalculateHotelBlOpportunities(db, hotel.runId)
}

export async function overrideHotelBlClassification(
  db: Database,
  input: { entity: 'hotel' | 'domain'; id: number; classification: HotelBlSiteControlType },
): Promise<void> {
  if (input.entity === 'hotel') {
    await db.update(hotelBlHotels).set({ manualSiteControlType: input.classification, needsReview: false, updatedAt: new Date() }).where(eq(hotelBlHotels.id, input.id))
    return
  }
  const [domain] = await db.update(hotelBlDomains).set({ manualSiteControlType: input.classification, needsReview: false, updatedAt: new Date() }).where(eq(hotelBlDomains.id, input.id)).returning({ runId: hotelBlDomains.lastRunId })
  if (domain?.runId) await recalculateHotelBlOpportunities(db, domain.runId)
}

export async function overrideHotelBlRelationship(
  db: Database,
  relationshipId: number,
  relationship: HotelBlRelationshipType,
): Promise<void> {
  const [updated] = await db.update(hotelBlRelationships).set({ manualRelationshipType: relationship, needsReview: false, updatedAt: new Date() }).where(eq(hotelBlRelationships.id, relationshipId)).returning({ hotelId: hotelBlRelationships.hotelId })
  if (!updated) return
  const [hotel] = await db.select({ runId: hotelBlHotels.lastRunId }).from(hotelBlHotels).where(eq(hotelBlHotels.id, updated.hotelId)).limit(1)
  if (hotel?.runId) await recalculateHotelBlOpportunities(db, hotel.runId)
}
