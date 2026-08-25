'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  HOTEL_BL_CONTENT_TYPES,
  HOTEL_BL_OPPORTUNITY_STATUSES,
  HOTEL_BL_RELATIONSHIP_TYPES,
  HOTEL_BL_SITE_CONTROL_TYPES,
  type HotelBlContentType,
  type HotelBlOpportunityStatus,
  type HotelBlRelationshipType,
  type HotelBlSiteControlType,
} from '@rnr/core'
import {
  db,
  failHotelBlRun,
  importHotelBlInventory,
  overrideHotelBlClassification,
  overrideHotelBlRelationship,
  retryFailedHotelBlJobs,
  updateHotelBlOpportunity,
} from '@rnr/data'

function positiveId(formData: FormData, name: string): number {
  const value = Number(formData.get(name))
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}

function messageUrl(view: string, message: string, tone: 'success' | 'error' = 'success'): string {
  const params = new URLSearchParams({ view, message, tone })
  return `/hotel-backlink-scout?${params}`
}

export async function importHotelBlInventoryAction(formData: FormData): Promise<never> {
  const file = formData.get('inventory')
  let nextUrl: string
  if (!(file instanceof File) || file.size === 0) {
    nextUrl = messageUrl('overview', 'Choose a non-empty CSV inventory file.', 'error')
  } else if (file.size > 9_000_000) {
    nextUrl = messageUrl('overview', 'The CSV exceeds the 9 MB upload limit.', 'error')
  } else {
    try {
      const result = await importHotelBlInventory(db(), {
        csv: await file.text(),
        filename: file.name,
        runName: String(formData.get('runName') ?? '').trim() || null,
      })
      nextUrl = messageUrl(
        'runs',
        `Imported ${result.hotels} hotels across ${result.domains} domains; ${result.crawlJobs} crawl jobs are ready.`,
      )
    } catch (error) {
      nextUrl = messageUrl('overview', error instanceof Error ? error.message : 'Inventory import failed.', 'error')
    }
  }
  revalidatePath('/hotel-backlink-scout')
  redirect(nextUrl)
}

export async function startHotelBlRunAction(formData: FormData): Promise<never> {
  const runId = positiveId(formData, 'runId')
  let nextUrl: string
  if (process.env['TRIGGER_SECRET_KEY']?.trim()) {
    try {
      const { hotelBacklinkScout } = await import('@/trigger/hotel-backlink-scout')
      await hotelBacklinkScout.trigger({ runId }, { idempotencyKey: `hotel-backlink-scout-run-${runId}` })
      nextUrl = messageUrl('runs', `Run #${runId} started in Trigger.dev. Reload to follow progress.`)
    } catch (error) {
      await failHotelBlRun(db(), runId, `Trigger.dev kickoff failed: ${(error as Error).message}`)
      nextUrl = messageUrl('runs', `Could not start run #${runId}: ${(error as Error).message}`, 'error')
    }
  } else {
    nextUrl = messageUrl(
      'runs',
      `Background execution is not configured. Run “pnpm hotel:bl run --run-id=${runId}” in an operator shell; progress remains durable in this page.`,
      'error',
    )
  }
  revalidatePath('/hotel-backlink-scout')
  redirect(nextUrl)
}

export async function retryHotelBlRunAction(formData: FormData): Promise<never> {
  const runId = positiveId(formData, 'runId')
  const retries = await retryFailedHotelBlJobs(db(), runId)
  revalidatePath('/hotel-backlink-scout')
  redirect(messageUrl('runs', `${retries} failed domain job${retries === 1 ? '' : 's'} returned to the queue.`))
}

export async function updateHotelBlOpportunityAction(formData: FormData): Promise<void> {
  const opportunityId = positiveId(formData, 'opportunityId')
  const status = String(formData.get('status') ?? '')
  const treatment = String(formData.get('treatment') ?? '')
  const patch: {
    status?: HotelBlOpportunityStatus
    manualRecommendedContentType?: HotelBlContentType | null
  } = {}
  if (status) {
    if (!HOTEL_BL_OPPORTUNITY_STATUSES.includes(status as HotelBlOpportunityStatus)) throw new Error('Invalid opportunity status.')
    patch.status = status as HotelBlOpportunityStatus
  }
  if (treatment) {
    if (!HOTEL_BL_CONTENT_TYPES.includes(treatment as HotelBlContentType)) throw new Error('Invalid content treatment.')
    patch.manualRecommendedContentType = treatment as HotelBlContentType
  }
  await updateHotelBlOpportunity(db(), opportunityId, patch)
  revalidatePath('/hotel-backlink-scout', 'layout')
}

export async function updateHotelBlClassificationAction(formData: FormData): Promise<void> {
  const entity = String(formData.get('entity'))
  const id = positiveId(formData, 'id')
  const classification = String(formData.get('classification'))
  if (!HOTEL_BL_SITE_CONTROL_TYPES.includes(classification as HotelBlSiteControlType)) throw new Error('Invalid site-control classification.')
  const database = db()
  if (entity === 'hotel') {
    await overrideHotelBlClassification(database, { entity: 'hotel', id, classification: classification as HotelBlSiteControlType })
  } else if (entity === 'domain') {
    await overrideHotelBlClassification(database, { entity: 'domain', id, classification: classification as HotelBlSiteControlType })
  } else {
    throw new Error('Unknown classification target.')
  }
  revalidatePath('/hotel-backlink-scout', 'layout')
}

export async function updateHotelBlRelationshipAction(formData: FormData): Promise<void> {
  const id = positiveId(formData, 'relationshipId')
  const relationship = String(formData.get('relationship'))
  if (!HOTEL_BL_RELATIONSHIP_TYPES.includes(relationship as HotelBlRelationshipType)) throw new Error('Invalid relationship type.')
  await overrideHotelBlRelationship(db(), id, relationship as HotelBlRelationshipType)
  revalidatePath('/hotel-backlink-scout', 'layout')
}
