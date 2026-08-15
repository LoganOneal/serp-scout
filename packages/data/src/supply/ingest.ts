import 'server-only'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { SupplyIngestMode, SupplyIngestStatus } from '@rnr/core'
import type { SupplyItem, SupplyManifest } from '@rnr/supply-feed'
import type { Database } from '../db.js'
import { supplyIngestRuns, supplyItems, supplySources, supplySuppliers } from '../schema.js'
import { SupplyClient, SupplyFeedError } from './client.js'
import { buildResolver, resolveItem, type Resolution } from './resolve.js'
import { rebuildCoverage } from './coverage.js'

/**
 * Pull a supply feed into the read model.
 *
 * ==================== THE RESOLUTION REPORT IS THE DELIVERABLE ==============
 * It is tempting to read this as "sync the listings". The listings are the easy
 * half. The half that decides whether any of this is trustworthy is what the run
 * COULD NOT PLACE — because an unresolved supplier and a locality with no hotels
 * are indistinguishable in every downstream count, and one of them is a reason
 * not to build a page while the other is a reason to fix an importer.
 *
 * So `unresolvedSuppliers` is a first-class column, its examples are in `notes`,
 * and the run's status is `partial` — not `ok` — whenever the pull does not
 * reconcile against the publisher's own manifest.
 * ===========================================================================
 */

export interface IngestArgs {
  sourceId: number
  /** ISO 8601. Present ⇒ incremental, which disables the soft-delete sweep. */
  since?: string | null
  /** Read the feed but write nothing. Reports exactly what a real run would do. */
  dryRun?: boolean
  fetchImpl?: typeof fetch
  pageSize?: number
  maxPages?: number
  /** Injectable clock, so tests do not race the sweep's timestamp comparison. */
  now?: Date
  /** Env to read the bearer token from. */
  env?: NodeJS.ProcessEnv
}

export interface IngestResult {
  runId: number | null
  status: SupplyIngestStatus
  mode: SupplyIngestMode
  pagesFetched: number
  itemsPulled: number
  itemsUpserted: number
  itemsMarkedGone: number
  suppliersUpserted: number
  unresolvedSuppliers: number
  entitiesCovered: number
  manifestTotalItems: number | null
  notes: string[]
}

export class SupplyIngestError extends Error {}

/**
 * A pull that resolves fewer than this fraction of suppliers is reported as
 * `partial` even if everything else reconciled.
 *
 * POLICY, not a measurement — the same shape as `ingest-geo.ts`'s coverage bars.
 * 0.9 is chosen because a handful of odd city names is normal and a tenth of the
 * catalogue going unplaced is an importer problem, not a data quirk.
 */
export const MIN_RESOLVE_RATE = 0.9

/**
 * Rows per INSERT.
 *
 * ==================== WHY THIS IS NOT ONE-ROW-AT-A-TIME ====================
 * It was, and the first real catalogue made the cost obvious: 5,828 listings
 * meant 5,828 supplier upserts plus 5,828 item upserts, each its own round trip
 * to a pooled remote Postgres. Eleven thousand sequential queries to write a few
 * megabytes.
 *
 * Batched multi-row upserts need `excluded.<column>` in the SET clause rather
 * than literal values — a literal could only carry one row's data — which is why
 * those blocks read as SQL fragments instead of plain objects.
 *
 * 500 keeps the widest row (supply_items, 16 columns) at ~8,000 bind parameters,
 * comfortably under Postgres's 65,535 limit with room for the schema to grow.
 * ==========================================================================
 */
export const UPSERT_BATCH = 500

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

