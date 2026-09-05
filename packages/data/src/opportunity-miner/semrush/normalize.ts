import type { KeywordIntent } from '@rnr/core'
import { CODE_TO_FRIENDLY } from './columns.js'

export type SemrushRow = Record<string, string | number | null>

export function parseSemrushCsv(text: string): SemrushRow[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed || /^error/i.test(trimmed) || trimmed.startsWith('ERROR')) return []
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2) return []
  const delim = lines[0]!.includes(';') ? ';' : ','
  const headers = lines[0]!.split(delim).map((h) => friendlyName(h.trim()))
  return lines.slice(1).map((line) => {
    const cells = line.split(delim)
    const row: SemrushRow = {}
    headers.forEach((h, i) => {
      row[h] = coerce(cells[i] ?? '')
    })
    return row
  })
}

/** Accept MCP JSON rows or HTTP CSV-parsed rows. */
export function normalizeRows(payload: unknown): SemrushRow[] {
  if (Array.isArray(payload)) return payload.map((row) => normalizeRow(row))
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj['data'])) return normalizeRows(obj['data'])
    if (Array.isArray(obj['rows'])) return normalizeRows(obj['rows'])
    if (typeof obj['csv'] === 'string') return parseSemrushCsv(obj['csv'])
    if (typeof obj['text'] === 'string') return parseSemrushCsv(obj['text'])
  }
  if (typeof payload === 'string') return parseSemrushCsv(payload)
  return []
}

export function normalizeRow(row: unknown): SemrushRow {
  if (!row || typeof row !== 'object') return {}
  const out: SemrushRow = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[friendlyName(k)] = coerce(v)
  }
  return out
}

export function parseIntent(raw: string | number | null | undefined): KeywordIntent {
  const s = String(raw ?? '').toLowerCase()
  if (s.includes('transact')) return 'transactional'
  if (s.includes('commer')) return 'commercial'
  if (s.includes('navig')) return 'navigational'
  if (s.includes('inform')) return 'informational'
  return 'unknown'
}

export function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : null
}

function friendlyName(header: string): string {
  const cleaned = header.replace(/\s+/g, '_').toLowerCase()
  if (CODE_TO_FRIENDLY[header]) return CODE_TO_FRIENDLY[header]!
  if (CODE_TO_FRIENDLY[cleaned]) return CODE_TO_FRIENDLY[cleaned]!
  const aliases: Record<string, string> = {
    search_volume: 'volume',
    'search volume': 'volume',
    phrase: 'keyword',
    competition: 'competitive_density',
    keyword_difficulty_index: 'keyword_difficulty',
  }
  return aliases[cleaned] ?? aliases[header.toLowerCase()] ?? cleaned
}

function coerce(v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '' || s === 'n/a' || s === '-' || s === 'NULL') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : s
  }
  return s
}
