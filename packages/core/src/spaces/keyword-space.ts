/**
 * A keyword space: how one site's target keywords are generated, and — the part
 * this file exists for — WHICH LOCATION CODE each request is allowed to carry.
 *
 * ==================== THE DESTINATION IS NOT THE AUDIENCE ====================
 * The local pipeline buys `plumber` at location_code 1023191 (Kenosha). The
 * searcher and the service are in the same place, so one code serves both roles
 * and nobody ever had to name the distinction.
 *
 * `hotelhottubs.com` breaks that identity. In
 *
 *     "hotels with hot tubs in room las vegas"
 *
 * Las Vegas is the DESTINATION. The searcher is in Chicago planning a trip.
 * Buying that keyword at the Las Vegas location code measures people already IN
 * Las Vegas — residents, the one group not booking a Las Vegas hotel. It is a
 * systematic undercount of exactly the population the site monetises, and it
 * returns a plausible small number rather than an error.
 *
 * The same mistake corrupts the SERP: a query fetched from inside Las Vegas is
 * localised, and Google injects hotel and map modules it never serves a Chicago
 * searcher. `scoreDifficulty` then scores a page we are not competing on.
 *
 * `research_geos` rows carry BOTH the display name and a
 * `dataforseo_location_code`, side by side. Passing the wrong one compiles.
 * So the rule is not a convention, it is a function:
 *
 *   >> For geoMode 'in_keyword' and 'none', the entity's own location code is
 *   >> UNREACHABLE. `serpLocationFor` and `volumeLocationFor` never read it.
 *
 * And the existing US fallback in `fetchDfsKeywordVolumes` would have hidden the
 * bug: it rescues a rejected city code by retrying at 2840 and still reports
 * `source: 'dataforseo_google_ads'`. `assertRequestLocation` is the loud
 * boundary that has to fire first.
 * ===========================================================================
 */

/** United States. The same integer in DataForSEO location codes AND Google Ads geo targets. */
export const LOCATION_US = 2840

/**
 * Volume asked for with no location at all.
 *
 * DataForSEO documents `location_code` as optional — omit it and the answer is
 * worldwide. `fetchDfsKeywordVolumes` cannot express that today (a null
 * `locationCode` falls through to US), so this sentinel exists to make the ask
 * representable and distinct from "nobody set it".
 */
export const WORLDWIDE = 'WORLDWIDE' as const
export type Worldwide = typeof WORLDWIDE

/** Where geography appears — the axis that decides which code is legal. */
export type GeoMode =
  /** Geography is a request parameter. The keyword stays short. Local services. */
  | 'location_code'
  /** Geography is a token inside the keyword string. The destination. */
  | 'in_keyword'
  /** No geography at all. */
  | 'none'

/**
 * Whose demand we are measuring. Independent of `geoMode`, and it is the axis
 * the first draft of this design was missing.
 *
 * `country:XX` uses an ISO-3166 alpha-2 code. Only mapped countries are legal —
 * an unmapped one throws rather than falling back, because a silent fallback to
 * US is the failure this whole module exists to prevent.
 */
export type AudienceScope = 'worldwide' | 'per_locality' | `country:${string}`

/** ISO alpha-2 → provider location code. Extend deliberately, never guess. */
export const COUNTRY_LOCATION_CODES: Readonly<Record<string, number>> = {
  US: LOCATION_US,
  CA: 2124,
  GB: 2826,
  AU: 2036,
}

export interface DimensionSpec {
  /**
   * `research_geos` reads the existing geo corpus; `entity_set` reads
   * `research_entities`. Localities are never copied into the entity tables —
   * they already have FIPS, population and resolved provider codes.
   */
  source: 'research_geos' | 'entity_set'
  /** For `entity_set`: which set slug. Ignored for `research_geos`. */
  setSlug?: string
  /** Cap on entities pulled for this dimension, highest-priority first. */
  limit?: number
}

export interface PatternSpec {
  /** e.g. "hotels with hot tubs in room {locality}". Slots are `{dimension}`. */
  template: string
  /** Stored as `seed_key` on the generated keyword, so a grid row can be traced back. */
  label: string
  /**
   * Opt-in for templates that bind the SAME dimension twice (`{vendor} vs {vendor:2}`).
   *
   * 40 vendors is 1,560 keywords from one line; 120 products is 14,280. Volume
   * is free so the cost is fine and the ROW COUNT is not. Off unless asked for,
   * and capped when on.
   */
  pairwise?: boolean
}

