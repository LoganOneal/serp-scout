import type { LocalityKind, ProviderLocation, ProviderLocationType } from '../types.js'
import {
  abbreviationVariants,
  bareCountyName,
  nameCandidates,
  normaliseForLookup,
} from './names.js'

/**
 * Matching Census places onto DataForSEO location codes.
 *
 * Two independent failure modes are guarded here, and both are silent:
 *
 * 1. WIDENING. "Kenosha, Wisconsin" happily matches the Wisconsin *Region* row.
 *    The resulting SERP is a statewide SERP -- perfectly well-formed, completely
 *    wrong, and indistinguishable downstream from a correct one. Every lookup
 *    therefore passes explicit acceptTypes, and a locality that matches nothing
 *    of an accepted type is left UNRESOLVED rather than substituted with a
 *    broader code. An unresolved locality is excluded from scanning; a widened
 *    one poisons the results.
 *
 * 2. INCONSISTENT COUNTY QUALIFICATION. The provider is not uniform about
 *    whether a city row carries its county. Most are `Kenosha,Wisconsin,United
 *    States`, but some are `McKinney,Collin County,Texas,United States` -- and
 *    some of THOSE omit the word "County": `Orange,Orange,California,United
 *    States`. All three forms must be tried. McKinney is a city of 227,000 and
 *    was missing from the corpus entirely until the second form was added.
 */

/** Which provider location types are acceptable for each locality kind. */
export const ACCEPT_TYPES: Record<LocalityKind, ProviderLocationType[]> = {
  city: ['City'],
  county: ['County'],
  // Metros are DMA Regions where the provider has one; some are only carried as
  // the anchor City, which is an acceptable stand-in for a metro-wide scan.
  metro: ['DMA Region', 'City'],
}

export interface ResolvableLocality {
  kind: LocalityKind
  /** Raw Census name -- candidate generation handles the cleanup itself. */
  rawName: string
  stateName: string
  /** Required: consolidated-city aliases are state-scoped (Boise City ID vs OK). */
  stateCode: string
  countyName: string | null
}

/**
 * A lookup index over the provider's location dump (267,107 rows, free from
 * /serp/google/locations).
 *
 * Keyed on normalised full location_name AND on type, so a name can never match
 * across types. Multiple rows can share a normalised name (that is exactly the
 * problem), so values are arrays.
 */
export class ProviderLocationIndex {
  private readonly byName = new Map<string, ProviderLocation[]>()

  constructor(locations: Iterable<ProviderLocation>) {
    for (const loc of locations) {
      const key = normaliseForLookup(loc.locationName)
      const list = this.byName.get(key)
      if (list) list.push(loc)
      else this.byName.set(key, [loc])
    }
  }

  get size(): number {
    return this.byName.size
  }

  lookup(fullName: string, acceptTypes: readonly ProviderLocationType[]): ProviderLocation | null {
    const rows = this.byName.get(normaliseForLookup(fullName))
    if (!rows) return null
    // NEVER widen: only an accepted type counts as a match.
    const accepted = rows.filter((r) => acceptTypes.includes(r.locationType))
    if (accepted.length === 0) return null
    // Deterministic pick when the provider genuinely has duplicates: lowest code.
    return accepted.reduce((a, b) => (a.locationCode <= b.locationCode ? a : b))
  }
}

export interface Candidate {
  fullName: string
  /** Which rule produced this candidate, recorded on the locality for audit. */
  method: string
}

/**
 * Every provider name form worth trying, most likely first.
 *
 * Forms, in order:
 *   1. `{name},{state},United States`                 -- the common case
 *   2. `{name},{county} County,{state},United States` -- e.g. McKinney, TX
 *   3. `{name},{county},{state},United States`        -- e.g. Orange, CA
 */
