/**
 * The shapes Retell actually sends, and the parsing of them.
 *
 * ==================== PARSED, NOT CAST ====================
 * A webhook body is untrusted input from another company's release schedule.
 * Casting it to an interface makes every downstream field access a lie the
 * compiler has agreed to: a renamed field becomes `undefined`, flows into an
 * INSERT, and lands as a NULL that reads as "the caller was never asked" rather
 * than "we failed to read the payload".
 *
 * So every field is pulled with an explicit accessor that returns null on
 * anything unexpected, and the raw payload is stored alongside so a parse gap is
 * recoverable rather than lost.
 * =========================================================
 */

import { centsToMicros } from '@rnr/core'

export type RetellEventType =
  | 'call_started'
  | 'call_ended'
  | 'call_analyzed'
  | 'transcript_updated'
  | 'call_inbound'

// --- Safe accessors ----------------------------------------------------------

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v))
  return null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/** Retell sends epoch milliseconds. Rejects zero and implausible values. */
function ts(v: unknown): Date | null {
  const n = int(v)
  if (n === null || n <= 0) return null
  // Guard against a seconds-vs-millis mixup silently landing in 1970.
  const ms = n < 100_000_000_000 ? n * 1000 : n
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  return year >= 2020 && year <= 2100 ? d : null
}

// --- Latency -----------------------------------------------------------------

export interface LatencyPercentiles {
  p50: number | null
  p90: number | null
  p95: number | null
}

function latency(v: unknown): LatencyPercentiles {
  const o = obj(v)
  if (!o) return { p50: null, p90: null, p95: null }
  return { p50: int(o['p50']), p90: int(o['p90']), p95: int(o['p95']) }
}

// --- Parsed call -------------------------------------------------------------

export interface ParsedRetellCall {
  callId: string
  agentId: string | null
  /** Frozen site id from metadata, set by our own inbound webhook. */
  siteId: number | null
  direction: string
  fromNumber: string | null
  toNumber: string | null
  startedAt: Date | null
  endedAt: Date | null
  durationMs: number | null
  disconnectionReason: string | null
  transcript: string | null
  transcriptObject: unknown
  analysis: unknown
  userSentiment: string | null
  callSuccessful: boolean | null
  inVoicemail: boolean | null
  /** Extracted structured fields from post-call analysis, if configured. */
  customAnalysis: Record<string, unknown> | null
  latencyE2e: LatencyPercentiles
  latencyLlm: LatencyPercentiles
  latencyTts: LatencyPercentiles
  /** Micros, converted from Retell's cents. Null when not yet reported. */
  costMicros: bigint | null
  recordingUrl: string | null
}

/**
 * Pull `metadata.site_id` back out.
 *
 * This is the ONLY way a call learns its site. Resolving by `to_number` here
 * instead would silently reattribute every historical call the moment a number
 * moves between sites -- see the schema comment on `calls.site_id`.
 */
function siteIdFromMetadata(metadata: unknown): number | null {
  const m = obj(metadata)
  if (!m) return null
  const raw = m['site_id'] ?? m['siteId']
  const n = int(raw)
  return n !== null && n > 0 ? n : null
}

export function parseRetellCall(callRaw: unknown): ParsedRetellCall | null {
  const c = obj(callRaw)
  if (!c) return null
  const callId = str(c['call_id'])
  if (!callId) return null

  const analysisObj = obj(c['call_analysis'])
  const costObj = obj(c['call_cost'])
  const latencyObj = obj(c['latency'])

  const start = ts(c['start_timestamp'])
  const end = ts(c['end_timestamp'])
  // Prefer the reported duration; fall back to the timestamp delta rather than
  // leaving it null when both endpoints are present.
  const duration =
    int(c['duration_ms']) ??
    (start && end ? Math.max(0, end.getTime() - start.getTime()) : null)

  const cents = int(costObj?.['combined_cost'])

  return {
    callId,
    agentId: str(c['agent_id']),
    siteId: siteIdFromMetadata(c['metadata']),
    direction: str(c['direction']) ?? 'inbound',
    fromNumber: str(c['from_number']),
    toNumber: str(c['to_number']),
    startedAt: start,
    endedAt: end,
    durationMs: duration,
    disconnectionReason: str(c['disconnection_reason']),
    transcript: str(c['transcript']),
    transcriptObject: c['transcript_object'] ?? null,
    analysis: analysisObj ?? null,
    userSentiment: str(analysisObj?.['user_sentiment']),
    callSuccessful: bool(analysisObj?.['call_successful']),
    inVoicemail: bool(analysisObj?.['in_voicemail']),
    customAnalysis: obj(analysisObj?.['custom_analysis_data']),
    latencyE2e: latency(latencyObj?.['e2e']),
    latencyLlm: latency(latencyObj?.['llm']),
    latencyTts: latency(latencyObj?.['tts']),
    // Retell reports cents. centsToMicros truncates, which is exact here because
    // the source is already an integer number of cents.
    costMicros: cents === null ? null : centsToMicros(cents),
    recordingUrl: str(c['recording_url']),
  }
}

// --- Envelope ----------------------------------------------------------------

export interface ParsedRetellEvent {
  eventType: RetellEventType
  call: ParsedRetellCall | null
}

const KNOWN_EVENTS: readonly string[] = [
  'call_started',
  'call_ended',
  'call_analyzed',
  'transcript_updated',
  'call_inbound',
]

export function parseRetellEvent(body: unknown): ParsedRetellEvent | null {
  const b = obj(body)
  if (!b) return null
  const eventType = str(b['event'])
  if (!eventType || !KNOWN_EVENTS.includes(eventType)) return null
  return {
    eventType: eventType as RetellEventType,
    call: parseRetellCall(b['call']),
  }
}

// --- Inbound webhook ---------------------------------------------------------

export interface ParsedInboundCall {
  fromNumber: string | null
  toNumber: string | null
  agentId: string | null
}

export function parseInboundEvent(body: unknown): ParsedInboundCall | null {
  const b = obj(body)
  if (!b) return null
  if (str(b['event']) !== 'call_inbound') return null
  const c = obj(b['call_inbound'])
  if (!c) return null
  return {
    fromNumber: str(c['from_number']),
    toNumber: str(c['to_number']),
    agentId: str(c['agent_id']),
  }
}

// --- Tool call ---------------------------------------------------------------

export interface ParsedToolCall {
  callId: string | null
  name: string | null
  args: unknown
}

/**
 * Retell's custom-function POST.
 *
 * The shape has varied across versions -- arguments have appeared both nested
 * under `args` and flattened at the top level, and the call id has appeared as
 * `call_id`, `call.call_id`, and inside `call`. All observed shapes are accepted
 * because the alternative is dropping a lead mid-call over a field rename.
 */
export function parseToolCall(body: unknown): ParsedToolCall {
  const b = obj(body)
  if (!b) return { callId: null, name: null, args: null }

  const call = obj(b['call'])
  const callId = str(b['call_id']) ?? str(call?.['call_id']) ?? null
  const name = str(b['name']) ?? str(b['function_name']) ?? null

  // Nested first, then the whole body minus the envelope keys.
  const nested = obj(b['args']) ?? obj(b['arguments']) ?? obj(b['parameters'])
  if (nested) return { callId, name, args: nested }

  const { call: _c, call_id: _i, name: _n, function_name: _f, ...rest } = b
  return { callId, name, args: rest }
}