export async function ingestSupply(db: Database, args: IngestArgs): Promise<IngestResult> {
  const now = args.now ?? new Date()
  const env = args.env ?? process.env
  const notes: string[] = []
  const mode: SupplyIngestMode = args.since ? 'incremental' : 'full'

  const [source] = await db
    .select()
    .from(supplySources)
    .where(eq(supplySources.id, args.sourceId))
    .limit(1)

  if (!source) throw new SupplyIngestError(`No supply source #${args.sourceId}`)

  const token = env[source.tokenEnvVar]?.trim()
  if (!token) {
    throw new SupplyIngestError(
      `${source.tokenEnvVar} is not set. The feed refuses to serve without a token and this ` +
        `refuses to ask without one — see @rnr/supply-feed, which fails toward publishing nothing.`,
    )
  }

  const client = new SupplyClient({
    baseUrl: source.baseUrl,
    token,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.pageSize ? { pageSize: args.pageSize } : {}),
    ...(args.maxPages ? { maxPages: args.maxPages } : {}),
  })

  const [run] = args.dryRun
    ? [null]
    : await db
        .insert(supplyIngestRuns)
        .values({ sourceId: source.id, siteId: source.siteId, status: 'running', mode, startedAt: now })
        .returning({ id: supplyIngestRuns.id })

  const runId = run?.id ?? null

  const failRun = async (message: string): Promise<never> => {
    if (runId !== null) {
      await db
        .update(supplyIngestRuns)
        .set({ status: 'failed', error: message, finishedAt: new Date() })
        .where(eq(supplyIngestRuns.id, runId))
    }
    throw new SupplyIngestError(message)
  }

  let manifest: SupplyManifest | null = null
  try {
    manifest = await client.manifest()
  } catch (e) {
    /**
     * A missing manifest is fatal, not a degradation.
     *
     * Without `totalItems` there is no way to tell a partial pull from a shrunk
     * catalogue, and the soft-delete sweep below would happily mark the
     * difference as gone. Continuing without it would be the exact failure the
     * manifest exists to prevent.
     */
    return failRun(
      `Could not read the manifest: ${(e as Error).message}. Refusing to sync without it — ` +
        `there would be no way to distinguish a partial pull from a shrunk catalogue.`,
    )
  }

  let walk
  try {
    walk = await client.walk({ since: args.since ?? null })
  } catch (e) {
    return failRun(
      e instanceof SupplyFeedError ? e.message : `walk failed: ${(e as Error).message}`,
    )
  }

  /**
   * ==================== THE MANIFEST IS READ TWICE, ON PURPOSE ==============
   * `invalidItems` counts rows the feed's own validation refused, and the feed
   * can only count them once something has ASKED for them — it is populated as
   * pages are served. Reading it from the pre-walk manifest gives 0 every time,
   * which made reconciliation subtract nothing and report a permanent, false
   * partial sync on the first pull of any catalogue with a single broken row.
   *
   * The first read still has to happen first: it fails fast on an unreachable
   * feed and refuses a schema version we cannot parse, both before anything is
   * walked. This second one is what reconciliation actually uses.
   * =========================================================================
   */
  try {
    manifest = await client.manifest()
  } catch {
    // A manifest that answered once and not twice is odd but not fatal — the
    // pre-walk copy is still a valid baseline for totalItems.
    notes.push('The manifest was unreadable after the walk; reconciling against the pre-walk copy.')
  }

  if (walk.truncated) {
    notes.push(
      `Stopped at the ${walk.pagesFetched}-page backstop. This pull is a SAMPLE, not the ` +
        `catalogue — raise maxPages or the page size before trusting coverage from it.`,
    )
  }
  if (walk.invalidInPages > 0) {
    notes.push(
      `The feed itself refused to serve ${walk.invalidInPages} item(s) that failed its own ` +
        `validation. Those are listings nobody can rank — see the manifest's invalidSamples.`,
    )
  }

  const resolver = await buildResolver(db, source.entityKind)
  if (resolver.kind !== 'none' && resolver.corpusSize === 0) {
    notes.push(
      `The ${resolver.kind} corpus this source resolves against is EMPTY, so every supplier will ` +
        `land unresolved. That is a configuration problem, not a supply one.`,
    )
  }

  // --- Group items by supplier, and resolve each supplier once ---------------
  const bySupplier = new Map<string, { items: SupplyItem[]; resolution: Resolution }>()
  for (const item of walk.items) {
    const existing = bySupplier.get(item.supplierId)
    if (existing) {
      existing.items.push(item)
      continue
    }
    bySupplier.set(item.supplierId, { items: [item], resolution: resolveItem(resolver, item) })
  }

  const unresolvedExamples: string[] = []
  let unresolved = 0
  for (const [, group] of bySupplier) {
    if (group.resolution.status !== 'unresolved') continue
    unresolved += 1
    if (unresolvedExamples.length < 5 && group.resolution.reason) {
      unresolvedExamples.push(`${group.items[0]!.supplierName}: ${group.resolution.reason}`)
    }
  }

  const result: IngestResult = {
    runId,
    status: 'ok',
    mode,
    pagesFetched: walk.pagesFetched,
    itemsPulled: walk.items.length,
    itemsUpserted: 0,
    itemsMarkedGone: 0,
    suppliersUpserted: 0,
    unresolvedSuppliers: unresolved,
    entitiesCovered: 0,
    manifestTotalItems: manifest.totalItems ?? null,
    notes,
  }

  if (args.dryRun) {
    notes.push('DRY RUN — nothing was written.')
    reportResolution(result, bySupplier.size, unresolved, unresolvedExamples)
    reconcile(result, manifest, mode)
    return result
  }

  // --- Write ----------------------------------------------------------------
  const supplierIdByExternal = new Map<string, number>()
  const itemRows: Array<typeof supplyItems.$inferInsert> = []

  const supplierRows = [...bySupplier.entries()].map(([externalId, group]) => {
    const first = group.items[0]!
    const r = group.resolution
    return {
      sourceId: source.id,
      siteId: source.siteId,
      externalId,
      name: first.supplierName,
      rawCity: first.location?.city ?? null,
      rawRegion: first.location?.region ?? null,
      rawCountry: first.location?.country ?? null,
      entityKind: r.entityKind,
      entitySlug: r.entitySlug,
      localityId: r.localityId,
      resolveStatus: r.status,
      resolveMethod: r.method,
      unresolvedReason: r.reason,
      lastSeenAt: now,
    }
  })

  for (const batch of chunk(supplierRows, UPSERT_BATCH)) {
    const written = await db
      .insert(supplySuppliers)
      .values(batch)
      .onConflictDoUpdate({
        target: [supplySuppliers.sourceId, supplySuppliers.externalId],
        // `excluded` is the row the INSERT tried to write. Naming the columns
        // this way is what makes a multi-row upsert possible at all — a literal
        // `set` could only carry one row's values.
        set: {
          name: sql`excluded.name`,
          rawCity: sql`excluded.raw_city`,
          rawRegion: sql`excluded.raw_region`,
          rawCountry: sql`excluded.raw_country`,
          entityKind: sql`excluded.entity_kind`,
          entitySlug: sql`excluded.entity_slug`,
          localityId: sql`excluded.locality_id`,
          resolveStatus: sql`excluded.resolve_status`,
          resolveMethod: sql`excluded.resolve_method`,
          unresolvedReason: sql`excluded.unresolved_reason`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      })
      .returning({ id: supplySuppliers.id, externalId: supplySuppliers.externalId })

    for (const w of written) supplierIdByExternal.set(w.externalId, w.id)
  }
  result.suppliersUpserted = supplierIdByExternal.size

  for (const item of walk.items) {
    const supplierId = supplierIdByExternal.get(item.supplierId)
    if (supplierId === undefined) continue

    itemRows.push({
      sourceId: source.id,
      siteId: source.siteId,
      supplierId,
      externalId: item.id,
      title: item.title,
      url: item.url,
      affiliateUrl: item.affiliateUrl ?? null,
      attributes: item.attributes ?? null,
      priceMicros: item.priceMicros === undefined ? null : BigInt(item.priceMicros),
      currency: item.currency ?? null,
      // `undefined` stays NULL. See the column comment: unstated availability
      // must not be promoted to bookable.
      available: item.available ?? null,
      images: item.images ?? null,
      sourceUpdatedAt: new Date(item.updatedAt),
      firstSeenAt: now,
      lastSeenAt: now,
      goneAt: null,
    })
  }

  for (const batch of chunk(itemRows, UPSERT_BATCH)) {
    await db
      .insert(supplyItems)
      .values(batch)
      .onConflictDoUpdate({
        target: [supplyItems.sourceId, supplyItems.externalId],
        set: {
          supplierId: sql`excluded.supplier_id`,
          title: sql`excluded.title`,
          url: sql`excluded.url`,
          affiliateUrl: sql`excluded.affiliate_url`,
          attributes: sql`excluded.attributes`,
          priceMicros: sql`excluded.price_micros`,
          currency: sql`excluded.currency`,
          available: sql`excluded.available`,
          images: sql`excluded.images`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          // A row that came back is not gone. Resurrection is explicit, and
          // `excluded.gone_at` is always NULL here because the insert says so.
          goneAt: sql`excluded.gone_at`,
        },
      })
    result.itemsUpserted += batch.length
  }

  /**
   * ==================== THE SWEEP, AND THE TWO GUARDS ON IT ====================
   * An item absent from a FULL sync is marked gone. Two conditions must hold
   * first, and both exist because of how catastrophic the alternative is:
   *
   *  1. mode === 'full'. An incremental pull legitimately omits everything
   *     unchanged, so sweeping after one would mark the entire unchanged
   *     catalogue as gone.
   *
   *  2. The pull reconciled against the manifest. A feed outage that returned an
   *     empty page would otherwise erase the catalogue, and `supply_coverage`
   *     would report a portfolio-wide supply gap that never existed — turning an
   *     ops blip into a decision to stop building pages.
   *
   * And it is a soft delete regardless: `gone_at` is stamped, the row stays.
   * ============================================================================
   */
  const reconciled = reconcile(result, manifest, mode)
  if (mode === 'full' && reconciled) {
    const marked = await db
      .update(supplyItems)
      .set({ goneAt: now })
      .where(
        and(
          eq(supplyItems.sourceId, source.id),
          isNull(supplyItems.goneAt),
          lt(supplyItems.lastSeenAt, now),
        ),
      )
      .returning({ id: supplyItems.id })
    result.itemsMarkedGone = marked.length
  } else if (mode === 'full') {
    notes.push(
      'Soft-delete sweep SKIPPED: the pull did not reconcile against the manifest. Marking the ' +
        'difference as gone would turn a partial pull into a portfolio-wide supply gap.',
    )
  }

  reportResolution(result, bySupplier.size, unresolved, unresolvedExamples)

  const coverage = await rebuildCoverage(db, source.siteId, { now })
  result.entitiesCovered = coverage.entities

  await db
    .update(supplySources)
    .set({
      lastPulledAt: now,
      lastManifest: manifest as unknown as Record<string, unknown>,
      schemaVersion: manifest.schemaVersion ?? null,
      updatedAt: now,
    })
    .where(eq(supplySources.id, source.id))

  if (runId !== null) {
    await db
      .update(supplyIngestRuns)
      .set({
        status: result.status,
        pagesFetched: result.pagesFetched,
        itemsPulled: result.itemsPulled,
        itemsUpserted: result.itemsUpserted,
        itemsMarkedGone: result.itemsMarkedGone,
        suppliersUpserted: result.suppliersUpserted,
        unresolvedSuppliers: result.unresolvedSuppliers,
        manifestTotalItems: manifest.totalItems ?? null,
        manifestInvalidItems: manifest.invalidItems ?? null,
        entitiesCovered: result.entitiesCovered,
        notes: result.notes,
        finishedAt: new Date(),
      })
      .where(eq(supplyIngestRuns.id, runId))
  }

  return result
}