export function candidateProviderNames(l: ResolvableLocality): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const push = (fullName: string, method: string) => {
    const key = normaliseForLookup(fullName)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ fullName, method })
  }

  const names = nameCandidates(l.rawName, l.stateCode)

  if (l.kind === 'county') {
    // Counties are carried with the word County present, and the Census name
    // already includes it. Try bare too, for Louisiana parishes and Alaska.
    for (const n of names) {
      push(`${n},${l.stateName},United States`, 'county:asis')
      const bare = bareCountyName(n)
      if (bare !== n) push(`${bare} County,${l.stateName},United States`, 'county:normalised')
    }
    return out
  }

  if (l.kind === 'metro') {
    // A CBSA is named "Principal City-Second City, ST-ST" -- "Kenosha-Racine, WI".
    // The provider carries metros either as a DMA Region or not at all, in which
    // case the anchor City is an acceptable stand-in for a metro-wide scan.
    //
    // Progressively shorter hyphen prefixes, LONGEST FIRST. That ordering is the
    // whole trick: "Winston-Salem, NC" must try "Winston-Salem" before "Winston",
    // or the metro resolves to a city that does not exist. Splitting on the
    // hyphen and taking the first segment -- the obvious implementation -- breaks
    // Winston-Salem, Wilkes-Barre and every other genuinely hyphenated anchor.
    const namePart = (l.rawName.split(',')[0] ?? l.rawName).trim()
    const segments = namePart.split('-')
    const prefixes: string[] = []
    for (let take = segments.length; take >= 1; take--) {
      prefixes.push(segments.slice(0, take).join('-').trim())
    }

    for (const prefix of prefixes) {
      if (!prefix) continue
      // CBSA names carry New England legal suffixes the city rows do not:
      // "Barnstable Town, MA" and "Amherst Town-Northampton, MA".
      const forms = new Set([prefix, prefix.replace(/\s+(Town|Township|City)$/i, '').trim()])
      for (const form of forms) {
        if (!form) continue
        for (const abbrev of abbreviationVariants(form)) {
          push(`${abbrev},${l.stateName},United States`, 'metro:anchor-city')
          // DMA rows are named "Milwaukee WI,United States" when they exist.
          push(`${abbrev} ${l.stateCode},United States`, 'metro:dma')
        }
      }
    }
    for (const n of names) {
      push(`${n},${l.stateName},United States`, 'metro:name-state')
    }
    return out
  }

  for (const n of names) {
    push(`${n},${l.stateName},United States`, 'city:name-state')
  }
  if (l.countyName) {
    const bare = bareCountyName(l.countyName)
    for (const n of names) {
      // Form 2: with the word "County".
      push(`${n},${bare} County,${l.stateName},United States`, 'city:with-county-word')
      // Form 3: county segment WITHOUT the word "County" -- Orange,Orange,California.
      push(`${n},${bare},${l.stateName},United States`, 'city:county-bare')
      // And the county name exactly as Census wrote it, for Parish/Borough.
      if (l.countyName !== `${bare} County`) {
        push(`${n},${l.countyName},${l.stateName},United States`, 'city:county-verbatim')
      }
    }
  }
  return out
}

export interface Resolution {
  locationCode: number
  locationName: string
  locationType: ProviderLocationType
  method: string
}

export interface ResolutionFailure {
  resolved: false
  /** Human-readable, and logged in a sample by the ingest so bad rules surface. */
  reason: string
  triedCount: number
  firstTried: string | null
}

export type ResolveResult = ({ resolved: true } & Resolution) | ResolutionFailure

export function resolveLocality(
  l: ResolvableLocality,
  index: ProviderLocationIndex,
): ResolveResult {
  const candidates = candidateProviderNames(l)
  const acceptTypes = ACCEPT_TYPES[l.kind]

  for (const c of candidates) {
    const hit = index.lookup(c.fullName, acceptTypes)
    if (hit) {
      return {
        resolved: true,
        locationCode: hit.locationCode,
        locationName: hit.locationName,
        locationType: hit.locationType,
        method: c.method,
      }
    }
  }

  // Diagnostic ONLY. Tells us whether the name exists at some other type, which
  // distinguishes "provider doesn't carry this place" from "we would have had to
  // widen to match it" -- the latter being a correct refusal, not a bug.
  let widerTypeNote = ''
  for (const c of candidates) {
    const anyType = index.lookup(c.fullName, ANY_TYPE)
    if (anyType) {
      widerTypeNote = ` Name exists as type "${anyType.locationType}" (code ${anyType.locationCode}); refused because only ${acceptTypes.join('/')} is acceptable for a ${l.kind}.`
      break
    }
  }

  return {
    resolved: false,
    reason: `No provider location of type ${acceptTypes.join('/')} for "${l.rawName}" (${l.stateName}).${widerTypeNote}`,
    triedCount: candidates.length,
    firstTried: candidates[0]?.fullName ?? null,
  }
}

/** Every type the provider publishes. Diagnostics only -- never used to match. */
const ANY_TYPE: ProviderLocationType[] = [
  'City',
  'County',
  'DMA Region',
  'Region',
  'State',
  'Country',
  'Municipality',
  'Neighborhood',
  'Province',
  'Autonomous Community',
  'Airport',
  'Union Territory',
  'Territory',
  'District',
  'Governorate',
  'Prefecture',
  'Department',
  'Canton',
  'Okrug',
  'Oblast',
  'Krai',
  'Federal District',
]
