import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  deriveFromObservation,
  resolveConversion,
  resolveEconomics,
  type AffiliateScopeKind,
  type CommissionRate,
  type EconomicsCatalog,
  type KeywordBindings,
  type Micros,
  type ResolvedConversion,
  type ResolvedEconomics,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  affiliateCommissionRates,
  affiliateObservations,
  researchEntities,
  researchEntitySets,
  sites,
} from '../schema.js'

/**
 * Loading and writing the three economic terms.
 *
 * ==================== ORDER VALUE LIVES ON THE ENTITY ====================
 * Commission and conversion get their own tables; order value reuses
 * `research_entities.attributes`, whose comment already says why it exists —
 * "a $600 peptide and a $40 one are not worth the same click". A fourth table
 * for one number per row is not worth the join.
 *
 * The key is `orderValueMicros`, stored as a STRING inside the jsonb because
 * JSON numbers are IEEE doubles and money in this codebase is bigint micros
 * everywhere. Round-tripping 300000000 through a JSON number happens to be
 * exact; round-tripping a large one is not, and the failure would be silent.
 * ========================================================================
 */

export const ORDER_VALUE_ATTRIBUTE = 'orderValueMicros'

export class EconomicsError extends Error {}

// --- Commission --------------------------------------------------------------

export async function setCommissionRate(
  db: Database,
  args: {
    siteId: number
    /** null = the site default. */
    entitySlug: string | null
    commissionRateBps: number
    /** ISO date. Defaults to today, injected so a backfill can date correctly. */
    effectiveFrom?: string
    note?: string
  },
): Promise<void> {
  if (!Number.isInteger(args.commissionRateBps) || args.commissionRateBps < 0) {
    throw new EconomicsError(`commissionRateBps must be a non-negative integer (750 = 7.5%)`)
  }
  if (args.commissionRateBps > 10_000) {
    // 100% commission is possible in principle and almost always a units error:
    // somebody typed 7.5 as 75000 rather than 750.
    throw new EconomicsError(
      `commissionRateBps ${args.commissionRateBps} is over 100%. Basis points: 750 = 7.5%.`,
    )
  }

  const effectiveFrom = args.effectiveFrom ?? new Date().toISOString().slice(0, 10)

  /**
   * Delete-then-insert rather than upsert: the unique index is partial (NULL
   * entity_slug needs its own), so `onConflictDoUpdate` has no single target
   * that covers both cases.
   */
  await db
    .delete(affiliateCommissionRates)
    .where(
      and(
        eq(affiliateCommissionRates.siteId, args.siteId),
        args.entitySlug === null
          ? sql`${affiliateCommissionRates.entitySlug} is null`
          : eq(affiliateCommissionRates.entitySlug, args.entitySlug),
        eq(affiliateCommissionRates.effectiveFrom, effectiveFrom),
      ),
    )

  await db.insert(affiliateCommissionRates).values({
    siteId: args.siteId,
    entitySlug: args.entitySlug,
    commissionRateBps: args.commissionRateBps,
    effectiveFrom,
    note: args.note ?? null,
  })
}

export async function setEntityOrderValue(
  db: Database,
  args: { entitySlug: string; setSlug?: string; orderValueMicros: Micros },
): Promise<void> {
  const rows = await db
    .select({ id: researchEntities.id, attributes: researchEntities.attributes })
    .from(researchEntities)
    .innerJoin(researchEntitySets, eq(researchEntitySets.id, researchEntities.setId))
    .where(
      and(
        eq(researchEntities.slug, args.entitySlug),
        ...(args.setSlug ? [eq(researchEntitySets.slug, args.setSlug)] : []),
      ),
    )

  if (rows.length === 0) {
    throw new EconomicsError(
      `No entity "${args.entitySlug}"${args.setSlug ? ` in set "${args.setSlug}"` : ''}. ` +
        `Setting an order value on a slug that does not exist would be silently ignored at ` +
        `resolution time.`,
    )
  }
  if (rows.length > 1 && !args.setSlug) {
    throw new EconomicsError(
      `"${args.entitySlug}" exists in ${rows.length} sets. Pass a set slug — guessing which one ` +
        `would attach the value to the wrong dimension.`,
    )
  }

  for (const row of rows) {
    await db
      .update(researchEntities)
      .set({
        attributes: { ...(row.attributes ?? {}), [ORDER_VALUE_ATTRIBUTE]: String(args.orderValueMicros) },
        updatedAt: new Date(),
      })
      .where(eq(researchEntities.id, row.id))
  }
}

