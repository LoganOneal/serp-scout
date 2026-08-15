import 'server-only'
import { and, eq, isNotNull } from 'drizzle-orm'
import { matchEntities, type SpaceEntity, type SupplyResolveStatus } from '@rnr/core'
import type { SupplyItem } from '@rnr/supply-feed'
import type { Database } from '../db.js'
import { researchEntities, researchEntitySets, researchGeos } from '../schema.js'

/**
 * Resolving a published listing onto the keyword grid's own vocabulary.
 *
 * ==================== WHY THIS HAPPENS HERE, NOT ON THEIR SIDE ====================
 * Their site says `{ city: "Las Vegas", region: "NV" }`. The grid says
 * `las-vegas-nv`, produced by `geoSlug(market, stateAbbr)` over `research_geos`.
 * The join between supply and demand exists only if those two meet.
 *
 * Doing it here rather than making them publish our slugs is the only option
 * that survives contact: their codebase should not have to learn our vocabulary,
 * and a slug WE renamed would otherwise silently break THEIR feed — a failure
 * whose cause is in a repo the person debugging it cannot see.
 * =================================================================================
 *
 * ==================== AND WHY IT HAS TO FAIL LOUDLY ====================
 * `ingest-geo.ts` set the standard: it fails below coverage bars rather than
 * quietly ingesting a partial corpus. Same rule, and the stakes are higher —
 * an ingest that resolves 60% of localities produces a coverage map that is 40%
 * wrong IN THE OPTIMISTIC DIRECTION, because everything it failed to place looks
 * exactly like a locality with no hotels.
 *
 * So unresolved is its own status, it is counted, and the examples are reported.
 * Never zero. Never assumed.
 * ======================================================================
 */

export interface ResolvableLocation {
  city: string
  region?: string | undefined
  country: string
}

export interface Resolution {
  status: SupplyResolveStatus
  entityKind: string | null
  entitySlug: string | null
  localityId: number | null
  /** Which rule matched, for audit. Mirrors `localities.resolution_method`. */
  method: string | null
  reason: string | null
}

const UNRESOLVED = (reason: string): Resolution => ({
  status: 'unresolved',
  entityKind: null,
  entitySlug: null,
  localityId: null,
  method: null,
  reason,
})

/**
 * The grid's slug function, reproduced.
 *
 * NOT re-exported from spaces/entities.ts because it is private there, and NOT
 * approximated: `research_keywords.keyword_norm` learned this lesson already —
 * a second normalisation convention quietly splits a catalog into two halves
 * that never join. Any change to `geoSlug` must change this line too, which is
 * why the test file asserts them equal on real rows.
 */
export function geoSlugFor(market: string, stateAbbr: string | null): string {
  const base = market.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return stateAbbr ? `${base}-${stateAbbr.toLowerCase()}` : base
}

interface GeoRow {
  market: string
  stateAbbr: string | null
  localityId: number | null
  slug: string
}

export interface LocalityResolver {
  kind: 'locality'
  resolve: (loc: ResolvableLocation | undefined) => Resolution
  /** How many geos were available to match against. Zero is itself a finding. */
  corpusSize: number
}

export interface EntitySetResolver {
  kind: 'entity_set'
  setSlug: string
  resolve: (item: Pick<SupplyItem, 'supplierName' | 'title'>) => Resolution
  corpusSize: number
}

export interface NullResolver {
  kind: 'none'
  resolve: () => Resolution
  corpusSize: 0
}

export type SupplyResolver = LocalityResolver | EntitySetResolver | NullResolver

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Build a locality resolver from the same corpus the keyword grid expands over.
 *
 * `research_geos` and not `localities`, deliberately: the grid's dimension reads
 * `research_geos` filtered to active rows with a provider location code, and a
 * supplier resolved to a `localities` slug that is not in that filtered set
 * would produce coverage for an entity no keyword row can ever bind.
 */
export async function buildLocalityResolver(db: Database): Promise<LocalityResolver> {
  const rows = await db
    .select({
      market: researchGeos.market,
      stateAbbr: researchGeos.stateAbbr,
      localityId: researchGeos.localityId,
    })
    .from(researchGeos)
    .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))

  return localityResolverFrom(rows)
}

/**
 * The matching itself, over rows already fetched.
 *
 * Split out so the ambiguity rules — the part that can silently attach a
 * property in Springfield, Missouri to Springfield, Illinois — are testable
 * without a database. `buildLocalityResolver` is then only a query.
 */
