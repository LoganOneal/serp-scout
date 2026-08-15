import 'server-only'
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { supplyCoverage, supplyItems, supplySuppliers } from '../schema.js'

/**
 * Read queries over the supply read model.
 *
 * ==================== EVERY FUNCTION HERE IS A SELECT ====================
 * These are what the MCP server and the outreach drafter consume. Nothing in
 * this file writes, and that is a boundary rather than a coincidence: an agent
 * surface that could mutate supply would be a second writer to a catalogue this
 * system does not own.
 * ========================================================================
 */

export interface SupplySearchArgs {
  siteId: number
  /** Restrict to one resolved entity, e.g. `las-vegas-nv`. */
  entitySlug?: string | null
  entityKind?: string | null
  /** Case-insensitive substring over title and supplier name. */
  q?: string | null
  /** `{ in_room_hot_tub: true }` — matched against the item's attributes jsonb. */
  attributes?: Record<string, string | number | boolean> | null
  maxPriceMicros?: bigint | null
  minPriceMicros?: bigint | null
  /** Default true: gone rows are history, not inventory. */
  availableOnly?: boolean
  limit?: number
}

export interface SupplySearchRow {
  externalId: string
  title: string
  url: string
  affiliateUrl: string | null
  supplierName: string
  entityKind: string | null
  entitySlug: string | null
  priceMicros: bigint | null
  currency: string | null
  available: boolean | null
  attributes: Record<string, string | number | boolean> | null
  lastSeenAt: Date
}

export async function searchSupplyItems(
  db: Database,
  args: SupplySearchArgs,
): Promise<SupplySearchRow[]> {
  const where = [eq(supplyItems.siteId, args.siteId), isNull(supplyItems.goneAt)]

  if (args.availableOnly !== false) where.push(eq(supplyItems.available, true))
  if (args.entitySlug) where.push(eq(supplySuppliers.entitySlug, args.entitySlug))
  if (args.entityKind) where.push(eq(supplySuppliers.entityKind, args.entityKind))
  if (args.minPriceMicros != null) where.push(gte(supplyItems.priceMicros, args.minPriceMicros))
  if (args.maxPriceMicros != null) where.push(lte(supplyItems.priceMicros, args.maxPriceMicros))

  if (args.q?.trim()) {
    const like = `%${args.q.trim().toLowerCase()}%`
    where.push(
      sql`(lower(${supplyItems.title}) like ${like} or lower(${supplySuppliers.name}) like ${like})`,
    )
  }

  /**
   * Attribute filters go through the jsonb containment operator with a
   * PARAMETERISED right-hand side. Building `attributes->>'x' = 'y'` by string
   * concatenation would put agent-supplied text into SQL, and this query is
   * reachable from a conversational surface.
   */
  if (args.attributes && Object.keys(args.attributes).length > 0) {
    where.push(sql`${supplyItems.attributes} @> ${JSON.stringify(args.attributes)}::jsonb`)
  }

  return db
    .select({
      externalId: supplyItems.externalId,
      title: supplyItems.title,
      url: supplyItems.url,
      affiliateUrl: supplyItems.affiliateUrl,
      supplierName: supplySuppliers.name,
      entityKind: supplySuppliers.entityKind,
      entitySlug: supplySuppliers.entitySlug,
      priceMicros: supplyItems.priceMicros,
      currency: supplyItems.currency,
      available: supplyItems.available,
      attributes: supplyItems.attributes,
      lastSeenAt: supplyItems.lastSeenAt,
    })
    .from(supplyItems)
    .innerJoin(supplySuppliers, eq(supplyItems.supplierId, supplySuppliers.id))
    .where(and(...where))
    // NULLS LAST explicitly: Postgres puts NULLs FIRST on ASC-with-nulls in some
    // orderings and a priceless row leading a price-sorted list reads as free.
    .orderBy(sql`${supplyItems.priceMicros} asc nulls last`, asc(supplyItems.title))
    .limit(Math.min(args.limit ?? 25, 200))
}

