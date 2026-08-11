/**
 * Semrush keyword CSV import.
 *
 * ==================== DELIBERATELY FORGIVING ====================
 * The export format is not settled -- Semrush's UI export uses human headers ("Search
 * Volume"), its API uses two-letter codes ("Nq"), and both change. A parser that demands
 * one exact shape fails on the first real file, and the failure people ship is worse than
 * an error: a partial import that looks complete. Monitor 40 of 300 keywords while
 * believing you cover all of them and the tool is lying by omission.
 *
 * So: only `keyword` is required, every other column is optional, and EVERY skipped row
 * comes back with a reason. The caller reports counts; nothing is dropped silently.
 * ===============================================================
 *
 * Pure. Takes a string, returns rows and reasons. No IO.
 */

export interface ParsedKeywordRow {
  keyword: string
  /** Semrush's reported position for YOUR domain at export time. Null = not reported. */
  position: number | null
  /** Monthly search volume. Null = not in the export, which is not zero. */
  volume: number | null
  /** Semrush keyword difficulty, 0-100. */
  difficulty: number | null
  /** Integer micros. Money never touches a float in this codebase. */
  cpcMicros: bigint | null
  /** The ranking URL Semrush reported. */
  url: string | null
}

export interface SkippedRow {
  /** 1-based line number in the ORIGINAL file, so "row 84" matches what you see. */
  line: number
  reason: string
  /** The raw line, truncated. Enough to find it in a spreadsheet. */
  raw: string
}

export interface KeywordImportResult {
  rows: ParsedKeywordRow[]
  skipped: SkippedRow[]
  /** Which canonical fields the header actually supplied. */
  columnsFound: string[]
  /** Header names present in the file that we did not recognise. Informational. */
  columnsIgnored: string[]
  delimiter: ',' | ';' | '\t'
}

export class KeywordImportError extends Error {}

/**
 * Canonical field <- accepted header aliases.
 *
 * Compared case- and separator-insensitively, so "Search Volume", "search_volume" and
 * "SearchVolume" all match. Semrush API codes are included because an API-driven export
 * emits those instead of words.
 */
const HEADER_ALIASES: Record<keyof ParsedKeywordRow, readonly string[]> = {
  keyword: ['keyword', 'ph', 'keywords', 'query', 'search term'],
  position: ['position', 'po', 'pos', 'current position', 'rank'],
  volume: ['search volume', 'volume', 'nq', 'avg monthly searches', 'monthly searches'],
  difficulty: ['keyword difficulty', 'difficulty', 'kd', 'kd %', 'competition difficulty'],
  cpcMicros: ['cpc', 'cp', 'cpc (usd)', 'cost per click'],
  url: ['url', 'ur', 'ranking url', 'landing page'],
}

function normaliseHeader(h: string): string {
  return h
    .replace(/^﻿/, '') // BOM, which Excel adds and which makes "Keyword" !== "Keyword"
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
}

/**
 * Sniff the delimiter from the header line.
 *
 * Semrush exports comma-separated, but a European locale turns that into semicolons, and
 * pasting through a spreadsheet can yield tabs. Guessing wrong makes the whole file one
 * column, which then reads as "no keyword column" -- a confusing error for a valid file.
 */
