import 'server-only'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  classifySupplyOpportunity,
  supplyStatusFor,
  type DemandStatus,
  type SupplyCoverage,
  type SupplyOpportunity,
  type SupplyStatus,
} from '@rnr/core'
import type { Database } from '../db.js'
import { siteKeywordTargets, supplyCoverage, supplyItems, supplySuppliers } from '../schema.js'

/**
 * The materialised (site, entity) → counts join everything else reads.
 *
 * ==================== WHY MATERIALISED ====================
 * The keyword board, the ads planner, the outreach drafter and every agent tool
 * read this. Recomputing a 195-locality aggregate on each of those is waste, and
 * a per-row lookup inside a 975-keyword verdict pass is a thousand queries for a
 * couple of hundred distinct facts.
 * ==========================================================
 *
 * ==================== WHY UNRESOLVED SUPPLIERS ARE EXCLUDED ====================
 * They contribute to no entity's counts — they have no entity. What matters is
 * that this exclusion produces NO ROW for those localities rather than a zero
 * row, because `supplyStatusFor` reads a missing row as 'unknown' and a zero row
 * as 'none'. That single distinction is what stops an importer bug from
 * cancelling the portfolio's build queue.
 * ===============================================================================
 */

export interface RebuildResult {
  entities: number
  suppliersCounted: number
  itemsCounted: number
  /** Suppliers deliberately left out because they never resolved. */
  unresolvedExcluded: number
}