export interface CoverageSummary {
  entitiesWithSupply: number
  entitiesMeasuredZero: number
  totalSuppliers: number
  totalAvailableItems: number
  oldestLastSeenAt: Date | null
  topEntities: Array<{
    entityKind: string
    entitySlug: string
    supplierCount: number
    availableItemCount: number
    medianPriceMicros: bigint | null
  }>
}

/** A one-call answer to "what do we actually have, and where". */
export async function summariseCoverage(db: Database, siteId: number): Promise<CoverageSummary> {
  const rows = await db
    .select()
    .from(supplyCoverage)
    .where(eq(supplyCoverage.siteId, siteId))
    .orderBy(desc(supplyCoverage.availableItemCount))

  const withSupply = rows.filter((r) => r.availableItemCount > 0)
  return {
    entitiesWithSupply: withSupply.length,
    entitiesMeasuredZero: rows.length - withSupply.length,
    totalSuppliers: rows.reduce((n, r) => n + r.supplierCount, 0),
    totalAvailableItems: rows.reduce((n, r) => n + r.availableItemCount, 0),
    oldestLastSeenAt: rows.length
      ? rows.reduce((a, r) => (r.lastSeenAt < a ? r.lastSeenAt : a), rows[0]!.lastSeenAt)
      : null,
    topEntities: withSupply.slice(0, 20).map((r) => ({
      entityKind: r.entityKind,
      entitySlug: r.entitySlug,
      supplierCount: r.supplierCount,
      availableItemCount: r.availableItemCount,
      medianPriceMicros: r.medianPriceMicros,
    })),
  }
}

/**
 * Sourced supply facts for one entity, for outreach and voice.
 *
 * ==================== WHY IT RETURNS A SENTENCE AND A SOURCE ==============
 * `draftCampaign` refuses any claim it cannot source — every fact must appear in
 * `facts_used` with its origin. So this returns the claim already phrased AND
 * where it came from, rather than raw counts a drafting prompt would have to
 * turn into prose and could turn into an exaggeration.
 *
 * Returns null rather than a vague claim when coverage is missing. "We have a
 * great selection" is exactly the unsourced filler the drafting gate exists to
 * reject.
 * =========================================================================
 */
export interface SupplyFact {
  claim: string
  source: string
  entitySlug: string
  supplierCount: number
  availableItemCount: number
}

/**
 * A site-wide supply fact, for a pitch that names no particular destination.
 *
 * Uses `entitiesWithSupply` rather than the full row count on purpose: entities
 * whose supply is measured at zero are part of the coverage map and are not part
 * of what we can offer, and rolling them in would inflate the claim in the one
 * direction that makes it false.
 */
export async function siteSupplyFact(db: Database, siteId: number): Promise<SupplyFact | null> {
  const s = await summariseCoverage(db, siteId)
  if (s.totalAvailableItems === 0) return null
  return {
    claim:
      `we list ${s.totalAvailableItems} available listing(s) from ${s.totalSuppliers} supplier(s) ` +
      `across ${s.entitiesWithSupply} market(s)`,
    source: `supply_coverage(site=${siteId}) as of ${s.oldestLastSeenAt?.toISOString() ?? 'unknown'}`,
    entitySlug: '(site-wide)',
    supplierCount: s.totalSuppliers,
    availableItemCount: s.totalAvailableItems,
  }
}

export async function supplyFactFor(
  db: Database,
  siteId: number,
  entitySlug: string,
): Promise<SupplyFact | null> {
  const [row] = await db
    .select()
    .from(supplyCoverage)
    .where(and(eq(supplyCoverage.siteId, siteId), eq(supplyCoverage.entitySlug, entitySlug)))
    .limit(1)

  if (!row || row.availableItemCount === 0) return null

  const label = entitySlug.replace(/-/g, ' ')
  return {
    claim:
      `we list ${row.availableItemCount} available listing(s) across ${row.supplierCount} ` +
      `supplier(s) in ${label}`,
    source: `supply_coverage(site=${siteId}, ${row.entityKind}=${entitySlug}) as of ${row.lastSeenAt.toISOString()}`,
    entitySlug,
    supplierCount: row.supplierCount,
    availableItemCount: row.availableItemCount,
  }
}