export function localityResolverFrom(
  rows: Array<{ market: string; stateAbbr: string | null; localityId: number | null }>,
): LocalityResolver {
  const geos: GeoRow[] = rows.map((r) => ({
    market: r.market,
    stateAbbr: r.stateAbbr,
    localityId: r.localityId,
    slug: geoSlugFor(r.market, r.stateAbbr),
  }))

  const byCityState = new Map<string, GeoRow>()
  const byCity = new Map<string, GeoRow[]>()
  for (const g of geos) {
    if (g.stateAbbr) byCityState.set(`${norm(g.market)}|${g.stateAbbr.toLowerCase()}`, g)
    const list = byCity.get(norm(g.market))
    if (list) list.push(g)
    else byCity.set(norm(g.market), [g])
  }

  return {
    kind: 'locality',
    corpusSize: geos.length,
    resolve(loc) {
      if (!loc) {
        return UNRESOLVED(
          'This source is configured for locality supply and the listing published no location.',
        )
      }

      const city = norm(loc.city)
      const region = loc.region?.trim().toLowerCase() ?? null

      const exact = region ? byCityState.get(`${city}|${region}`) : undefined
      if (exact) {
        return {
          status: 'resolved',
          entityKind: 'locality',
          entitySlug: exact.slug,
          localityId: exact.localityId,
          method: 'city_state',
          reason: null,
        }
      }

      const candidates = byCity.get(city) ?? []

      /**
       * A city name with no region, matching exactly one market, resolves.
       *
       * ==================== AND AN AMBIGUOUS ONE MUST NOT ====================
       * There are two Wilmingtons in Illinois and 17 name collisions in the
       * gazetteer (see geography/slug.ts). Picking the first match would attach
       * a property in Springfield, Missouri to Springfield, Illinois — and
       * nothing downstream could tell, because the coverage number would look
       * perfectly reasonable.
       * ======================================================================
       */
      if (candidates.length === 1) {
        const only = candidates[0]!
        return {
          status: 'resolved',
          entityKind: 'locality',
          entitySlug: only.slug,
          localityId: only.localityId,
          method: region ? 'city_only_region_unmatched' : 'city_only',
          reason: null,
        }
      }

      if (candidates.length > 1) {
        return UNRESOLVED(
          `"${loc.city}${loc.region ? `, ${loc.region}` : ''}" is ambiguous — it matches ` +
            `${candidates.length} markets (${candidates.slice(0, 4).map((c) => c.slug).join(', ')}` +
            `${candidates.length > 4 ? ', …' : ''}). Publish a region on this listing.`,
        )
      }

      return UNRESOLVED(
        `"${loc.city}${loc.region ? `, ${loc.region}` : ''}" is not in research_geos. Either the ` +
          `market is not in the corpus, or its name differs from the published one. This is UNKNOWN ` +
          `coverage, not zero.`,
      )
    },
  }
}

/**
 * Resolve a supplier onto a named entity set — a peptide vendor, a brand.
 *
 * The match runs over `supplierName` and falls back to `title`, using the same
 * boundary-safe `matchEntities` the keyword grid uses to attribute what already
 * ranks. Reusing it is the point: two different matchers over the same entity
 * labels would disagree, and the disagreement would look like a coverage gap.
 */
export async function buildEntitySetResolver(
  db: Database,
  setSlug: string,
): Promise<EntitySetResolver> {
  const [set] = await db
    .select({ id: researchEntitySets.id })
    .from(researchEntitySets)
    .where(eq(researchEntitySets.slug, setSlug))
    .limit(1)

  if (!set) {
    // Loud, for the same reason loadDimension is: an unknown set would resolve
    // nothing at all, which reads as "this site has no supply" rather than
    // "this source is misconfigured".
    throw new Error(
      `Supply source is bound to entity set "${setSlug}", which does not exist. Every supplier ` +
        `would land unresolved, and that reads as "no supply" rather than "misconfigured".`,
    )
  }

  const rows = await db
    .select()
    .from(researchEntities)
    .where(and(eq(researchEntities.setId, set.id), eq(researchEntities.active, true)))

  const entities: SpaceEntity[] = rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    aliases: r.aliases ?? [],
    locationCode: null,
  }))

  return {
    kind: 'entity_set',
    setSlug,
    corpusSize: entities.length,
    resolve(item) {
      for (const hay of [item.supplierName, item.title]) {
        const hits = matchEntities(norm(hay), entities)
        if (hits.length === 1) {
          return {
            status: 'resolved',
            entityKind: setSlug,
            entitySlug: hits[0]!.slug,
            localityId: null,
            method: hay === item.supplierName ? 'supplier_name' : 'title',
            reason: null,
          }
        }
        if (hits.length > 1) {
          return UNRESOLVED(
            `"${hay}" matches ${hits.length} entities in "${setSlug}" ` +
              `(${hits.slice(0, 4).map((h) => h.slug).join(', ')}). Ambiguous, so not attributed.`,
          )
        }
      }
      return UNRESOLVED(
        `Neither "${item.supplierName}" nor "${item.title}" matches any entity in "${setSlug}".`,
      )
    },
  }
}

/**
 * For a catalogue with no entity dimension at all.
 *
 * `not_applicable`, never `unresolved`. Folding them together would make a
 * perfectly correct feed report 100% resolution failure — the loud signal that
 * §4.1 depends on would then fire constantly and stop being read.
 */
export function buildNullResolver(): NullResolver {
  return {
    kind: 'none',
    corpusSize: 0,
    resolve: () => ({
      status: 'not_applicable',
      entityKind: null,
      entitySlug: null,
      localityId: null,
      method: 'no_entity_dimension',
      reason: null,
    }),
  }
}

/**
 * Pick the resolver for a source's configured `entity_kind`.
 *
 * `locality` reads research_geos. `entity_set:<slug>` reads research_entities.
 * Null means the catalogue has no entity dimension.
 */
export async function buildResolver(
  db: Database,
  entityKind: string | null,
): Promise<SupplyResolver> {
  if (!entityKind) return buildNullResolver()
  if (entityKind === 'locality') return buildLocalityResolver(db)
  if (entityKind.startsWith('entity_set:')) {
    return buildEntitySetResolver(db, entityKind.slice('entity_set:'.length))
  }
  throw new Error(
    `Unknown supply entity_kind "${entityKind}". Use 'locality', 'entity_set:<setSlug>', or null.`,
  )
}

/** Apply the right resolver input for the item shape. */
export function resolveItem(resolver: SupplyResolver, item: SupplyItem): Resolution {
  if (resolver.kind === 'locality') return resolver.resolve(item.location)
  if (resolver.kind === 'entity_set') return resolver.resolve(item)
  return resolver.resolve()
}
