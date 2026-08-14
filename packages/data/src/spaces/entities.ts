import 'server-only'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import type { DimensionSpec, KeywordSpace, SpaceEntity } from '@rnr/core'
import type { Database } from '../db.js'
import { researchEntities, researchEntitySets, researchGeos } from '../schema.js'

/**
 * Load the entities each dimension of a space binds.
 *
 * ==================== 'locality' IS NOT AN ENTITY SET ====================
 * A dimension sourced from `research_geos` reads the geo corpus directly.
 * Copying 300 city names into `research_entities` so the model looks uniform
 * would create a second source of truth for the same places, and the copy — the
 * one without FIPS, population or a resolved provider location code — is the one
 * somebody would eventually join on.
 *
 * The location code IS carried onto the SpaceEntity, and it is carried
 * deliberately: `geoMode: 'location_code'` needs it, and for every other mode
 * `serpLocationFor` / `volumeLocationFor` cannot reach it. Availability without
 * reachability is the design.
 * =====================================================================
 */
export async function loadDimensionEntities(
  db: Database,
  space: KeywordSpace,
): Promise<Record<string, SpaceEntity[]>> {
  const out: Record<string, SpaceEntity[]> = {}
  for (const [name, spec] of Object.entries(space.dimensions)) {
    out[name] = await loadDimension(db, spec)
  }
  return out
}

async function loadDimension(db: Database, spec: DimensionSpec): Promise<SpaceEntity[]> {
  if (spec.source === 'research_geos') {
    const rows = await db
      .select({
        market: researchGeos.market,
        stateAbbr: researchGeos.stateAbbr,
        code: researchGeos.dataforseoLocationCode,
        rank: researchGeos.selectedRank,
      })
      .from(researchGeos)
      .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))
      .orderBy(asc(researchGeos.selectedRank))
      .limit(spec.limit ?? 10_000)

    return rows.map((r) => ({
      /**
       * The LABEL is what goes into the keyword, and it is the bare market name.
       *
       * "las vegas", not "las vegas, nv" — the state suffix is how somebody
       * disambiguates a market in a spreadsheet, not how anybody searches for a
       * hotel. `recommended_explicit_modifier` exists for the local pipeline's
       * geo-explicit variant and is a different job.
       */
      slug: geoSlug(r.market, r.stateAbbr),
      label: r.market,
      aliases: r.stateAbbr ? [`${r.market} ${r.stateAbbr}`] : [],
      locationCode: r.code,
    }))
  }

  if (!spec.setSlug) {
    throw new Error('entity_set dimension has no setSlug — validateKeywordSpace should have caught this')
  }

  const [set] = await db
    .select({ id: researchEntitySets.id })
    .from(researchEntitySets)
    .where(eq(researchEntitySets.slug, spec.setSlug))
    .limit(1)

  if (!set) {
    /**
     * Loud. An unknown set slug would otherwise produce an empty dimension, and
     * an empty dimension produces zero keywords — which reads on screen as "this
     * space has no opportunities" rather than "this space was never configured".
     */
    throw new Error(
      `No research_entity_sets row with slug "${spec.setSlug}". An unknown set would generate ` +
        `zero keywords, which reads as "no opportunities" rather than "misconfigured".`,
    )
  }

  const rows = await db
    .select()
    .from(researchEntities)
    .where(and(eq(researchEntities.setId, set.id), eq(researchEntities.active, true)))
    .orderBy(asc(researchEntities.priority), asc(researchEntities.id))
    .limit(spec.limit ?? 10_000)

  return rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    aliases: r.aliases ?? [],
    locationCode: null,
    attributes: r.attributes ?? null,
  }))
}

function geoSlug(market: string, stateAbbr: string | null): string {
  const base = market.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return stateAbbr ? `${base}-${stateAbbr.toLowerCase()}` : base
}

export interface UpsertEntitySetArgs {
  slug: string
  kind: string
  label: string
  notes?: string
  entities: Array<{
    slug: string
    label: string
    aliases?: string[]
    attributes?: Record<string, unknown>
    priority?: number
  }>
}

/**
 * Create or update a set and its members. Idempotent, so a seed script can be
 * re-run after adding one peptide without producing duplicates.
 *
 * Members absent from `entities` are DEACTIVATED rather than deleted: a
 * `site_keyword_targets` row references what generated it, and deleting the
 * entity would orphan the provenance that makes a surprising keyword explainable.
 */
export async function upsertEntitySet(
  db: Database,
  args: UpsertEntitySetArgs,
): Promise<{ setId: number; upserted: number; deactivated: number }> {
  const [set] = await db
    .insert(researchEntitySets)
    .values({
      slug: args.slug,
      kind: args.kind,
      label: args.label,
      notes: args.notes ?? null,
    })
    .onConflictDoUpdate({
      target: researchEntitySets.slug,
      set: { kind: args.kind, label: args.label, notes: args.notes ?? null, updatedAt: new Date() },
    })
    .returning({ id: researchEntitySets.id })

  if (!set) throw new Error(`failed to upsert entity set ${args.slug}`)

  const keep = new Set<string>()
  let upserted = 0
  for (const [i, e] of args.entities.entries()) {
    keep.add(e.slug)
    await db
      .insert(researchEntities)
      .values({
        setId: set.id,
        slug: e.slug,
        label: e.label,
        aliases: e.aliases ?? [],
        attributes: e.attributes ?? null,
        priority: e.priority ?? i,
        active: true,
      })
      .onConflictDoUpdate({
        target: [researchEntities.setId, researchEntities.slug],
        set: {
          label: e.label,
          aliases: e.aliases ?? [],
          attributes: e.attributes ?? null,
          priority: e.priority ?? i,
          active: true,
          updatedAt: new Date(),
        },
      })
    upserted += 1
  }

  const existing = await db
    .select({ id: researchEntities.id, slug: researchEntities.slug })
    .from(researchEntities)
    .where(and(eq(researchEntities.setId, set.id), eq(researchEntities.active, true)))

  let deactivated = 0
  for (const row of existing) {
    if (keep.has(row.slug)) continue
    await db
      .update(researchEntities)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(researchEntities.id, row.id))
    deactivated += 1
  }

  return { setId: set.id, upserted, deactivated }
}