// --- Observations ------------------------------------------------------------

export interface RecordObservationArgs {
  siteId: number
  scopeKind: AffiliateScopeKind
  scopeRef?: string | null
  periodStart: string
  periodEnd: string
  clicks: number
  orders: number
  saleValueMicros?: Micros | null
  commissionMicros?: Micros | null
  source?: string
  enteredBy?: string
  note?: string
}

/**
 * Record what a dashboard actually said.
 *
 * There is no sibling function that accepts a rate. Every guard here exists
 * because the alternative is a plausible-looking number that cannot be
 * distinguished from a real one downstream.
 */
export async function recordObservation(
  db: Database,
  args: RecordObservationArgs,
): Promise<{ id: number; derived: ReturnType<typeof deriveFromObservation> }> {
  if (!Number.isInteger(args.clicks) || args.clicks < 0) {
    throw new EconomicsError('clicks must be a non-negative integer')
  }
  if (!Number.isInteger(args.orders) || args.orders < 0) {
    throw new EconomicsError('orders must be a non-negative integer')
  }
  if (args.orders > args.clicks) {
    throw new EconomicsError(
      `${args.orders} orders from ${args.clicks} clicks is impossible. If the report counts ` +
        `orders from a different traffic source, it is not this scope's observation.`,
    )
  }
  if (args.scopeKind !== 'site' && !args.scopeRef) {
    throw new EconomicsError(`scope "${args.scopeKind}" needs a scopeRef`)
  }
  if (args.periodEnd < args.periodStart) {
    throw new EconomicsError('periodEnd is before periodStart')
  }
  if (args.clicks === 0) {
    /**
     * Zero clicks carries no information about the rate, and stored it would
     * dilute nothing while looking like data on screen. Refused rather than
     * silently dropped, so a broken export is noticed at entry.
     */
    throw new EconomicsError(
      'clicks = 0 says nothing about a conversion rate. Nothing to record.',
    )
  }

  const [row] = await db
    .insert(affiliateObservations)
    .values({
      siteId: args.siteId,
      scopeKind: args.scopeKind,
      scopeRef: args.scopeRef ?? null,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      clicks: args.clicks,
      orders: args.orders,
      saleValueMicros: args.saleValueMicros ?? null,
      commissionMicros: args.commissionMicros ?? null,
      source: args.source ?? 'manual',
      enteredBy: args.enteredBy ?? null,
      note: args.note ?? null,
    })
    .returning({ id: affiliateObservations.id })

  if (!row) throw new EconomicsError('failed to record observation')

  return {
    id: row.id,
    derived: deriveFromObservation({
      clicks: args.clicks,
      orders: args.orders,
      saleValueMicros: args.saleValueMicros ?? null,
      commissionMicros: args.commissionMicros ?? null,
    }),
  }
}

/**
 * Remove one observation.
 *
 * Hard delete rather than a soft flag: an observation is a transcription of a
 * dashboard, and a mistyped one has no history worth keeping — unlike a keyword
 * or an entity, nothing references it. Returns what was removed so a wrong
 * delete is visible immediately rather than silent.
 */
export async function forgetObservation(
  db: Database,
  id: number,
): Promise<{ clicks: number; orders: number; scope: string } | null> {
  const [row] = await db
    .delete(affiliateObservations)
    .where(eq(affiliateObservations.id, id))
    .returning({
      clicks: affiliateObservations.clicks,
      orders: affiliateObservations.orders,
      scopeKind: affiliateObservations.scopeKind,
      scopeRef: affiliateObservations.scopeRef,
    })
  if (!row) return null
  return {
    clicks: row.clicks,
    orders: row.orders,
    scope: row.scopeKind === 'site' ? 'site' : `${row.scopeKind}:${row.scopeRef}`,
  }
}

export async function listObservations(
  db: Database,
  siteId: number,
): Promise<
  Array<{
    id: number
    scope: string
    periodStart: string
    periodEnd: string
    clicks: number
    orders: number
    source: string
    note: string | null
  }>
