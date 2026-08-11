import 'server-only'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Verdict } from '@rnr/core'
import type { Database } from './db.js'
import { localities, niches, scanRuns, scanTargets, shortlistItems } from './schema.js'

/** Read queries for the UI. */

export interface LocalityOption {
  id: number
  slug: string
  kind: string
  name: string
  stateCode: string
  population: number | null
  /** null = cannot be scanned. The picker says so rather than silently failing. */
  providerLocationCode: number | null
  unmatchedReason: string | null
}

/**
 * Server-side type-ahead.
 *
 * ==================== NEVER SHIP THE CORPUS ====================
 * ~13,500 resolvable localities is roughly 570KB of JSON in the browser. The
 * previous build tried a client-side datalist capped at 400 rows, which made 168
 * of 12,673 cities selectable -- and the worked example, Kenosha at 99.5k, was
 * not among them. The failure looked like "the search box doesn't find anything",
 * which reads as a data problem rather than a cap.
 *
 * So: query per keystroke, hard LIMIT, and the result set is the only thing that
 * crosses the wire.
 * ===============================================================
 */
export async function searchLocalities(
  db: Database,
  query: string,
  opts: { limit?: number; onlyScannable?: boolean } = {},
): Promise<LocalityOption[]> {
  // ==================== NORMALISE, THEN MATCH BY TOKEN ====================
  // `search_text` is "knoxville tn tennessee" -- no punctuation. Matching the raw
  // input as a prefix meant "Knoxville, TN" -- the way anyone naturally writes a
  // US city -- produced LIKE 'knoxville, tn%' and matched NOTHING, while
  // "knoxville" alone worked fine. The city was in the corpus and scannable the
  // whole time; the comma was the entire problem, and the UI reported it as "no
  // locality matches", which reads as missing data.
  //
  // So: strip punctuation, split into tokens, require the FIRST token to start
  // the name (that is what makes the search feel like a name search) and every
  // remaining token to appear somewhere. That accepts "knoxville", "knoxville
  // tn", "Knoxville, TN" and "Knoxville, Tennessee" alike.
  // =======================================================================
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const first = tokens[0]
  if (!first || first.length < 2) return []
  const limit = Math.min(opts.limit ?? 20, 50)

  const conditions = [sql`${localities.searchText} LIKE ${`${first}%`}`]
  for (const token of tokens.slice(1)) {
    conditions.push(sql`${localities.searchText} LIKE ${`%${token}%`}`)
  }
  if (opts.onlyScannable) conditions.push(isNotNull(localities.providerLocationCode))

  return db
    .select({
      id: localities.id,
      slug: localities.slug,
      kind: localities.kind,
      name: localities.name,
      stateCode: localities.stateCode,
      population: localities.population,
      providerLocationCode: localities.providerLocationCode,
      unmatchedReason: localities.unmatchedReason,
    })
    .from(localities)
    .where(and(...conditions))
    // Biggest first: an operator typing "spring" wants Springfield MO before
    // Spring Valley, pop. 300.
    .orderBy(desc(localities.population))
    .limit(limit)
}

export async function getLocalityBySlug(db: Database, slug: string) {
  const [row] = await db.select().from(localities).where(eq(localities.slug, slug))
  return row ?? null
}

export async function getLocalityById(db: Database, id: number) {
  const [row] = await db.select().from(localities).where(eq(localities.id, id))
  return row ?? null
}

// ---------------------------------------------------------------------------

export interface ResultRow {
  scanTargetId: number
  nicheId: number
  nicheSlug: string
  nicheLabel: string
  keyword: string
  difficulty: number | null
  weightCovered: number
  verdict: Verdict
  blockerCount: number
  volumeEst: number | null
  rentMicros: bigint | null
  slotsOpen: number
  platformHeldSlots: number
  emdDomain: string
  emdAvailable: boolean | null
  linkDataMeasured: boolean
  saved: boolean
}

/**
 * Results for one run, EASIEST FIRST -- the primary sort, and the whole point of
 * being locality-first.
 *
 * NULLS LAST is explicit: a null difficulty means "could not be scored" and must
 * not sort to the top of an easiest-first table where it would read as the single
 * best opportunity in the locality.
 */
