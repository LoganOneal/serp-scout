import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { cleanCensusName, type LocalityKind } from '@rnr/core'
import type { Database } from '../db.js'
import { localities } from '../schema.js'
import type { DiscoveryGeoResolveStatus } from '../schema.js'

/**
 * Map operator CSV geographies onto existing localities + provider codes.
 *
 * Never widens unresolved codes. Live runs require location_source = dataforseo
 * for a purchasable geo (unscannable_source otherwise).
 */

export interface DiscoveryGeoInput {
  name: string
  state: string
  population?: number | null
  kind?: LocalityKind | null
  lineNumber?: number | null
  /**
   * Pre-resolved DataForSEO code (catalog import). When set, name/state matching is
   * skipped; localityId may still be null.
   */
  providerLocationCode?: number | null
  localityId?: number | null
  locationSource?: string | null
  /** Catalog FK threaded into jobs. */
  researchGeoId?: number | null
  /**
   * Locality as a searcher types it ("new york city"), curated per market on
   * import. Drives the geo-explicit keyword variant.
   */
  queryModifier?: string | null
}

export interface ResolvedDiscoveryGeo {
  rawName: string
  rawState: string | null
  rawPopulation: number | null
  rawKind: string | null
  localityId: number | null
  providerLocationCode: number | null
  locationSource: string | null
  resolveStatus: DiscoveryGeoResolveStatus
  unmatchedReason: string | null
  candidateCount: number | null
  lineNumber: number | null
  /** Populated when resolved — for job creation. */
  localityName: string | null
  stateCode: string | null
  researchGeoId: number | null
  /** See DiscoveryGeoInput.queryModifier. Null when the market has none. */
  queryModifier: string | null
}

const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
}

export function normaliseStateCode(raw: string): string | null {
  const t = raw.trim()
  if (t === '') return null
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
  const key = t.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  return STATE_BY_NAME[key] ?? null
}

function kindsToTry(input: DiscoveryGeoInput, cleanedName: string): LocalityKind[] {
  if (input.kind) return [input.kind]
  // "Cook County" without kind → prefer county.
  if (/\bcounty\b/i.test(input.name) || /\bcounty\b/i.test(cleanedName)) {
    return ['county', 'city', 'metro']
  }
  return ['city', 'metro', 'county']
}

type LocRow = {
  id: number
  name: string
  kind: LocalityKind
  stateCode: string
  population: number | null
  providerLocationCode: number | null
  locationSource: string | null
}

function pickCandidate(
  candidates: LocRow[],
  rawPop: number | null,
): { row: LocRow | null; reason: string | null } {
  if (candidates.length === 0) return { row: null, reason: 'no_locality_match' }
  if (candidates.length === 1) return { row: candidates[0]!, reason: null }

  if (rawPop !== null) {
    const scored = [...candidates].sort((a, b) => {
      const da = Math.abs((a.population ?? 0) - rawPop)
      const db = Math.abs((b.population ?? 0) - rawPop)
      if (da !== db) return da - db
      return (b.population ?? 0) - (a.population ?? 0)
    })
    const best = scored[0]!
    const second = scored[1]!
    const dBest = Math.abs((best.population ?? 0) - rawPop)
    const dSecond = Math.abs((second.population ?? 0) - rawPop)
    if (dBest === dSecond && (best.population ?? 0) === (second.population ?? 0)) {
      return { row: null, reason: 'ambiguous_name' }
    }
    return { row: best, reason: null }
  }

  const byPop = [...candidates].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
  const top = byPop[0]!
  const second = byPop[1]
  if (second && (second.population ?? 0) === (top.population ?? 0)) {
    return { row: null, reason: 'ambiguous_name' }
  }
  return { row: top, reason: null }
}

