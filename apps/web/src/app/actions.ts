'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { centsToMicros } from '@rnr/core'
import {
  db,
  enqueueScan,
  findExistingActiveRun,
  getLocalityById,
  liveCallsEnabled,
  removeFromShortlist,
  saveToShortlist,
  searchLocalities,
  setShortlistState,
  type LocalityOption,
} from '@rnr/data'

/**
 * Server actions.
 *
 * The INSERT in enqueueScan IS the enqueue -- `scan_runs` is the queue and the
 * worker is its only consumer. There is no second system to notify and therefore
 * no dispatcher to forget to write, which is what made the previous build's
 * "Start scan" button silently do nothing.
 */

export async function searchLocalitiesAction(query: string): Promise<LocalityOption[]> {
  // Server-side, LIMIT 20, and only the matches cross the wire. Shipping the
  // corpus would be ~570KB, and capping a client-side list made 168 of 12,673
  // cities selectable last time -- including not Kenosha.
  return searchLocalities(db(), query, { limit: 20 })
}

export interface StartScanResult {
  ok: boolean
  runId?: number
  error?: string
}

export async function startScanAction(localityId: number): Promise<StartScanResult> {
  const database = db()
  const locality = await getLocalityById(database, localityId)
  if (!locality) return { ok: false, error: 'Locality not found.' }

  if (locality.providerLocationCode === null) {
    // Stated plainly rather than silently refusing. An unresolved locality cannot
    // be scanned without widening to a broader location code, which returns a
    // well-formed SERP for the wrong place.
    return {
      ok: false,
      error:
        `${locality.name}, ${locality.stateCode} has no provider location code, so it cannot be scanned. ` +
        (locality.unmatchedReason ?? ''),
    }
  }

  const existing = await findExistingActiveRun(database, localityId)
  if (existing) return { ok: true, runId: existing.id }

  const capCents = Number(process.env['SCAN_BUDGET_CAP_CENTS'] ?? '200')
  const run = await enqueueScan(database, {
    localityId,
    budgetCapMicros: centsToMicros(Number.isFinite(capCents) ? capCents : 200),
    // Recorded per run so a fixture scan keeps announcing itself in the UI long
    // after the env var changes.
    usedFixtures: !liveCallsEnabled(),
  })

  revalidatePath('/')
  return { ok: true, runId: run.id }
}

export async function saveToShortlistAction(scanTargetId: number, runId: number): Promise<void> {
  await saveToShortlist(db(), scanTargetId)
  revalidatePath(`/scout/scans/${runId}`)
  revalidatePath('/shortlist')
  revalidatePath('/portfolio')
}

export async function removeFromShortlistAction(itemId: number): Promise<void> {
  await removeFromShortlist(db(), itemId)
  revalidatePath('/shortlist')
  revalidatePath('/portfolio')
}

export async function setShortlistStateAction(
  itemId: number,
  state: 'watching' | 'building' | 'ranking' | 'rented',
): Promise<void> {
  await setShortlistState(db(), itemId, state)
  revalidatePath('/shortlist')
  revalidatePath('/portfolio')
}

export async function goToScan(runId: number): Promise<void> {
  redirect(`/scout/scans/${runId}`)
}