export async function rebuildCoverage(
  db: Database,
  siteId: number,
  opts: { now?: Date } = {},
): Promise<RebuildResult> {
  const now = opts.now ?? new Date()

  const rows = await db
    .select({
      entityKind: supplySuppliers.entityKind,
      entitySlug: supplySuppliers.entitySlug,
      supplierCount: sql<number>`count(distinct ${supplySuppliers.id})::int`,
      itemCount: sql<number>`count(${supplyItems.id})::int`,
      availableItemCount: sql<number>`count(*) filter (where ${supplyItems.available} is true)::int`,
      minPriceMicros: sql<string | null>`min(${supplyItems.priceMicros})`,
      /**
       * `percentile_cont` interpolates between the two middle values, which for
       * an even count of prices produces a half-cent. Cast back to bigint —
       * micros are integers, and a fractional one would not survive the bigint
       * column anyway.
       */
      medianPriceMicros: sql<string | null>`
        (percentile_cont(0.5) within group (
          order by ${supplyItems.priceMicros}
        ) filter (where ${supplyItems.priceMicros} is not null))::bigint
      `,
    })
    .from(supplySuppliers)
    .innerJoin(
      supplyItems,
      and(eq(supplyItems.supplierId, supplySuppliers.id), isNull(supplyItems.goneAt)),
    )
    .where(
      and(
        eq(supplySuppliers.siteId, siteId),
        eq(supplySuppliers.resolveStatus, 'resolved'),
        isNotNull(supplySuppliers.entitySlug),
      ),
    )
    .groupBy(supplySuppliers.entityKind, supplySuppliers.entitySlug)

  const [excluded] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(supplySuppliers)
    .where(
      and(eq(supplySuppliers.siteId, siteId), eq(supplySuppliers.resolveStatus, 'unresolved')),
    )

  let itemsCounted = 0
  let suppliersCounted = 0

  for (const r of rows) {
    itemsCounted += r.itemCount
    suppliersCounted += r.supplierCount
    await db
      .insert(supplyCoverage)
      .values({
        siteId,
        entityKind: r.entityKind!,
        entitySlug: r.entitySlug!,
        supplierCount: r.supplierCount,
        itemCount: r.itemCount,
        availableItemCount: r.availableItemCount,
        minPriceMicros: r.minPriceMicros === null ? null : BigInt(r.minPriceMicros),
        medianPriceMicros: r.medianPriceMicros === null ? null : BigInt(r.medianPriceMicros),
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [supplyCoverage.siteId, supplyCoverage.entityKind, supplyCoverage.entitySlug],
        set: {
          supplierCount: r.supplierCount,
          itemCount: r.itemCount,
          availableItemCount: r.availableItemCount,
          minPriceMicros: r.minPriceMicros === null ? null : BigInt(r.minPriceMicros),
          medianPriceMicros: r.medianPriceMicros === null ? null : BigInt(r.medianPriceMicros),
          lastSeenAt: now,
          updatedAt: now,
        },
      })
  }

  /**
   * An entity whose every item is now gone keeps its row and is zeroed, rather
   * than having the row deleted.
   *
   * Deleting it would flip the entity from 'none' back to 'unknown' — from
   * "measured, and there is nothing here" to "nobody ever looked" — which would
   * silently un-gate every keyword bound to it. The gate would release on the
   * day the last listing disappeared, which is precisely the wrong day.
   */
  const present = new Set(rows.map((r) => coverageKey(r.entityKind!, r.entitySlug!)))
  const existing = await db
    .select({
      id: supplyCoverage.id,
      entityKind: supplyCoverage.entityKind,
      entitySlug: supplyCoverage.entitySlug,
    })
    .from(supplyCoverage)
    .where(eq(supplyCoverage.siteId, siteId))

  for (const e of existing) {
    if (present.has(coverageKey(e.entityKind, e.entitySlug))) continue
    await db
      .update(supplyCoverage)
      .set({
        supplierCount: 0,
        itemCount: 0,
        availableItemCount: 0,
        minPriceMicros: null,
        medianPriceMicros: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(supplyCoverage.id, e.id))
  }

  return {
    entities: rows.length,
    suppliersCounted,
    itemsCounted,
    unresolvedExcluded: excluded?.n ?? 0,
  }
}

/** The read model, keyed for O(1) lookup during a verdict pass. */
export type CoverageMap = Map<string, SupplyCoverage>

/**
 * The composite-key separator.
 *
 * Written as an ESCAPE, never as a literal byte. A raw NUL in a source file makes
 * it `Binary file matches` to git, grep and every editor, which cost a debugging
 * round here. NUL is still the RIGHT separator - it is the one character that can
 * appear in neither an entity slug nor an entity kind, where `:` and `-` both can.
 * It simply must not be typed literally.
 */
export const COVERAGE_KEY_SEP = '\u0000'

export const coverageKey = (entityKind: string, entitySlug: string): string =>
  `${entityKind}${COVERAGE_KEY_SEP}${entitySlug}`

export async function loadCoverageMap(db: Database, siteId: number): Promise<CoverageMap> {
  const rows = await db.select().from(supplyCoverage).where(eq(supplyCoverage.siteId, siteId))
  const map: CoverageMap = new Map()
  for (const r of rows) {
    map.set(coverageKey(r.entityKind, r.entitySlug), {
      entityKind: r.entityKind,
      entitySlug: r.entitySlug,
      supplierCount: r.supplierCount,
      itemCount: r.itemCount,
      availableItemCount: r.availableItemCount,
      minPriceMicros: r.minPriceMicros,
      medianPriceMicros: r.medianPriceMicros,
      lastSeenAt: r.lastSeenAt.toISOString(),
    })
  }
  return map
}

/**
 * Find the coverage row for a keyword, from the entities it binds.
 *
 * ==================== WHY THE MINIMUM, NOT THE FIRST ====================
 * A keyword can bind more than one entity (`{vendor} {product}`). Whether we can
 * fulfil it is limited by the SCARCEST of them: a vendor with 200 products and a
 * product carried by nobody means we cannot serve "acme bpc-157", and taking the
 * first binding would answer with the vendor's 200.
 *
 * Same shape as the min-across-vendors rule in resolveEconomics, and the same
 * reason: when several bound facts each constrain the answer, the binding one is
 * the worst, never the first.
 * =======================================================================
 *
 * An UNKNOWN binding wins over everything: if any bound entity has no coverage
 * row, we cannot claim to know the keyword's supply at all.
 */
export function coverageForKeyword(
  map: CoverageMap,
  entities: Record<string, string> | null,
): SupplyCoverage | null {
  if (!entities) return null
  const values = Object.entries(entities)
  if (values.length === 0) return null

  let scarcest: SupplyCoverage | null = null
  for (const [kind, slug] of values) {
    const row = map.get(coverageKey(kind, slug))
    if (!row) return null
    if (scarcest === null || row.availableItemCount < scarcest.availableItemCount) scarcest = row
  }
  return scarcest
}

// ---------------------------------------------------------------------------
// The 2x2.

export interface OpportunityRow {
  entityKind: string
  entitySlug: string
  cell: SupplyOpportunity
  action: string
  supplyStatus: SupplyStatus
  demandStatus: DemandStatus
  supplierCount: number
  availableItemCount: number
  medianPriceMicros: bigint | null
  /** Keyword rows bound to this entity, and how many carry measured demand. */
  keywordCount: number
  keywordsWithVolume: number
  bestVolume: number | null
}

export interface OpportunityReport {
  rows: OpportunityRow[]
  byCell: Record<SupplyOpportunity, number>
  notes: string[]
}

const EMPTY_CELLS = (): Record<SupplyOpportunity, number> => ({
  BUILD_FIRST: 0,
  KEYWORD_GAP: 0,
  SUPPLY_GAP: 0,
  IGNORE: 0,
  UNKNOWN: 0,
})

/**
 * Cross supply against demand, per entity.
 *
 * ==================== THE ONE OUTPUT NOTHING ELSE CAN PRODUCE ==============
 * `KEYWORD_GAP` — entities where we hold inventory and the grid generated no
 * keyword row at all, or generated one nobody has measured. Forty properties in
 * a city with no page is demand-side work with the supply risk already removed,
 * and neither the keyword board nor the supply tables can see it alone.
 *
 * `SUPPLY_GAP` is the one that costs money today: real demand, no inventory,
 * currently reaching BUILD and BUY.
 * ===========================================================================
 */
export async function supplyOpportunityReport(
  db: Database,
  siteId: number,
  opts: { volumeFloor?: number; now?: Date } = {},
): Promise<OpportunityReport> {
  const floor = opts.volumeFloor ?? 0
  const nowIso = (opts.now ?? new Date()).toISOString()
  const notes: string[] = []

  const coverage = await db.select().from(supplyCoverage).where(eq(supplyCoverage.siteId, siteId))

  /**
   * Demand per entity, from the keyword grid's own bindings.
   *
   * `jsonb_each_text` unrolls `entities` so one keyword binding two dimensions
   * contributes to both. Volume is aggregated with MAX rather than SUM: the
   * question is whether ANY keyword for this entity has demand worth serving,
   * and summing 40 near-duplicate patterns would manufacture demand out of the
   * grid's own row count.
   */
  const demandRows = await db
    .select({
      entityKind: sql<string>`e.key`,
      entitySlug: sql<string>`e.value`,
      keywordCount: sql<number>`count(*)::int`,
      keywordsWithVolume: sql<number>`count(*) filter (where ${siteKeywordTargets.volume} is not null)::int`,
      bestVolume: sql<number | null>`max(${siteKeywordTargets.volume})`,
    })
    .from(siteKeywordTargets)
    .innerJoin(sql`jsonb_each_text(${siteKeywordTargets.entities}) as e`, sql`true`)
    .where(and(eq(siteKeywordTargets.siteId, siteId), eq(siteKeywordTargets.active, true)))
    .groupBy(sql`e.key`, sql`e.value`)

  const demandByEntity = new Map(
    demandRows.map((d) => [coverageKey(d.entityKind, d.entitySlug), d]),
  )

  const keys = new Set<string>([
    ...coverage.map((c) => coverageKey(c.entityKind, c.entitySlug)),
    ...demandByEntity.keys(),
  ])

  const rows: OpportunityRow[] = []
  const byCell = EMPTY_CELLS()

  for (const key of keys) {
    const [entityKind, entitySlug] = key.split(COVERAGE_KEY_SEP) as [string, string]
    const cov = coverage.find((c) => c.entityKind === entityKind && c.entitySlug === entitySlug)
    const dem = demandByEntity.get(key)

    const supply = supplyStatusFor(
      cov
        ? {
            entityKind: cov.entityKind,
            entitySlug: cov.entitySlug,
            supplierCount: cov.supplierCount,
            itemCount: cov.itemCount,
            availableItemCount: cov.availableItemCount,
            minPriceMicros: cov.minPriceMicros,
            medianPriceMicros: cov.medianPriceMicros,
            lastSeenAt: cov.lastSeenAt.toISOString(),
          }
        : null,
      { now: nowIso },
    )

    /**
     * Demand is three-state for the same reason supply is. A keyword row with no
     * measured volume is 'unknown', NOT 'no_demand' — the free volume pass may
     * simply not have run, and reading that as "nobody searches for this" would
     * bury an entity we hold inventory for.
     */
    let demandStatus: DemandStatus
    if (!dem || dem.keywordCount === 0) demandStatus = 'no_demand'
    else if (dem.keywordsWithVolume === 0) demandStatus = 'unknown'
    else demandStatus = (dem.bestVolume ?? 0) >= floor ? 'demand' : 'no_demand'

    const { cell, action } = classifySupplyOpportunity(supply.status, demandStatus)
    byCell[cell] += 1
    rows.push({
      entityKind,
      entitySlug,
      cell,
      action,
      supplyStatus: supply.status,
      demandStatus,
      supplierCount: cov?.supplierCount ?? 0,
      availableItemCount: cov?.availableItemCount ?? 0,
      medianPriceMicros: cov?.medianPriceMicros ?? null,
      keywordCount: dem?.keywordCount ?? 0,
      keywordsWithVolume: dem?.keywordsWithVolume ?? 0,
      bestVolume: dem?.bestVolume ?? null,
    })
  }

  const order: Record<SupplyOpportunity, number> = {
    SUPPLY_GAP: 0,
    BUILD_FIRST: 1,
    KEYWORD_GAP: 2,
    UNKNOWN: 3,
    IGNORE: 4,
  }
  rows.sort(
    (a, b) => order[a.cell] - order[b.cell] || (b.bestVolume ?? 0) - (a.bestVolume ?? 0),
  )

  if (coverage.length === 0) {
    notes.push(
      'No supply coverage at all for this site. Every entity is UNKNOWN, which is correct and ' +
        'means nothing is gated — connect a source and run `supply pull`.',
    )
  }
  if (byCell.SUPPLY_GAP > 0) {
    notes.push(
      `${byCell.SUPPLY_GAP} entit(ies) have measured demand and NO available supply. These are ` +
        `currently reachable by BUILD and BUY, and each one is a page or a click that cannot convert.`,
    )
  }
  if (byCell.KEYWORD_GAP > 0) {
    notes.push(
      `${byCell.KEYWORD_GAP} entit(ies) hold supply with no keyword demand measured. The supply ` +
        `risk is already gone on these — they are the cheapest pages in the portfolio.`,
    )
  }

  return { rows, byCell, notes }
}