/**
 * Compare what we pulled against what the publisher says exists.
 *
 * Returns whether the run may sweep. A mismatch downgrades the run to `partial`
 * rather than leaving it green, because a green run is exactly how nobody
 * notices that a tenth of the catalogue is missing.
 */
function reconcile(result: IngestResult, manifest: SupplyManifest, mode: SupplyIngestMode): boolean {
  if (mode === 'incremental') {
    result.notes.push(
      `Incremental pull (?since=) — ${result.itemsPulled} changed item(s). The manifest total ` +
        `(${manifest.totalItems}) is not comparable and no sweep runs.`,
    )
    return false
  }

  const expected = manifest.totalItems
  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    result.status = 'partial'
    result.notes.push('The manifest published no totalItems, so a partial pull is undetectable.')
    return false
  }

  /**
   * ==================== A RANGE, NOT AN EQUALITY ====================
   * Items the feed refused to serve are legitimately absent from the walk. What
   * is NOT knowable from here is whether the publisher's `totalItems` counts
   * them: it comes from their own `db.room.count()`, and whether that query
   * pre-filters the rows their mapper would produce garbage for is their
   * decision, not ours.
   *
   * Both readings are therefore accepted:
   *
   *   itemsPulled  <=  totalItems  <=  itemsPulled + invalidItems
   *
   * The first attempt at this asserted equality against `pulled + invalid` and
   * reported a permanent "Excess 1" against a feed that was working perfectly —
   * and because a failed reconciliation disables the soft-delete sweep, the
   * catalogue would have silently stopped pruning forever. A warning that is
   * always on is a warning nobody reads; one that also disables a subsystem is
   * worse.
   *
   * Anything outside the range is a real gap and blocks the sweep.
   * ==================================================================
   */
  const invalid = manifest.invalidItems ?? 0
  if (expected >= result.itemsPulled && expected <= result.itemsPulled + invalid) return true

  const missing = expected - result.itemsPulled
  result.status = 'partial'
  result.notes.push(
    `PARTIAL SYNC: the manifest says ${expected} item(s); the walk returned ${result.itemsPulled}` +
      (invalid ? ` and the feed refused to serve ${invalid}` : '') +
      `. ${missing > 0 ? `${missing - invalid} unaccounted for` : `${-missing} more than the manifest claims`}. ` +
      `Coverage from this run is not trustworthy and nothing was swept.`,
  )
  return false
}