export async function resolveDiscoveryGeos(
  db: Database,
  inputs: DiscoveryGeoInput[],
  opts: { usedFixtures: boolean },
): Promise<ResolvedDiscoveryGeo[]> {
  const out: ResolvedDiscoveryGeo[] = []

  for (const input of inputs) {
    const lineNumber = input.lineNumber ?? null
    const rawState = input.state?.trim() || null
    const base: ResolvedDiscoveryGeo = {
      rawName: input.name.trim(),
      rawState,
      rawPopulation: input.population ?? null,
      rawKind: input.kind ?? null,
      localityId: null,
      providerLocationCode: null,
      locationSource: null,
      resolveStatus: 'unresolved',
      unmatchedReason: null,
      candidateCount: null,
      lineNumber,
      localityName: null,
      stateCode: null,
      researchGeoId: input.researchGeoId ?? null,
      queryModifier: input.queryModifier?.trim() || null,
    }

    // Catalog path: pre-resolved DFS code is authoritative (locality optional).
    // Soft-matched localities often carry location_source=google_geotargets; that
    // must NOT poison the spend gate when the CSV already supplied a code.
    if (input.providerLocationCode != null && Number.isFinite(input.providerLocationCode)) {
      const code = Math.trunc(input.providerLocationCode)
      let localityId = input.localityId ?? null
      let localityName: string | null = input.name.trim() || null
      let stateCode: string | null = rawState ? normaliseStateCode(rawState) : null
      // Code came from catalog import — keep csv_preresolved (or explicit input).
      const locationSource =
        input.locationSource && input.locationSource.trim() !== ''
          ? input.locationSource
          : 'csv_preresolved'

      if (localityId !== null) {
        const [loc] = await db
          .select({
            id: localities.id,
            name: localities.name,
            stateCode: localities.stateCode,
          })
          .from(localities)
          .where(eq(localities.id, localityId))
          .limit(1)
        if (loc) {
          localityName = loc.name
          stateCode = loc.stateCode
        }
      }

      out.push({
        ...base,
        localityId,
        providerLocationCode: code,
        locationSource,
        resolveStatus: 'resolved',
        unmatchedReason: null,
        localityName,
        stateCode,
        candidateCount: 1,
      })
      continue
    }

    if (!rawState) {
      out.push({ ...base, unmatchedReason: 'missing_state' })
      continue
    }

    const stateCode = normaliseStateCode(rawState)
    if (!stateCode) {
      out.push({ ...base, unmatchedReason: 'bad_state' })
      continue
    }

    const cleaned = cleanCensusName(input.name.trim(), stateCode)
    const kinds = kindsToTry(input, cleaned)

    // Try kinds in order; first non-empty candidate set wins for "default policy".
    let candidates: LocRow[] = []
    for (const kind of kinds) {
      const rows = await db
        .select({
          id: localities.id,
          name: localities.name,
          kind: localities.kind,
          stateCode: localities.stateCode,
          population: localities.population,
          providerLocationCode: localities.providerLocationCode,
          locationSource: localities.locationSource,
        })
        .from(localities)
        .where(
          and(
            eq(localities.stateCode, stateCode),
            eq(localities.kind, kind),
            sql`lower(${localities.name}) = ${cleaned.toLowerCase()}`,
          ),
        )
      if (rows.length > 0) {
        candidates = rows as LocRow[]
        break
      }
    }

    // Fallback: search_text contains name + state (handles slight name variants).
    if (candidates.length === 0) {
      const rows = await db
        .select({
          id: localities.id,
          name: localities.name,
          kind: localities.kind,
          stateCode: localities.stateCode,
          population: localities.population,
          providerLocationCode: localities.providerLocationCode,
          locationSource: localities.locationSource,
        })
        .from(localities)
        .where(
          and(
            eq(localities.stateCode, stateCode),
            inArray(localities.kind, kinds),
            sql`${localities.searchText} LIKE ${'%' + cleaned.toLowerCase() + '%'}`,
          ),
        )
      // Prefer exact lower(name) among search hits.
      const exact = rows.filter((r) => r.name.toLowerCase() === cleaned.toLowerCase())
      candidates = (exact.length > 0 ? exact : rows) as LocRow[]
    }

    const { row, reason } = pickCandidate(candidates, input.population ?? null)
    base.candidateCount = candidates.length

    if (!row) {
      out.push({ ...base, unmatchedReason: reason ?? 'no_locality_match' })
      continue
    }

    if (row.providerLocationCode === null) {
      out.push({
        ...base,
        localityId: row.id,
        unmatchedReason: 'no_provider_code',
        localityName: row.name,
        stateCode: row.stateCode,
      })
      continue
    }

    // Live spend needs a real location code. Ingest often labels codes as
    // google_geotargets (full US corpus) when DataForSEO locations were unavailable;
    // those codes still work as DFS location_code for US cities (same IDs in practice).
    // Only refuse unknown / missing sources without a code (handled above).
    const src = row.locationSource
    const spendableSource =
      src === 'dataforseo' ||
      src === 'google_geotargets' ||
      src === 'csv_preresolved' ||
      src === null // code present but source unset — still try

    if (!opts.usedFixtures && !spendableSource) {
      out.push({
        ...base,
        localityId: row.id,
        providerLocationCode: row.providerLocationCode,
        locationSource: row.locationSource,
        resolveStatus: 'unscannable_source',
        unmatchedReason: `location_source=${row.locationSource ?? 'null'} (not a known SERP code source)`,
        localityName: row.name,
        stateCode: row.stateCode,
      })
      continue
    }

    out.push({
      ...base,
      localityId: row.id,
      providerLocationCode: row.providerLocationCode,
      locationSource: row.locationSource,
      resolveStatus: 'resolved',
      unmatchedReason: null,
      localityName: row.name,
      stateCode: row.stateCode,
    })
  }

  return out
}
