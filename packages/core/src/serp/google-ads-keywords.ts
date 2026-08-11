/**
 * Parse Google Ads "Saved Keywords Stats" export (tab-separated, meta lines).
 * Pure. No IO.
 */

import { splitCsvLine } from './keywords.js'

export interface GoogleAdsKeywordRow {
  keyword: string
  keywordNorm: string
  seedKey: string
  variant: 'primary' | 'near_me' | 'other'
  avgMonthlySearches: number | null
  competition: string | null
  competitionIndex: number | null
  topOfPageBidLowMicros: bigint | null
  topOfPageBidHighMicros: bigint | null
  topOfPageBidRaw: string | null
  inAccount: string | null
  monthlySeries: Record<string, number | null>
  lineNumber: number
}

export interface GoogleAdsSkipped {
  line: number
  reason: string
  raw: string
}

export interface GoogleAdsKeywordsImportResult {
  rows: GoogleAdsKeywordRow[]
  skipped: GoogleAdsSkipped[]
  columnsFound: string[]
  dateRangeRaw: string | null
  titleRaw: string | null
  delimiter: '\t' | ',' | ';'
}

export class GoogleAdsKeywordsParseError extends Error {}

function normaliseHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
}

function sniffDelimiter(headerLine: string): '\t' | ',' | ';' {
  const counts: Array<['\t' | ',' | ';', number]> = [
    ['\t', (headerLine.match(/\t/g) ?? []).length],
    [',', (headerLine.match(/,/g) ?? []).length],
    [';', (headerLine.match(/;/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] === 0 ? '\t' : counts[0]![0]
}

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function usdToMicros(raw: string | undefined): bigint | null {
  const n = num(raw)
  if (n === null || n < 0) return null
  return BigInt(Math.round(n * 1_000_000))
}

function seedAndVariant(keyword: string): {
  seedKey: string
  variant: 'primary' | 'near_me' | 'other'
} {
  const m = keyword.match(/^(.*?)\s+near me\s*$/i)
  if (m) return { seedKey: m[1]!.trim().toLowerCase(), variant: 'near_me' }
  return { seedKey: keyword.toLowerCase(), variant: 'primary' }
}

/**
 * Decode Google Ads export text. Excel often saves these as UTF-16 LE with BOM.
 */
export function decodeGoogleAdsExportText(input: string | Uint8Array | Buffer): string {
  if (typeof input === 'string') {
    // If UTF-16 leaked through as binary-ish with NULs, still try as-is first.
    if (input.includes('\u0000') && input.charCodeAt(0) === 0xfeff) {
      return input.replace(/^\uFEFF/, '')
    }
    return input.replace(/^\uFEFF/, '')
  }
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // rare UTF-16 BE — swap not handled; fall through utf8
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '')
}

/**
 * Parse Google Ads Saved Keywords Stats TSV/CSV.
 * Skips title/date meta lines until a header containing Keyword.
 * Accepts string or raw bytes (UTF-16 LE from Excel downloads).
 */
export function parseGoogleAdsSavedKeywordsStats(
  textOrBytes: string | Uint8Array | Buffer,
): GoogleAdsKeywordsImportResult {
  const text = decodeGoogleAdsExportText(textOrBytes)
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.every((l) => l.trim() === '')) {
    throw new GoogleAdsKeywordsParseError('The file is empty.')
  }

  let headerIndex = -1
  let titleRaw: string | null = null
  let dateRangeRaw: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    // Google Ads Saved Keywords: first column header is Keyword (often TSV).
    const delim = sniffDelimiter(line)
    const cols = splitCsvLine(line, delim).map(normaliseHeader)
    const isHeader =
      cols.length >= 2 &&
      (cols[0] === 'keyword' || cols.some((c) => c === 'keyword' || c === 'avg monthly searches'))
    if (isHeader) {
      headerIndex = i
      break
    }
    if (titleRaw === null) titleRaw = line.trim()
    else if (dateRangeRaw === null) dateRangeRaw = line.trim()
  }

  if (headerIndex === -1) {
    throw new GoogleAdsKeywordsParseError(
      'No Keyword header row found. Expected a Google Ads Saved Keywords Stats export.',
    )
  }

  const headerLine = lines[headerIndex]!
  const delimiter = sniffDelimiter(headerLine)
  const headers = splitCsvLine(headerLine, delimiter).map(normaliseHeader)

  const kwIdx = headers.findIndex((h) => h === 'keyword' || h === 'keywords')
  if (kwIdx === -1) {
    throw new GoogleAdsKeywordsParseError(`No Keyword column. Headers: ${headers.join(' | ')}`)
  }

  const col = (aliases: string[]): number => {
    for (const a of aliases) {
      const i = headers.findIndex((h) => h === a)
      if (i !== -1) return i
    }
    return -1
  }

  const volIdx = col(['avg monthly searches', 'avg. monthly searches', 'average monthly searches'])
  const compIdx = col(['competition'])
  const compIxIdx = col(['competition indexed value', 'competition (indexed value)'])
  const bidLoIdx = col(['top of page bid low range', 'top of page bid (low range)'])
  const bidHiIdx = col(['top of page bid high range', 'top of page bid (high range)'])
  const inAcctIdx = col(['in account'])

  const monthCols: Array<{ key: string; idx: number }> = []
  headers.forEach((h, idx) => {
    const m = h.match(/^searches (.+)$/)
    if (m) monthCols.push({ key: m[1]!, idx })
  })

  const rows: GoogleAdsKeywordRow[] = []
  const skipped: GoogleAdsSkipped[] = []
  const seen = new Set<string>()

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (line.trim() === '') continue
    const fields = splitCsvLine(line, delimiter)
    // Skip summary rollups like "All" / "United States" without real keyword stats shape
    const keyword = (fields[kwIdx] ?? '').replace(/^["']|["']$/g, '').trim()
    if (keyword === '' || keyword === 'All' || keyword === 'United States') {
      skipped.push({
        line: lineNo,
        reason: keyword === '' ? 'Empty keyword.' : `Skipped summary row "${keyword}".`,
        raw: line.slice(0, 120),
      })
      continue
    }

    const keywordNorm = keyword.toLowerCase()
    if (seen.has(keywordNorm)) {
      skipped.push({
        line: lineNo,
        reason: `Duplicate of earlier row ("${keyword}").`,
        raw: line.slice(0, 120),
      })
      continue
    }
    seen.add(keywordNorm)

    const { seedKey, variant } = seedAndVariant(keyword)
    const bidLoRaw = bidLoIdx >= 0 ? fields[bidLoIdx] : undefined
    const bidHiRaw = bidHiIdx >= 0 ? fields[bidHiIdx] : undefined
    const monthlySeries: Record<string, number | null> = {}
    for (const m of monthCols) {
      monthlySeries[m.key] = num(fields[m.idx])
    }

    rows.push({
      keyword,
      keywordNorm,
      seedKey,
      variant,
      avgMonthlySearches: volIdx >= 0 ? num(fields[volIdx]) : null,
      competition: compIdx >= 0 ? (fields[compIdx] ?? '').trim() || null : null,
      competitionIndex: compIxIdx >= 0 ? num(fields[compIxIdx]) : null,
      topOfPageBidLowMicros: usdToMicros(bidLoRaw),
      topOfPageBidHighMicros: usdToMicros(bidHiRaw),
      topOfPageBidRaw:
        bidLoRaw || bidHiRaw ? `${bidLoRaw ?? ''}-${bidHiRaw ?? ''}`.trim() : null,
      inAccount: inAcctIdx >= 0 ? (fields[inAcctIdx] ?? '').trim() || null : null,
      monthlySeries,
      lineNumber: lineNo,
    })
  }

  return {
    rows,
    skipped,
    columnsFound: headers.filter((h) => h !== ''),
    dateRangeRaw,
    titleRaw,
    delimiter,
  }
}