function reportResolution(
  result: IngestResult,
  suppliers: number,
  unresolved: number,
  examples: string[],
): void {
  if (suppliers === 0) {
    result.notes.push('No suppliers in this pull.')
    return
  }
  const rate = (suppliers - unresolved) / suppliers
  if (unresolved === 0) {
    result.notes.push(`All ${suppliers} supplier(s) resolved.`)
    return
  }

  const line =
    `${unresolved}/${suppliers} supplier(s) (${Math.round((1 - rate) * 100)}%) did NOT resolve to ` +
    `an entity slug. Their listings are UNKNOWN coverage, never zero — no keyword is gated on ` +
    `them.`
  result.notes.push(line)
  for (const e of examples) result.notes.push(`  · ${e}`)

  if (rate < MIN_RESOLVE_RATE) {
    result.status = result.status === 'failed' ? result.status : 'partial'
    result.notes.push(
      `Resolution rate ${Math.round(rate * 100)}% is below the ${Math.round(MIN_RESOLVE_RATE * 100)}% ` +
        `bar. Treat the coverage map as incomplete: everything unplaced looks exactly like a ` +
        `locality with no supply.`,
    )
  }
}

/** Every supplier this source could not place, for the operator to fix. */
export async function listUnresolvedSuppliers(
  db: Database,
  sourceId: number,
  limit = 50,
): Promise<Array<{ name: string; rawCity: string | null; rawRegion: string | null; reason: string | null; items: number }>> {
  const rows = await db
    .select({
      name: supplySuppliers.name,
      rawCity: supplySuppliers.rawCity,
      rawRegion: supplySuppliers.rawRegion,
      reason: supplySuppliers.unresolvedReason,
      items: sql<number>`count(${supplyItems.id})::int`,
    })
    .from(supplySuppliers)
    .leftJoin(
      supplyItems,
      and(eq(supplyItems.supplierId, supplySuppliers.id), isNull(supplyItems.goneAt)),
    )
    .where(
      and(eq(supplySuppliers.sourceId, sourceId), eq(supplySuppliers.resolveStatus, 'unresolved')),
    )
    .groupBy(
      supplySuppliers.id,
      supplySuppliers.name,
      supplySuppliers.rawCity,
      supplySuppliers.rawRegion,
      supplySuppliers.unresolvedReason,
    )
    .orderBy(sql`count(${supplyItems.id}) desc`)
    .limit(limit)

  return rows
}

/** Latest runs for a source, newest first. */
export async function listIngestRuns(db: Database, sourceId: number, limit = 10) {
  return db
    .select()
    .from(supplyIngestRuns)
    .where(eq(supplyIngestRuns.sourceId, sourceId))
    .orderBy(sql`${supplyIngestRuns.startedAt} desc`)
    .limit(limit)
}

/** Used by the CLI to purge a source's rows without touching other sources. */
export async function forgetSource(db: Database, sourceId: number): Promise<void> {
  await db.delete(supplyItems).where(eq(supplyItems.sourceId, sourceId))
  await db.delete(supplySuppliers).where(eq(supplySuppliers.sourceId, sourceId))
  await db.delete(supplyIngestRuns).where(eq(supplyIngestRuns.sourceId, sourceId))
  await db.delete(supplySources).where(inArray(supplySources.id, [sourceId]))
}