export async function getRunResults(db: Database, runId: number): Promise<ResultRow[]> {
  const rows = await db
    .select({
      scanTargetId: scanTargets.id,
      nicheId: niches.id,
      nicheSlug: niches.slug,
      nicheLabel: niches.label,
      keyword: scanTargets.keyword,
      difficulty: scanTargets.difficulty,
      weightCovered: scanTargets.weightCovered,
      verdict: scanTargets.verdict,
      blockers: scanTargets.blockers,
      volumeEst: scanTargets.volumeEst,
      rentMicros: scanTargets.rentMicros,
      slotsOpen: scanTargets.slotsOpen,
      platformHeldSlots: scanTargets.platformHeldSlots,
      emdDomain: scanTargets.emdDomain,
      emdAvailable: scanTargets.emdAvailable,
      linkDataMeasured: scanTargets.linkDataMeasured,
      savedId: shortlistItems.id,
    })
    .from(scanTargets)
    .innerJoin(niches, eq(scanTargets.nicheId, niches.id))
    .leftJoin(
      shortlistItems,
      and(
        eq(shortlistItems.localityId, scanTargets.localityId),
        eq(shortlistItems.nicheId, scanTargets.nicheId),
      ),
    )
    .where(eq(scanTargets.scanRunId, runId))
    .orderBy(sql`${scanTargets.difficulty} ASC NULLS LAST`, asc(niches.label))

  return rows.map((r) => ({
    scanTargetId: r.scanTargetId,
    nicheId: r.nicheId,
    nicheSlug: r.nicheSlug,
    nicheLabel: r.nicheLabel,
    keyword: r.keyword,
    difficulty: r.difficulty,
    weightCovered: r.weightCovered,
    verdict: r.verdict,
    blockerCount: Array.isArray(r.blockers) ? r.blockers.length : 0,
    volumeEst: r.volumeEst,
    rentMicros: r.rentMicros,
    slotsOpen: r.slotsOpen,
    platformHeldSlots: r.platformHeldSlots,
    emdDomain: r.emdDomain,
    emdAvailable: r.emdAvailable,
    linkDataMeasured: r.linkDataMeasured,
    saved: r.savedId !== null,
  }))
}

export async function getRun(db: Database, runId: number) {
  const [row] = await db
    .select({
      run: scanRuns,
      locality: localities,
    })
    .from(scanRuns)
    .innerJoin(localities, eq(scanRuns.localityId, localities.id))
    .where(eq(scanRuns.id, runId))
  return row ?? null
}

export async function getLatestRunForLocality(db: Database, localityId: number) {
  const [row] = await db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.localityId, localityId))
    .orderBy(desc(scanRuns.createdAt))
    .limit(1)
  return row ?? null
}

export async function getScanTargetDetail(db: Database, scanTargetId: number) {
  const [row] = await db
    .select({
      target: scanTargets,
      niche: niches,
      locality: localities,
      run: scanRuns,
    })
    .from(scanTargets)
    .innerJoin(niches, eq(scanTargets.nicheId, niches.id))
    .innerJoin(localities, eq(scanTargets.localityId, localities.id))
    .innerJoin(scanRuns, eq(scanTargets.scanRunId, scanRuns.id))
    .where(eq(scanTargets.id, scanTargetId))
  return row ?? null
}

// ---------------------------------------------------------------------------

export async function listShortlist(db: Database) {
  return db
    .select({
      item: shortlistItems,
      locality: localities,
      niche: niches,
    })
    .from(shortlistItems)
    .innerJoin(localities, eq(shortlistItems.localityId, localities.id))
    .innerJoin(niches, eq(shortlistItems.nicheId, niches.id))
    .orderBy(desc(shortlistItems.savedAt))
}

export async function listRecentRuns(db: Database, limit = 20) {
  return db
    .select({
      run: scanRuns,
      locality: localities,
      scored: sql<number>`(
        SELECT COUNT(*)::int FROM scan_targets st WHERE st.scan_run_id = ${scanRuns.id}
      )`,
    })
    .from(scanRuns)
    .innerJoin(localities, eq(scanRuns.localityId, localities.id))
    .orderBy(desc(scanRuns.createdAt))
    .limit(limit)
}