> {
  const rows = await db
    .select()
    .from(affiliateObservations)
    .where(eq(affiliateObservations.siteId, siteId))
    .orderBy(desc(affiliateObservations.periodEnd))

  return rows.map((r) => ({
    id: r.id,
    scope: r.scopeKind === 'site' ? 'site' : `${r.scopeKind}:${r.scopeRef}`,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    clicks: r.clicks,
    orders: r.orders,
    source: r.source,
    note: r.note,
  }))
}

export interface ScopeAggregate {
  clicks: number
  orders: number
  saleValueMicros: Micros | null
  commissionMicros: Micros | null
  periodEnd: string | null
}

/**
 * Sum across rows, never average across rates.
 *
 * Averaging the rates of a 40-click week and a 40,000-click week weights them
 * equally, which is how a bad week becomes half the estimate.
 */
export async function loadObservations(
  db: Database,
  siteId: number,
): Promise<Map<string, ScopeAggregate>> {
  const rows = await db
    .select()
    .from(affiliateObservations)
    .where(eq(affiliateObservations.siteId, siteId))
    .orderBy(desc(affiliateObservations.periodEnd))

  const out = new Map<string, ScopeAggregate>()
  for (const r of rows) {
    const key = r.scopeKind === 'site' ? 'site' : `${r.scopeKind}:${r.scopeRef}`
    const cur = out.get(key) ?? {
      clicks: 0,
      orders: 0,
      saleValueMicros: null,
      commissionMicros: null,
      periodEnd: null,
    }
    cur.clicks += r.clicks
    cur.orders += r.orders
    if (r.saleValueMicros !== null) {
      cur.saleValueMicros = (cur.saleValueMicros ?? 0n) + r.saleValueMicros
    }
    if (r.commissionMicros !== null) {
      cur.commissionMicros = (cur.commissionMicros ?? 0n) + r.commissionMicros
    }
    // Rows arrive newest first, so the first one seen is the freshest.
    if (cur.periodEnd === null) cur.periodEnd = r.periodEnd
    out.set(key, cur)
  }
  return out
}

// --- The catalog everything resolves against ---------------------------------

export interface SiteEconomicsCatalog extends EconomicsCatalog {
  observations: Map<string, ScopeAggregate>
  /** Which dimension carries vendors, derived from the space's entity sets. */
  vendorDimension: string | undefined
  orderValueDimensions: string[]
}

/**
 * Assemble everything a keyword needs, in one pass.
 *
 * Loaded once per plan rather than per keyword: a 975-keyword plan resolving
 * per row would issue thousands of queries for a handful of distinct facts.
 */
