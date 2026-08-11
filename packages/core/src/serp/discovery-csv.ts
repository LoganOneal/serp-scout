/**
 * Discovery research CSV parsers — niches (with keyword variants) and geos.
 *
 * Same forgiving discipline as Semrush keyword import (`keywords.ts`): only
 * required fields fail a row, every skip is reported with a line number, BOM
 * and delimiter sniffing included. Pure. No IO.
 */

import { splitCsvLine } from './keywords.js'
import type { LocalityKind } from '../types.js'

// Re-export skip shape so callers share one type with keyword import.
export interface DiscoverySkippedRow {
  line: number
  reason: string
  raw: string
}

// ---------------------------------------------------------------------------
// Niches
// ---------------------------------------------------------------------------

export interface ParsedDiscoveryNicheRow {
  label: string
  /** Optional slug if the CSV provides one. */
  slug: string | null
  keywordPrimary: string
  keywordNearMe: string
  /** True when near-me was synthesised as `${primary} near me`. */
  nearMeSynthesised: boolean
}

export interface DiscoveryNicheImportResult {
  rows: ParsedDiscoveryNicheRow[]
  skipped: DiscoverySkippedRow[]
  columnsFound: string[]
  columnsIgnored: string[]
  delimiter: ',' | ';' | '\t'
}

export class DiscoveryCsvError extends Error {}

type NicheField = 'label' | 'slug' | 'keywordPrimary' | 'keywordNearMe' | 'keyword'

const NICHE_ALIASES: Record<NicheField, readonly string[]> = {
  label: ['label', 'niche', 'niche name', 'name', 'category'],
  slug: ['slug', 'niche slug'],
  keywordPrimary: [
    'keyword primary',
    'primary keyword',
    'keyword',
    'keyword 1',
    'primary',
    'query',
    'search term',
  ],
  keywordNearMe: [
    'keyword near me',
    'near me',
    'near me keyword',
    'keyword 2',
    'secondary keyword',
    'keyword secondary',
  ],
  // Synonym for primary when only one keyword column exists under "keyword".
  keyword: ['keyword', 'keywords', 'query', 'search term'],
}

function normaliseHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
}