/**
 * Save a cell to the shortlist, FREEZING the model's verdict at decision time.
 *
 * The frozen columns are what calibration compares against later. Reading them
 * live from scan_targets would mean today's thresholds judging yesterday's
 * build, so every band would validate itself: adjust a constant in priors.ts and
 * the historical hit rate silently improves.
 */
export async function saveToShortlist(
  db: Database,
  scanTargetId: number,
): Promise<{ id: number } | null> {
  const [t] = await db.select().from(scanTargets).where(eq(scanTargets.id, scanTargetId))
  if (!t) return null

  const [row] = await db
    .insert(shortlistItems)
    .values({
      localityId: t.localityId,
      nicheId: t.nicheId,
      scanTargetId: t.id,
      difficultyAtSave: t.difficulty,
      verdictAtSave: t.verdict,
      weightCoveredAtSave: t.weightCovered,
      emdAvailableAtSave: t.emdAvailable,
      emdDomain: t.emdDomain,
      state: 'watching',
    })
    .onConflictDoNothing({ target: [shortlistItems.localityId, shortlistItems.nicheId] })
    .returning({ id: shortlistItems.id })
  return row ?? null
}

export async function removeFromShortlist(db: Database, itemId: number): Promise<void> {
  await db.delete(shortlistItems).where(eq(shortlistItems.id, itemId))
}

export async function setShortlistState(
  db: Database,
  itemId: number,
  state: 'watching' | 'building' | 'ranking' | 'rented',
): Promise<void> {
  const patch: Record<string, unknown> = { state }
  // Entering `building` starts the clock the outcome checks measure against.
  // Without it, findDueChecks has no baseline and no check is ever scheduled.
  if (state === 'building') patch['buildStartedAt'] = new Date()
  await db.update(shortlistItems).set(patch).where(eq(shortlistItems.id, itemId))
}

export interface QueueHealth {
  pending: number
  inFlight: number
  /** Seconds the oldest pending run has been waiting. null = nothing pending. */
  oldestPendingSeconds: number | null
  /** Seconds since any run was last claimed. null = never. A liveness proxy. */
  secondsSinceLastClaim: number | null
  /**
   * True when work is queued and has sat there long enough that a running worker
   * would certainly have picked it up.
   */
  workerProbablyDown: boolean
}

/**
 * Is the queue moving?
 *
 * The UI previously stated "a scan only starts when the worker is running" as a
 * static paragraph -- true, but it left the operator to diagnose a stuck run by
 * reading it and guessing. A pending row that has sat for longer than a poll
 * interval IS the evidence, so the page can just say so.
 *
 * No heartbeat table needed: the worker claims within ~2s of a run appearing, so
 * anything pending for much longer than that means nothing is consuming.
 */
export async function getQueueHealth(db: Database): Promise<QueueHealth> {
  const [row] = await db
    .select({
      pending: sql<number>`COUNT(*) FILTER (WHERE ${scanRuns.status} = 'pending')::int`,
      inFlight: sql<number>`COUNT(*) FILTER (WHERE ${scanRuns.status} IN ('claimed','running'))::int`,
      oldestPending: sql<
        number | null
      >`MAX(EXTRACT(EPOCH FROM (now() - ${scanRuns.createdAt})))::int FILTER (WHERE ${scanRuns.status} = 'pending')`,
      sinceClaim: sql<
        number | null
      >`MIN(EXTRACT(EPOCH FROM (now() - ${scanRuns.claimedAt})))::int`,
    })
    .from(scanRuns)

  const oldestPendingSeconds = row?.oldestPending ?? null
  return {
    pending: row?.pending ?? 0,
    inFlight: row?.inFlight ?? 0,
    oldestPendingSeconds,
    secondsSinceLastClaim: row?.sinceClaim ?? null,
    // 20s is ~10 poll intervals. Long enough that a live worker cannot have
    // missed it, short enough to be useful while the operator is still looking.
    workerProbablyDown: oldestPendingSeconds !== null && oldestPendingSeconds > 20,
  }
}

export async function countScannableLocalities(db: Database): Promise<{
  total: number
  scannable: number
}> {
  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      scannable: sql<number>`COUNT(${localities.providerLocationCode})::int`,
    })
    .from(localities)
  return { total: row?.total ?? 0, scannable: row?.scannable ?? 0 }
}
