import 'server-only'
import { eq, sql } from 'drizzle-orm'
import {
  dueOutcomeChecks,
  hitRateByBand,
  isOrderingSound,
  normaliseDomain,
  type BandStats,
  type OrderingCheck,
  type OutcomeDayOffset,
  type OutcomeRow,
} from '@rnr/core'
import type { Database } from './db.js'
import { localities, niches, outcomes, shortlistItems } from './schema.js'
import type { Providers } from './providers/index.js'
import { BudgetGuard } from './budget.js'

/**
 * Outcome tracking: the loop that turns priors into measurements.
 */

/**
 * Re-check where a built site actually ranks.
 *
 * ==================== DELIBERATELY NOT CACHE-FIRST ====================
 * Every other SERP read in this codebase goes through readSerpCache. This one
 * must not. The cached snapshot for `kenosha tree service` was taken when the
 * locality was scanned -- which is BEFORE the site existed. Serving it here would
 * record every build as never having ranked, at every checkpoint, forever, and
 * the calibration panel would confidently report a 0% hit rate for every band.
 *
 * That failure is completely silent: the numbers look plausible, the pipeline
 * runs, and the only symptom is a model that appears never to work.
 * ======================================================================
 */
export async function checkOutcomeRank(args: {
  db: Database
  providers: Providers
  shortlistItemId: number
  dayOffset: OutcomeDayOffset
}): Promise<{ position: number | null; costMicros: bigint }> {
  const { db, providers, shortlistItemId, dayOffset } = args

  const [item] = await db
    .select({
      id: shortlistItems.id,
      emdDomain: shortlistItems.emdDomain,
      localityName: localities.name,
      locationCode: localities.providerLocationCode,
      keywordNoun: niches.keywordNoun,
      emdToken: niches.emdToken,
      domainStems: niches.domainStems,
    })
    .from(shortlistItems)
    .innerJoin(localities, eq(shortlistItems.localityId, localities.id))
    .innerJoin(niches, eq(shortlistItems.nicheId, niches.id))
    .where(eq(shortlistItems.id, shortlistItemId))

  if (!item) throw new Error(`Shortlist item ${shortlistItemId} not found`)
  if (item.locationCode === null) {
    throw new Error(`Locality for shortlist item ${shortlistItemId} has no provider location code`)
  }

  const keyword = `${item.localityName.toLowerCase()} ${item.keywordNoun}`
  const target = normaliseDomain(item.emdDomain)

  // Straight to the provider. No cache read.
  const { snapshot, costMicros } = await providers.fetchOrganicSerp({
    keyword,
    locationCode: item.locationCode,
    localityName: item.localityName,
    stateCode: '',
    nicheNoun: item.keywordNoun,
    nicheEmdToken: item.emdToken,
  })

  const hit = snapshot.items.find((i) => normaliseDomain(i.domain) === target)
  // null = CHECKED AND NOWHERE. The row's existence is the measurement.
  const position = hit?.position ?? null

  await db
    .insert(outcomes)
    .values({
      shortlistItemId,
      dayOffset,
      checkedAt: new Date(),
      position,
      keyword,
      locationCode: item.locationCode,
      costMicros,
    })
    .onConflictDoUpdate({
      target: [outcomes.shortlistItemId, outcomes.dayOffset],
      set: { position, checkedAt: new Date(), costMicros },
    })

  return { position, costMicros }
}

/** Which checks are due across every building/ranking/rented shortlist item. */
export async function findDueChecks(
  db: Database,
  now = new Date(),
): Promise<Array<{ shortlistItemId: number; dayOffset: OutcomeDayOffset; emdDomain: string }>> {
  const rows = await db
    .select({
      id: shortlistItems.id,
      emdDomain: shortlistItems.emdDomain,
      buildStartedAt: shortlistItems.buildStartedAt,
      state: shortlistItems.state,
    })
    .from(shortlistItems)

  const existing = await db
    .select({ itemId: outcomes.shortlistItemId, dayOffset: outcomes.dayOffset })
    .from(outcomes)
  const doneByItem = new Map<number, OutcomeDayOffset[]>()
  for (const e of existing) {
    const list = doneByItem.get(e.itemId) ?? []
    list.push(e.dayOffset as OutcomeDayOffset)
    doneByItem.set(e.itemId, list)
  }

  const out: Array<{ shortlistItemId: number; dayOffset: OutcomeDayOffset; emdDomain: string }> = []
  for (const r of rows) {
    // Only builds that actually started have a clock to measure against.
    if (!r.buildStartedAt || r.state === 'watching') continue
    for (const dayOffset of dueOutcomeChecks({
      buildStartedAt: r.buildStartedAt,
      now,
      alreadyChecked: doneByItem.get(r.id) ?? [],
    })) {
      out.push({ shortlistItemId: r.id, dayOffset, emdDomain: r.emdDomain })
    }
  }
  return out
}

/** Every outcome row joined to the FROZEN verdict, for the calibration panel. */
export async function loadOutcomeRows(db: Database): Promise<OutcomeRow[]> {
  const rows = await db
    .select({
      shortlistItemId: outcomes.shortlistItemId,
      dayOffset: outcomes.dayOffset,
      checkedAt: outcomes.checkedAt,
      position: outcomes.position,
      // FROZEN at save time. Joining to a live scan_targets score instead would
      // compare today's thresholds against yesterday's build, and every band
      // would validate itself.
      verdictAtSave: shortlistItems.verdictAtSave,
      difficultyAtSave: shortlistItems.difficultyAtSave,
    })
    .from(outcomes)
    .innerJoin(shortlistItems, eq(outcomes.shortlistItemId, shortlistItems.id))

  return rows.map((r) => ({
    shortlistItemId: r.shortlistItemId,
    dayOffset: r.dayOffset as OutcomeDayOffset,
    checkedAt: r.checkedAt.toISOString(),
    position: r.position,
    verdictAtSave: r.verdictAtSave,
    difficultyAtSave: r.difficultyAtSave,
  }))
}

export interface CalibrationReport {
  bands: BandStats[]
  ordering: OrderingCheck
  totalChecks: number
  buildsWithChecks: number
  /** True until there is enough data for the panel to claim anything. */
  isPrior: boolean
}

export async function buildCalibrationReport(db: Database): Promise<CalibrationReport> {
  const rows = await loadOutcomeRows(db)
  const bands = hitRateByBand(rows)
  const ordering = isOrderingSound(bands)
  const buildsWithChecks = new Set(rows.map((r) => r.shortlistItemId)).size
  return {
    bands,
    ordering,
    totalChecks: rows.length,
    buildsWithChecks,
    // Until the ordering check can even run, every threshold on screen is still
    // a published-research prior rather than a measurement of this operator's
    // builds. The UI says so.
    isPrior: ordering.sound === null,
  }
}

export async function totalOutcomeSpend(db: Database): Promise<bigint> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${outcomes.costMicros}), 0)::text` })
    .from(outcomes)
  return BigInt(rows[0]?.total ?? '0')
}

export { BudgetGuard }