export interface KeywordSpace {
  geoMode: GeoMode
  /**
   * Required. No default.
   *
   * Both current affiliate sites happen to be `country:US`, for entirely
   * different reasons — one because its destinations are domestic-traveller
   * markets, one because shipping and regulation are national. Two sites
   * agreeing is not evidence that agreement is automatic, so an unset scope is
   * a refusal to run, not a silent 2840.
   */
  audienceScope: AudienceScope
  /**
   * The ONE location every SERP in this space is fetched from.
   *
   * There is no such thing as a worldwide SERP. Volume can be scope-free; a SERP
   * is always fetched from somewhere. If Las Vegas keywords were measured from
   * Las Vegas and Aspen keywords from Aspen, the difficulty numbers would not be
   * comparable and ranking across the grid would be meaningless. Fixed per
   * space, recorded on every row, never derived from the entity.
   */
  serpLocationCode: number
  dimensions: Record<string, DimensionSpec>
  patterns: PatternSpec[]
  /**
   * Minimum avg monthly searches to survive the free volume pass.
   *
   * SCOPE-RELATIVE. 50/mo US-national and 50/mo in Kenosha are not the same
   * fact, so this is only ever compared within one `audienceScope`.
   */
  volumeFloor: number
  /** Cap for `pairwise` patterns. Drops are logged, never silent. */
  pairwiseCap?: number
}

/** One member of a dimension. Localities and entity rows both flatten to this. */
export interface SpaceEntity {
  slug: string
  /** The string substituted into a pattern. "Las Vegas", "BPC-157". */
  label: string
  /** Alternate surface forms, for matching what already ranks back to the entity. */
  aliases: string[]
  /**
   * The entity's OWN provider location code, when it has one.
   *
   * Present on localities and load-bearing only for `geoMode: 'location_code'`.
   * For every other mode this field is display and enumeration data, and reading
   * it for a request is the bug. See the banner at the top of this file.
   */
  locationCode: number | null
  attributes?: Record<string, unknown> | null
}

export class KeywordSpaceError extends Error {}

/**
 * The country code an audience scope resolves to.
 *
 * Throws on an unmapped country rather than defaulting. A wrong-but-plausible
 * location code is worse than a stopped run: the run stops loudly, the code
 * returns numbers nobody questions.
 */
export function audienceLocation(scope: AudienceScope): number | Worldwide | 'PER_LOCALITY' {
  if (scope === 'worldwide') return WORLDWIDE
  if (scope === 'per_locality') return 'PER_LOCALITY'
  const iso = scope.slice('country:'.length).toUpperCase()
  const code = COUNTRY_LOCATION_CODES[iso]
  if (code === undefined) {
    throw new KeywordSpaceError(
      `audienceScope "${scope}": no provider location code mapped for country ${iso}. ` +
        `Add it to COUNTRY_LOCATION_CODES deliberately — do not fall back to US.`,
    )
  }
  return code
}

/**
 * Where to STAND when fetching the SERP for this keyword.
 *
 * `entity` is accepted and deliberately unused for the two non-local modes. The
 * parameter is there so call sites read naturally and still cannot reach the
 * entity's code.
 */
export function serpLocationFor(space: KeywordSpace, entity?: SpaceEntity | null): number {
  if (space.geoMode === 'location_code') {
    const code = entity?.locationCode ?? null
    if (code === null) {
      throw new KeywordSpaceError(
        `geoMode 'location_code' needs the entity's own provider location code, and ` +
          `${entity?.slug ?? '(no entity)'} has none. An unresolved locality is excluded, never widened.`,
      )
    }
    return code
  }
  // in_keyword / none: the entity is a STRING here, not a place we stand.
  return space.serpLocationCode
}

/**
 * Which location the free volume call is allowed to carry.
 *
 * Returns the WORLDWIDE sentinel rather than a number when the scope has no
 * location, so a caller cannot accidentally coerce "no location" into 2840 —
 * which is precisely what the provider does today.
 */
export function volumeLocationFor(
  space: KeywordSpace,
  entity?: SpaceEntity | null,
): number | Worldwide {
  const resolved = audienceLocation(space.audienceScope)
  if (resolved === 'PER_LOCALITY') {
    if (space.geoMode !== 'location_code') {
      throw new KeywordSpaceError(
        `audienceScope 'per_locality' is only meaningful with geoMode 'location_code'. ` +
          `On an '${space.geoMode}' space the entity is a destination, not an audience.`,
      )
    }
    return serpLocationFor(space, entity)
  }
  return resolved
}

/**
 * The loud boundary. Call this immediately before any priced request.
 *
 * It exists because at `country:US` the correct code (2840) and the dangerous
 * code (the destination's) are both plain integers sitting in the same
 * `research_geos` row, and the provider's own US fallback would absorb the
 * mistake without reporting it.
 */
export function assertRequestLocation(
  space: KeywordSpace,
  used: number | Worldwide,
  entity?: SpaceEntity | null,
): void {
  if (space.geoMode === 'location_code') return
  const entityCode = entity?.locationCode ?? null
  if (entityCode !== null && used === entityCode) {
    throw new KeywordSpaceError(
      `Refusing to buy at location_code ${entityCode} (${entity?.label ?? entity?.slug}): on a ` +
        `'${space.geoMode}' space that code is the DESTINATION, not the audience. ` +
        `Measuring it would return residents of ${entity?.label ?? 'the destination'} ` +
        `instead of the travellers this site monetises. Use serpLocationFor/volumeLocationFor.`,
    )
  }
}