function sniffDelimiter(headerLine: string): ',' | ';' | '\t' {
  const counts: Array<[',' | ';' | '\t', number]> = [
    [',', (headerLine.match(/,/g) ?? []).length],
    [';', (headerLine.match(/;/g) ?? []).length],
    ['\t', (headerLine.match(/\t/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] === 0 ? ',' : counts[0]![0]
}

function mapHeaders(
  headers: string[],
  aliases: Record<string, readonly string[]>,
): { map: Map<string, number>; matchedIdx: Set<number> } {
  const map = new Map<string, number>()
  const matchedIdx = new Set<number>()
  for (const [field, fieldAliases] of Object.entries(aliases)) {
    const idx = headers.findIndex(
      (h, i) => !matchedIdx.has(i) && fieldAliases.includes(h.replace(/\s+/g, ' ')),
    )
    if (idx !== -1) {
      map.set(field, idx)
      matchedIdx.add(idx)
    }
  }
  return { map, matchedIdx }
}

/**
 * Parse a niches CSV for discovery.
 *
 * Required: a primary keyword (column aliases include `keyword` / `keyword primary`).
 * Label defaults to the primary keyword when omitted.
 * Near-me defaults to `${primary} near me` when the second column is missing.
 */
export function parseDiscoveryNicheCsv(text: string): DiscoveryNicheImportResult {
  const lines = text.split(/\r\n|\n|\r/)
  const headerIndex = lines.findIndex((l) => l.trim() !== '')
  if (headerIndex === -1) throw new DiscoveryCsvError('The file is empty.')

  const headerLine = lines[headerIndex]!
  const delimiter = sniffDelimiter(headerLine)
  const headers = splitCsvLine(headerLine, delimiter).map(normaliseHeader)
  const { map, matchedIdx } = mapHeaders(headers, NICHE_ALIASES)

  // Prefer explicit keywordPrimary; fall back to generic keyword column.
  const primaryIdx = map.get('keywordPrimary') ?? map.get('keyword')
  if (primaryIdx === undefined) {
    throw new DiscoveryCsvError(
      `No keyword column found. Header was: ${headers.filter((h) => h !== '').join(' | ') || '(blank)'}. ` +
        `Expected one of: ${NICHE_ALIASES.keywordPrimary.join(', ')}.`,
    )
  }

  const rows: ParsedDiscoveryNicheRow[] = []
  const skipped: DiscoverySkippedRow[] = []
  const seen = new Set<string>()

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (line.trim() === '') continue

    const fields = splitCsvLine(line, delimiter)
    const at = (field: string): string => {
      const idx = map.get(field)
      if (idx === undefined) return ''
      return (fields[idx] ?? '').replace(/^["']|["']$/g, '').trim()
    }

    const keywordPrimary = (fields[primaryIdx] ?? '').replace(/^["']|["']$/g, '').trim()
    if (keywordPrimary === '') {
      skipped.push({
        line: lineNo,
        reason: 'No primary keyword.',
        raw: line.slice(0, 120),
      })
      continue
    }

    const key = keywordPrimary.toLowerCase()
    if (seen.has(key)) {
      skipped.push({
        line: lineNo,
        reason: `Duplicate of an earlier row ("${keywordPrimary}").`,
        raw: line.slice(0, 120),
      })
      continue
    }
    seen.add(key)

    const nearRaw = at('keywordNearMe')
    const nearMeSynthesised = nearRaw === ''
    const keywordNearMe = nearMeSynthesised ? `${keywordPrimary} near me` : nearRaw

    const label = at('label') || keywordPrimary
    const slugRaw = at('slug')
    rows.push({
      label,
      slug: slugRaw === '' ? null : slugRaw,
      keywordPrimary,
      keywordNearMe,
      nearMeSynthesised,
    })
  }

  const columnsFound = [...map.keys()]
  const columnsIgnored = headers.filter((h, i) => h !== '' && !matchedIdx.has(i))
  return { rows, skipped, columnsFound, columnsIgnored, delimiter }
}

// ---------------------------------------------------------------------------
// Geos
// ---------------------------------------------------------------------------

export interface ParsedDiscoveryGeoRow {
  name: string
  /** Two-letter state code or raw state string for the resolver to normalise. */
  state: string
  population: number | null
  kind: LocalityKind | null
}

export interface DiscoveryGeoImportResult {
  rows: ParsedDiscoveryGeoRow[]
  skipped: DiscoverySkippedRow[]
  columnsFound: string[]
  columnsIgnored: string[]
  delimiter: ',' | ';' | '\t'
}

type GeoField = 'name' | 'state' | 'population' | 'kind'

const GEO_ALIASES: Record<GeoField, readonly string[]> = {
  name: ['name', 'city', 'place', 'geography', 'locality', 'geo', 'metro', 'area'],
  state: ['state', 'state code', 'state_code', 'st', 'region'],
  population: ['population', 'pop', 'pop 2020', 'pop2020', 'census population'],
  kind: ['kind', 'type', 'geo kind', 'geo_kind', 'locality kind'],
}

const KIND_MAP: Record<string, LocalityKind> = {
  city: 'city',
  place: 'city',
  town: 'city',
  municipality: 'city',
  county: 'county',
  metro: 'metro',
  msa: 'metro',
  cbsa: 'metro',
  'metro area': 'metro',
  metropolitan: 'metro',
}

function parseKind(raw: string): LocalityKind | null {
  if (raw === '') return null
  const k = KIND_MAP[raw.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()]
  return k ?? null
}

function parsePopulation(raw: string): number | null {
  if (raw === '') return null
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/**
 * Parse a top-N geographies CSV.
 *
 * Required: name and state. Missing state skips the row (never guess).
 * Kind is optional and mapped onto LocalityKind (city | county | metro only).
 */
export function parseDiscoveryGeoCsv(text: string): DiscoveryGeoImportResult {
  const lines = text.split(/\r\n|\n|\r/)
  const headerIndex = lines.findIndex((l) => l.trim() !== '')
  if (headerIndex === -1) throw new DiscoveryCsvError('The file is empty.')

  const headerLine = lines[headerIndex]!
  const delimiter = sniffDelimiter(headerLine)
  const headers = splitCsvLine(headerLine, delimiter).map(normaliseHeader)
  const { map, matchedIdx } = mapHeaders(headers, GEO_ALIASES)

  if (!map.has('name')) {
    throw new DiscoveryCsvError(
      `No name/city column found. Header was: ${headers.filter((h) => h !== '').join(' | ') || '(blank)'}. ` +
        `Expected one of: ${GEO_ALIASES.name.join(', ')}.`,
    )
  }
  if (!map.has('state')) {
    throw new DiscoveryCsvError(
      `No state column found. Header was: ${headers.filter((h) => h !== '').join(' | ') || '(blank)'}. ` +
        `State is required — missing state never guesses. Expected one of: ${GEO_ALIASES.state.join(', ')}.`,
    )
  }

  const nameIdx = map.get('name')!
  const stateIdx = map.get('state')!
  const rows: ParsedDiscoveryGeoRow[] = []
  const skipped: DiscoverySkippedRow[] = []
  const seen = new Set<string>()

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (line.trim() === '') continue

    const fields = splitCsvLine(line, delimiter)
    const name = (fields[nameIdx] ?? '').replace(/^["']|["']$/g, '').trim()
    const state = (fields[stateIdx] ?? '').replace(/^["']|["']$/g, '').trim()

    if (name === '') {
      skipped.push({ line: lineNo, reason: 'No name/city.', raw: line.slice(0, 120) })
      continue
    }
    if (state === '') {
      skipped.push({
        line: lineNo,
        reason: 'Missing state (required — never guessed).',
        raw: line.slice(0, 120),
      })
      continue
    }

    const dedupeKey = `${name.toLowerCase()}\0${state.toLowerCase()}`
    if (seen.has(dedupeKey)) {
      skipped.push({
        line: lineNo,
        reason: `Duplicate of an earlier row ("${name}, ${state}").`,
        raw: line.slice(0, 120),
      })
      continue
    }
    seen.add(dedupeKey)

    const at = (field: GeoField): string => {
      const idx = map.get(field)
      if (idx === undefined) return ''
      return (fields[idx] ?? '').replace(/^["']|["']$/g, '').trim()
    }

    const kindRaw = at('kind')
    const kind = kindRaw === '' ? null : parseKind(kindRaw)
    if (kindRaw !== '' && kind === null) {
      skipped.push({
        line: lineNo,
        reason: `Unknown kind "${kindRaw}" (use city, county, or metro).`,
        raw: line.slice(0, 120),
      })
      continue
    }

    rows.push({
      name,
      state,
      population: parsePopulation(at('population')),
      kind,
    })
  }

  const columnsFound = [...map.keys()]
  const columnsIgnored = headers.filter((h, i) => h !== '' && !matchedIdx.has(i))
  return { rows, skipped, columnsFound, columnsIgnored, delimiter }
}
