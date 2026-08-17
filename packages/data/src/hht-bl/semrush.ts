import 'server-only'
import { createHash } from 'node:crypto'
import { parse } from 'csv-parse/sync'

export const HHT_SEMRUSH_REPORTS = [
  'phrase_organic',
  'domain_rank',
  'domain_organic_organic',
  'backlinks_competitors',
  'backlinks_comparison',
  'backlinks_matrix',
  'backlinks_overview',
  'backlinks_refdomains',
  'backlinks',
] as const

export type HhtSemrushReport = (typeof HHT_SEMRUSH_REPORTS)[number]

export interface HhtSemrushEnvelope {
  report: HhtSemrushReport
  params: Record<string, unknown>
  body: string
  accountIdentifier?: string | null
  estimatedUnitsConsumed?: number | null
}

export function parseHhtSemrushEnvelope(value: unknown): HhtSemrushEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Semrush response envelope must be an object')
  }
  const row = value as Record<string, unknown>
  if (
    typeof row['report'] !== 'string' ||
    !HHT_SEMRUSH_REPORTS.includes(row['report'] as HhtSemrushReport)
  ) {
    throw new Error('Semrush response envelope contains an unsupported report')
  }
  if (!row['params'] || typeof row['params'] !== 'object' || Array.isArray(row['params'])) {
    throw new Error('Semrush response envelope params must be an object')
  }
  if (typeof row['body'] !== 'string') {
    throw new Error('Semrush response envelope body must be text')
  }
  if (
    row['accountIdentifier'] !== undefined &&
    row['accountIdentifier'] !== null &&
    typeof row['accountIdentifier'] !== 'string'
  ) {
    throw new Error('Semrush account identifier must be text or null')
  }
  if (
    row['estimatedUnitsConsumed'] !== undefined &&
    row['estimatedUnitsConsumed'] !== null &&
    (typeof row['estimatedUnitsConsumed'] !== 'number' ||
      !Number.isFinite(row['estimatedUnitsConsumed']) ||
      row['estimatedUnitsConsumed'] < 0)
  ) {
    throw new Error('Semrush estimated units must be a non-negative number or null')
  }
  return {
    report: row['report'] as HhtSemrushReport,
    params: row['params'] as Record<string, unknown>,
    body: row['body'],
    ...(row['accountIdentifier'] === undefined
      ? {}
      : { accountIdentifier: row['accountIdentifier'] as string | null }),
    ...(row['estimatedUnitsConsumed'] === undefined
      ? {}
      : { estimatedUnitsConsumed: row['estimatedUnitsConsumed'] as number | null }),
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function semrushRequestKey(report: string, params: Record<string, unknown>): string {
  return createHash('sha256').update(`${report}\n${stableJson(params)}`).digest('hex')
}

export function semrushPayloadHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function normalizeSemrushHeader(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

export function parseSemrushRows(body: string): Array<Record<string, string>> {
  if (!body.trim()) return []
  return parse(body, {
    bom: true,
    columns: (headers: string[]) => headers.map(normalizeSemrushHeader),
    delimiter: ';',
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>
}

export function semrushInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function semrushNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function semrushBoolean(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === '') return null
  if (value.toLowerCase() === 'true' || value === '1') return true
  if (value.toLowerCase() === 'false' || value === '0') return false
  return null
}

export function semrushTimestamp(value: string | undefined): Date | null {
  const seconds = semrushInteger(value)
  if (seconds === null) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.valueOf()) ? null : date
}

const CREDENTIAL_PATTERNS = [
  /insufficient (credits?|units?|balance)/i,
  /not enough (credits?|units?|balance)/i,
  /credits? (have|has) run out/i,
  /payment required/i,
  /subscription.*(expired|inactive|limit)/i,
  /unauthori[sz]ed/i,
  /invalid.*(token|credential|api key)/i,
  /access denied/i,
]

const RETRYABLE_PATTERNS = [/rate.?limit/i, /too many requests/i, /timed? out/i, /temporar/i, /5\d\d/]

export type HhtSemrushErrorKind = 'WAITING_FOR_CREDENTIALS' | 'RETRYABLE' | 'FAILED'

export function classifySemrushError(error: unknown): HhtSemrushErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'WAITING_FOR_CREDENTIALS'
  }
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) return 'RETRYABLE'
  return 'FAILED'
}

export interface HhtSemrushPageState {
  offset: number
  limit: number
  rowsReceived: number
  totalRowsReceived?: number
  maxRows?: number
}

export function nextSemrushPage(state: HhtSemrushPageState): { complete: true } | {
  complete: false
  offset: number
} {
  if (
    state.maxRows !== undefined &&
    (state.totalRowsReceived ?? 0) + state.rowsReceived >= state.maxRows
  ) {
    return { complete: true }
  }
  if (state.rowsReceived < state.limit) return { complete: true }
  return { complete: false, offset: state.offset + state.limit }
}

export function resumeSemrushInstruction(jobId: number): string {
  return `Swap the Semrush MCP account in Codex, verify it with a one-row request, then run: pnpm hht:bl resume --job-id=${jobId}`
}
