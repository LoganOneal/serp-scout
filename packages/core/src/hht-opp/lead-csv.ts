/**
 * Handoff contract between SERP discovery and the guest-post-pitches skill.
 * One row per registrable domain. `opportunity_url` and `all_urls` are hints only;
 * the skill finds the real invitation page itself.
 */

export type LeadType = 'guest_post' | 'link_insertion'

export interface LeadRow {
  domain: string
  opportunityUrl: string | null
  allUrls: string[]
  sourceQuery: string
  bucket: string | null
  leadType: LeadType
  score: number
  bestPosition: number | null
  queryHits: number | null
  batchId: string
}

export const LEAD_CSV_COLUMNS = [
  'domain',
  'opportunity_url',
  'all_urls',
  'source_query',
  'bucket',
  'lead_type',
  'score',
  'best_position',
  'query_hits',
  'batch_id',
] as const

function cell(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function leadRowsToCsv(rows: readonly LeadRow[]): string {
  const lines = [LEAD_CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push([
      row.domain,
      row.opportunityUrl,
      [...new Set(row.allUrls)].join(' | '),
      row.sourceQuery,
      row.bucket,
      row.leadType,
      Math.round(row.score * 10) / 10,
      row.bestPosition,
      row.queryHits,
      row.batchId,
    ].map(cell).join(','))
  }
  return `${lines.join('\n')}\n`
}

/** Highest score first, then domain, so batches are stable across reruns. */
export function sortLeadRows<T extends Pick<LeadRow, 'score' | 'domain'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
}

export function chunkLeadRows<T>(rows: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += step) out.push(rows.slice(i, i + step))
  return out
}

/**
 * Minimal CSV reader for exclusion files (tracker, outreach exports). Handles quoted
 * cells with commas, doubled quotes and newlines.
 */
export function parseLeadCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = []
  let row: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(current)
      current = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(current)
      records.push(row)
      row = []
      current = ''
    } else current += char
  }
  if (current !== '' || row.length > 0) {
    row.push(current)
    records.push(row)
  }
  const [header, ...body] = records.filter((r) => r.some((value) => value.trim() !== ''))
  if (!header) return []
  const keys = header.map((key) => key.trim().replace(/^\uFEFF/, ''))
  return body.map((values) => Object.fromEntries(keys.map((key, index) => [key, (values[index] ?? '').trim()])))
}