/**
 * Human-readable provenance stored beside every measurement.
 *
 * `us/en`, not `US`: `language: languageConstants/1000` is hardcoded English in
 * the Google Ads path, so Spanish-language US demand is invisible. The label
 * says what was actually measured.
 */
export function volumeScopeLabel(space: KeywordSpace, used: number | Worldwide): string {
  if (used === WORLDWIDE) return 'worldwide/en'
  if (used === LOCATION_US) return 'us/en'
  return `location_code=${used}/en`
}

/**
 * Do the local-only models mean anything on this space?
 *
 * ==================== THREE MODELS THAT LIE CONFIDENTLY ====================
 * Each of these is correct and load-bearing for local services, and each fails
 * SILENTLY and OPTIMISTICALLY when handed a non-local keyword:
 *
 *   assessEmd / assessAcquiredDomain
 *       `not_a_local_query` fires on every affiliate keyword by construction —
 *       there is no local pack on "hotels with hot tubs in room las vegas" and
 *       there never will be. The result reads as a hard negative verdict when
 *       the truth is that the model does not apply.
 *
 *   estimateDemand (population x demandPerCapitaPer1k)
 *       A substitute for a number that cannot be bought at city scale. At
 *       national scope the real number is free, so a modelled figure here is
 *       strictly worse than the one we already have.
 *
 *   PLATFORM_DOMAINS
 *       Knows Yelp and Angi, not Booking and Expedia. See
 *       VERTICAL_PLATFORM_DOMAINS.
 *
 * Returning a reason rather than a boolean so the screen can say WHY a column is
 * blank. A blank cell with no explanation is the thing that gets refilled with a
 * default by the next person to look at it.
 * =========================================================================
 */
export function localModelsApply(
  space: Pick<KeywordSpace, 'geoMode'>,
): { applies: true } | { applies: false; reason: string } {
  if (space.geoMode === 'location_code') return { applies: true }
  return {
    applies: false,
    reason:
      `Not applicable: the EMD, acquired-domain and population-demand models assume the searcher ` +
      `and the subject share a location. On a '${space.geoMode}' space they do not.`,
  }
}

/** Structural problems that must stop a run before it spends anything. */
export function validateKeywordSpace(space: KeywordSpace): string[] {
  const errors: string[] = []

  if (!space.audienceScope) {
    errors.push('audienceScope is required and has no default')
  } else {
    try {
      audienceLocation(space.audienceScope)
    } catch (e) {
      errors.push((e as Error).message)
    }
  }

  if (!Number.isInteger(space.serpLocationCode) || space.serpLocationCode <= 0) {
    errors.push('serpLocationCode must be a positive provider location code')
  }
  if (space.patterns.length === 0) errors.push('a space with no patterns generates nothing')
  if (!Number.isFinite(space.volumeFloor) || space.volumeFloor < 0) {
    errors.push('volumeFloor must be a non-negative number')
  }

  const declared = new Set(Object.keys(space.dimensions))
  for (const p of space.patterns) {
    const slots = patternSlots(p.template)
    if (slots.length === 0 && declared.size > 0) {
      // Not an error — a constant head term is legitimate — but a template that
      // meant to bind and typo'd the slot name looks exactly like this.
      continue
    }
    for (const s of slots) {
      if (!declared.has(s.dimension)) {
        errors.push(`pattern "${p.label}" binds {${s.raw}} but dimension "${s.dimension}" is not declared`)
      }
      if (s.ordinal > 1 && !p.pairwise) {
        errors.push(
          `pattern "${p.label}" binds {${s.raw}} — a repeated dimension needs pairwise: true, ` +
            `because it multiplies the row count by the size of the set`,
        )
      }
    }
  }

  for (const [name, dim] of Object.entries(space.dimensions)) {
    if (dim.source === 'entity_set' && !dim.setSlug) {
      errors.push(`dimension "${name}" is an entity_set with no setSlug`)
    }
  }

  if (space.geoMode === 'location_code' && space.audienceScope !== 'per_locality') {
    errors.push(
      `geoMode 'location_code' with audienceScope '${space.audienceScope}': a local space ` +
        `measures the locality it buys, not a country aggregate`,
    )
  }

  return errors
}

export interface PatternSlot {
  /** Text between the braces, e.g. `locality` or `product:2`. */
  raw: string
  dimension: string
  /** 1 for `{product}`, 2 for `{product:2}`. */
  ordinal: number
}

const SLOT_RE = /\{([a-z0-9_]+)(?::(\d+))?\}/gi

export function patternSlots(template: string): PatternSlot[] {
  const out: PatternSlot[] = []
  for (const m of template.matchAll(SLOT_RE)) {
    const dimension = (m[1] ?? '').toLowerCase()
    const ordinal = m[2] ? Number(m[2]) : 1
    out.push({ raw: m[0].slice(1, -1), dimension, ordinal })
  }
  return out
}

/**
 * The one normalisation. Matches `opportunity-screen.ts:450` exactly, because
 * `research_keywords.keyword_norm` is UNIQUE and a second convention would
 * quietly split the catalog into two halves that never dedupe against each
 * other.
 */
export function normaliseKeyword(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}