function sniffDelimiter(headerLine: string): ',' | ';' | '\t' {
  const counts: Array<[',' | ';' | '\t', number]> = [
    [',', (headerLine.match(/,/g) ?? []).length],
    [';', (headerLine.match(/;/g) ?? []).length],
    ['\t', (headerLine.match(/\t/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] === 0 ? ',' : counts[0]![0]
}

/**
 * One CSV line into fields, honouring quotes.
 *
 * Keywords contain commas ("hvac repair, tucson") and a naive split silently shifts every
 * later column by one -- so volume lands in difficulty and nothing looks wrong.
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"' // an escaped quote inside a quoted field
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === delimiter) {
      out.push(field)
      field = ''
      continue
    }
    field += c
  }
  out.push(field)
  return out.map((f) => f.trim())
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null
  // Strip thousands separators, currency symbols and stray percent signs.
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function intOrNull(raw: string | undefined, opts: { min?: number; max?: number } = {}): number | null {
  const n = num(raw)
  if (n === null) return null
  const r = Math.round(n)
  if (opts.min !== undefined && r < opts.min) return null
  if (opts.max !== undefined && r > opts.max) return null
  return r
}

function usdToMicrosOrNull(raw: string | undefined): bigint | null {
  const n = num(raw)
  if (n === null || n < 0) return null
  return BigInt(Math.round(n * 1_000_000))
}

/**
 * Parse a Semrush keyword export.
 *
 * Throws only when there is no usable header at all -- that is a wrong-file problem, not a
 * bad-row problem, and reporting it per row would bury it.
 */
export function parseKeywordCsv(text: string): KeywordImportResult {
  const lines = text.split(/\r\n|\n|\r/)
  const headerIndex = lines.findIndex((l) => l.trim() !== '')
  if (headerIndex === -1) throw new KeywordImportError('The file is empty.')

  const headerLine = lines[headerIndex]!
  const delimiter = sniffDelimiter(headerLine)
  const headers = splitCsvLine(headerLine, delimiter).map(normaliseHeader)

  // canonical field -> column index
  const map = new Map<keyof ParsedKeywordRow, number>()
  const matchedIdx = new Set<number>()
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [keyof ParsedKeywordRow, readonly string[]]
  >) {
    const idx = headers.findIndex(
      (h, i) => !matchedIdx.has(i) && aliases.includes(h.replace(/\s+/g, ' ')),
    )
    if (idx !== -1) {
      map.set(field, idx)
      matchedIdx.add(idx)
    }
  }

  if (!map.has('keyword')) {
    throw new KeywordImportError(
      `No keyword column found. Header was: ${headers.filter((h) => h !== '').join(' | ') || '(blank)'}. ` +
        `Expected one of: ${HEADER_ALIASES.keyword.join(', ')}.`,
    )
  }

  const keywordIdx = map.get('keyword')!
  const rows: ParsedKeywordRow[] = []
  const skipped: SkippedRow[] = []
  const seen = new Set<string>()

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (line.trim() === '') continue // trailing newlines are not an error worth reporting

    const fields = splitCsvLine(line, delimiter)
    const keyword = (fields[keywordIdx] ?? '').replace(/^["']|["']$/g, '').trim()

    if (keyword === '') {
      skipped.push({ line: lineNo, reason: 'No keyword in the keyword column.', raw: line.slice(0, 120) })
      continue
    }

    // Case-insensitive dedupe: Semrush exports can contain the same phrase twice with
    // different casing, and monitoring the same keyword twice doubles its cost.
    const key = keyword.toLowerCase()
    if (seen.has(key)) {
      skipped.push({ line: lineNo, reason: `Duplicate of an earlier row ("${keyword}").`, raw: line.slice(0, 120) })
      continue
    }
    seen.add(key)

    const at = (field: keyof ParsedKeywordRow): string | undefined => {
      const idx = map.get(field)
      return idx === undefined ? undefined : fields[idx]
    }

    rows.push({
      keyword,
      position: intOrNull(at('position'), { min: 1, max: 200 }),
      volume: intOrNull(at('volume'), { min: 0 }),
      difficulty: intOrNull(at('difficulty'), { min: 0, max: 100 }),
      cpcMicros: usdToMicrosOrNull(at('cpcMicros')),
      url: (at('url') ?? '').trim() === '' ? null : at('url')!.trim(),
    })
  }

  const columnsFound = [...map.keys()]
  const columnsIgnored = headers.filter((h, i) => h !== '' && !matchedIdx.has(i))

  return { rows, skipped, columnsFound, columnsIgnored, delimiter }
}