export async function loadEconomicsCatalog(
  db: Database,
  siteId: number,
  opts: { asOf?: string } = {},
): Promise<SiteEconomicsCatalog> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const [site] = await db
    .select({
      orderValueMicros: sites.affiliateOrderValueMicros,
      commissionRateBps: sites.affiliateCommissionRateBps,
      keywordSpace: sites.keywordSpace,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1)

  const rateRows = await db
    .select()
    .from(affiliateCommissionRates)
    .where(eq(affiliateCommissionRates.siteId, siteId))

  const commissionRates: CommissionRate[] = rateRows.map((r) => ({
    entitySlug: r.entitySlug,
    commissionRateBps: r.commissionRateBps,
    effectiveFrom: r.effectiveFrom,
  }))

  /**
   * The legacy `sites.affiliate_commission_rate_bps` becomes a rate row dated at
   * the epoch, so there is exactly ONE resolution path. Leaving it as a separate
   * fallback branch would mean two places to look when a number is surprising.
   */
  if (
    site?.commissionRateBps != null &&
    !commissionRates.some((r) => r.entitySlug === null)
  ) {
    commissionRates.push({
      entitySlug: null,
      commissionRateBps: site.commissionRateBps,
      effectiveFrom: '1970-01-01',
    })
  }

  // Which dimensions exist, and which one holds vendors.
  const space = site?.keywordSpace ?? null
  const dims = space ? Object.entries(space.dimensions) : []
  let vendorDimension: string | undefined
  const orderValueDimensions: string[] = []
  const entitySetSlugs: string[] = []

  for (const [name, spec] of dims) {
    if (spec.source === 'entity_set' && spec.setSlug) entitySetSlugs.push(spec.setSlug)
    /**
     * A dimension is the vendor axis when its entity set is a 'brand' set.
     * Derived from the set's declared kind rather than from the dimension NAME,
     * because a name is a label somebody chose and a kind is a fact about what
     * the rows are.
     */
    if (spec.source === 'entity_set') {
      if (!vendorDimension) vendorDimension = undefined
    }
    orderValueDimensions.push(name)
  }

  const setRows =
    entitySetSlugs.length === 0
      ? []
      : await db
          .select({ slug: researchEntitySets.slug, kind: researchEntitySets.kind })
          .from(researchEntitySets)
  const brandSets = new Set(setRows.filter((s) => s.kind === 'brand').map((s) => s.slug))
  for (const [name, spec] of dims) {
    if (spec.source === 'entity_set' && spec.setSlug && brandSets.has(spec.setSlug)) {
      vendorDimension = name
    }
  }
  // Order value comes from the non-vendor dimensions first: the product, or the
  // destination, is what determines what a booking is worth — not who sells it.
  const ordered = orderValueDimensions.filter((d) => d !== vendorDimension)

  // Entity order values + the vendor roster for the min-across-vendors rule.
  const entityRows = await db
    .select({
      slug: researchEntities.slug,
      attributes: researchEntities.attributes,
      setSlug: researchEntitySets.slug,
      setKind: researchEntitySets.kind,
      active: researchEntities.active,
    })
    .from(researchEntities)
    .innerJoin(researchEntitySets, eq(researchEntitySets.id, researchEntities.setId))

  const entityOrderValueMicros: Record<string, Micros> = {}
  const vendorSlugs: string[] = []
  for (const e of entityRows) {
    const raw = e.attributes?.[ORDER_VALUE_ATTRIBUTE]
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        entityOrderValueMicros[e.slug] = BigInt(raw)
      } catch {
        // A malformed attribute is dropped rather than defaulted — resolution
        // then falls back to the site value and flags it inherited.
      }
    }
    if (e.setKind === 'brand' && e.active) vendorSlugs.push(e.slug)
  }

  return {
    asOf,
    siteDefaultOrderValueMicros: site?.orderValueMicros ?? null,
    commissionRates,
    vendorSlugs,
    entityOrderValueMicros,
    observations: await loadObservations(db, siteId),
    vendorDimension,
    orderValueDimensions: ordered,
  }
}

export interface KeywordEconomics extends ResolvedEconomics {
  conversion: ResolvedConversion | null
}

/**
 * Everything one keyword needs, resolved with provenance.
 *
 * The shrinkage chain is keyword → pattern → site, with the bound entity's
 * observations inserted when there are any. Every level that contributes is
 * recorded on `conversion.chain`, so a surprising rate is inspectable rather
 * than merely surprising.
 */
export function resolveKeywordEconomics(
  catalog: SiteEconomicsCatalog,
  keyword: {
    keywordNorm: string
    patternLabel: string | null
    entities: Record<string, string> | null
  },
): KeywordEconomics {
  const bindings: KeywordBindings = {
    entities: keyword.entities ?? {},
    vendorDimension: catalog.vendorDimension,
    orderValueDimensions: catalog.orderValueDimensions,
  }

  const resolved = resolveEconomics(catalog, bindings)

  const scopes: Array<{ label: string; observation: { clicks: number; orders: number } }> = []
  const push = (label: string): void => {
    const agg = catalog.observations.get(label)
    if (agg) scopes.push({ label, observation: { clicks: agg.clicks, orders: agg.orders } })
  }

  push(`keyword:${keyword.keywordNorm}`)
  if (keyword.patternLabel) push(`pattern:${keyword.patternLabel}`)
  for (const slug of Object.values(keyword.entities ?? {})) push(`entity:${slug}`)
  push('site')

  const siteAgg = catalog.observations.get('site')

  return {
    ...resolved,
    conversion:
      scopes.length === 0
        ? null
        : resolveConversion({
            scopes,
            periodEnd: siteAgg?.periodEnd ?? null,
          }),
  }
}
