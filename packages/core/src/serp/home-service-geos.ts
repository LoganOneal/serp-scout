/**
 * Parse home_service_geographies CSV (pre-resolved DataForSEO codes).
 * Pure. No IO.
 */

import { splitCsvLine } from './keywords.js'
import type { LocalityKind } from '../types.js'

export interface HomeServiceGeoRow {
  market: string
  state: string | null
  stateAbbr: string | null
  population2025: number | null
  selectedRank: number | null
  testTier: string | null
  dataforseoLocationCode: number | null
  dataforseoLocationName: string | null
  dataforseoLocationType: string | null
  naturalQueryModifier: string | null
  disambiguatedQueryModifier: string | null
  recommendedExplicitModifier: string | null
  extra: Record<string, string>
  lineNumber: number
}

export interface HomeServiceGeoSkipped {
  line: number
  reason: string
  raw: string
}

export interface HomeServiceGeosImportResult {
  rows: HomeServiceGeoRow[]
  skipped: HomeServiceGeoSkipped[]
  columnsFound: string[]
  delimiter: ',' | ';' | '\t'
}

export class HomeServiceGeosParseError extends Error {}

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

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return Math.round(n)
}

/**
 * Parse home_service_geographies_200-style CSV.
 * Required: market (or name) AND (state/state_abbr OR dataforseo_location_code).
 */
export function parseHomeServiceGeographiesCsv(text: string): HomeServiceGeosImportResult {
  const lines = text.split(/\r\n|\n|\r/)
  const headerIndex = lines.findIndex((l) => l.trim() !== '')
  if (headerIndex === -1) throw new HomeServiceGeosParseError('The file is empty.')

  const headerLine = lines[headerIndex]!
  const delimiter = sniffDelimiter(headerLine)
  const headers = splitCsvLine(headerLine, delimiter).map(normaliseHeader)

  const idx = (aliases: string[]): number => {
    for (const a of aliases) {
      const i = headers.findIndex((h) => h === a)
      if (i !== -1) return i
    }
    return -1
  }

  const marketIdx = idx(['market', 'name', 'city', 'place', 'geography', 'locality'])
  const stateIdx = idx(['state', 'state name'])
  const abbrIdx = idx(['state abbr', 'state_abbr', 'state code', 'st'])
  const popIdx = idx(['population 2025', 'population', 'pop'])
  const rankIdx = idx(['selected rank', 'selected_rank', 'rank'])
  const tierIdx = idx(['test tier', 'test_tier', 'tier'])
  const codeIdx = idx([
    'dataforseo location code',
    'dataforseo_location_code',
    'location code',
    'location_code',
  ])
  const codeNameIdx = idx(['dataforseo location name', 'dataforseo_location_name'])
  const codeTypeIdx = idx(['dataforseo location type', 'dataforseo_location_type'])
  const natIdx = idx(['natural query modifier', 'natural_query_modifier'])
  const disIdx = idx(['disambiguated query modifier', 'disambiguated_query_modifier'])
  const recIdx = idx(['recommended explicit modifier', 'recommended_explicit_modifier'])

  if (marketIdx === -1) {
    throw new HomeServiceGeosParseError(
      `No market/name column. Headers: ${headers.filter(Boolean).join(' | ')}`,
    )
  }

  const known = new Set(
    [marketIdx, stateIdx, abbrIdx, popIdx, rankIdx, tierIdx, codeIdx, codeNameIdx, codeTypeIdx, natIdx, disIdx, recIdx].filter(
      (i) => i >= 0,
    ),
  )

  const rows: HomeServiceGeoRow[] = []
  const skipped: HomeServiceGeoSkipped[] = []
  const seen = new Set<string>()

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (line.trim() === '') continue
    const fields = splitCsvLine(line, delimiter)
    const market = (fields[marketIdx] ?? '').replace(/^["']|["']$/g, '').trim()
    const state = stateIdx >= 0 ? (fields[stateIdx] ?? '').trim() || null : null
    const stateAbbr = abbrIdx >= 0 ? (fields[abbrIdx] ?? '').trim() || null : null
    const code = codeIdx >= 0 ? intOrNull(fields[codeIdx]) : null

    if (market === '') {
      skipped.push({ line: lineNo, reason: 'Missing market/name.', raw: line.slice(0, 120) })
      continue
    }
    if (!state && !stateAbbr && code === null) {
      skipped.push({
        line: lineNo,
        reason: 'Need state/state_abbr or dataforseo_location_code.',
        raw: line.slice(0, 120),
      })
      continue
    }

    const key =
      code !== null
        ? `code:${code}`
        : `${market.toLowerCase()}\0${(stateAbbr ?? state ?? '').toLowerCase()}`
    if (seen.has(key)) {
      skipped.push({
        line: lineNo,
        reason: `Duplicate of earlier row ("${market}").`,
        raw: line.slice(0, 120),
      })
      continue
    }
    seen.add(key)

    const extra: Record<string, string> = {}
    headers.forEach((h, hi) => {
      if (h === '' || known.has(hi)) return
      const v = (fields[hi] ?? '').trim()
      if (v !== '') extra[h] = v
    })

    rows.push({
      market,
      state,
      stateAbbr,
      population2025: popIdx >= 0 ? intOrNull(fields[popIdx]) : null,
      selectedRank: rankIdx >= 0 ? intOrNull(fields[rankIdx]) : null,
      testTier: tierIdx >= 0 ? (fields[tierIdx] ?? '').trim() || null : null,
      dataforseoLocationCode: code,
      dataforseoLocationName: codeNameIdx >= 0 ? (fields[codeNameIdx] ?? '').trim() || null : null,
      dataforseoLocationType: codeTypeIdx >= 0 ? (fields[codeTypeIdx] ?? '').trim() || null : null,
      naturalQueryModifier: natIdx >= 0 ? (fields[natIdx] ?? '').trim() || null : null,
      disambiguatedQueryModifier: disIdx >= 0 ? (fields[disIdx] ?? '').trim() || null : null,
      recommendedExplicitModifier: recIdx >= 0 ? (fields[recIdx] ?? '').trim() || null : null,
      extra,
      lineNumber: lineNo,
    })
  }

  return {
    rows,
    skipped,
    columnsFound: headers.filter((h) => h !== ''),
    delimiter,
  }
}

export type { LocalityKind }
