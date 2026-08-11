import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  inServiceArea,
  isEmergencyFrom,
  parseSaveLeadArgs,
  qualifyLead,
  triage,
  type CallIngestState,
} from '@rnr/core'
import type { Database } from '../db.js'
import { calls, leads, sites, spendLedger, webhookEvents, type Call, type Lead } from '../schema.js'
import type { ParsedRetellCall, RetellEventType } from '../providers/retell/contracts.js'
import { enqueueLeadDelivery, enqueueVoiceJob } from './jobs.js'
import { touchSiteWebhook } from '../sites.js'

/**
 * Webhook ingest.
 *
 * Order of operations in every handler: record the event, THEN act on it. A
 * handler that throws still leaves the payload in `webhook_events`, so an ingest
 * bug is replayable rather than lost -- the same argument as `spend_ledger` storing
 * a row per purchase instead of a running total.
 */

export interface RecordEventArgs {
  eventType: string
  retellCallId: string | null
  siteId?: number | null
  payload: unknown
  signatureValid: boolean
  /**
   * Defaults to 'retell'. The Twilio failover route passes 'twilio' because those
   * requests are not Retell-signed at all -- filing them as unverified Retell
   * events would inflate the invalid-signature count in the connection panel and
   * raise a security warning every time a failover fired.
   */
  provider?: 'retell' | 'twilio'
}

export interface RecordEventResult {
  /** False when this exact (eventType, callId) was already recorded. */
  fresh: boolean
  eventId: number | null
  /**
   * True when the side effects should run: either this is the first delivery, OR a
   * previous delivery was recorded but its handler FAILED.
   *
   * ==================== WHY THIS IS NOT JUST `fresh` ====================
   * The dedupe key and the retry mechanism fight each other. If the handler throws
   * we answer 500 so Retell retries -- but the event row already exists, so a
   * naive `fresh === false` check would answer "duplicate, 200" to the retry and
   * the call would never be ingested. The 500 would be advice nobody could take.
   *
   * So a row whose `handler_error` is set is explicitly reprocessable. Retries of a
   * SUCCESSFUL delivery are still suppressed, which is the case dedupe exists for.
   * =====================================================================
   */
  shouldProcess: boolean
}

/**
 * Record a webhook, deduping on Retell's documented key.
 *
 * Retell retries up to 3 times when it does not see a 2xx within 10 seconds, so
 * duplicate deliveries are the normal case, not an edge case.
 */
export async function recordWebhookEvent(
  db: Database,
  args: RecordEventArgs,
): Promise<RecordEventResult> {
  const rows = await db
    .insert(webhookEvents)
    .values({
      provider: args.provider ?? 'retell',
      eventType: args.eventType,
      retellCallId: args.retellCallId,
      siteId: args.siteId ?? null,
      payload: args.payload as never,
      signatureValid: args.signatureValid,
    })
    .onConflictDoNothing({ target: [webhookEvents.eventType, webhookEvents.retellCallId] })
    .returning({ id: webhookEvents.id })

  const inserted = rows[0]
  if (inserted !== undefined) {
    return { fresh: true, eventId: inserted.id, shouldProcess: true }
  }

  // Conflict: find the row that won, and let a previously-failed handler run again.
  const existing = (
    await db
      .select({ id: webhookEvents.id, handlerError: webhookEvents.handlerError })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.eventType, args.eventType),
          args.retellCallId === null
            ? isNull(webhookEvents.retellCallId)
            : eq(webhookEvents.retellCallId, args.retellCallId),
        ),
      )
      .limit(1)
  )[0]

  if (existing === undefined) return { fresh: false, eventId: null, shouldProcess: false }

  return {
    fresh: false,
    eventId: existing.id,
    shouldProcess: existing.handlerError !== null,
  }
}

/** Clear the error once a retry succeeds, so it stops being reprocessable. */
export async function clearEventHandlerError(db: Database, eventId: number): Promise<void> {
  await db.update(webhookEvents).set({ handlerError: null }).where(eq(webhookEvents.id, eventId))
}

export async function markEventHandlerError(
  db: Database,
  eventId: number,
  error: string,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ handlerError: error.slice(0, 4000) })
    .where(eq(webhookEvents.id, eventId))
}

// ---------------------------------------------------------------------------

const INGEST_RANK: Record<CallIngestState, number> = { started: 0, ended: 1, analyzed: 2 }

/**
 * Call-id prefixes this system generates itself.
 *
 * `sim_` from voice:simulate, `test_` from the dashboard button, `e2e_` from the test
 * suite. Retell's own ids look like `call_xxx`, so there is no overlap -- and a real
 * call can never be mistaken for a simulated one, which is the direction that
 * matters: a suppressed real lead is a lost customer.
 */
const SIMULATED_PREFIXES = ['sim_', 'test_', 'e2e_'] as const

export function isSimulatedCallId(callId: string): boolean {
  return SIMULATED_PREFIXES.some((p) => callId.startsWith(p))
}

function nextIngestState(current: string, incoming: CallIngestState): CallIngestState {
  const cur = INGEST_RANK[current as CallIngestState] ?? 0
  return INGEST_RANK[incoming] >= cur ? incoming : (current as CallIngestState)
}

export interface UpsertCallResult {
  call: Call
  created: boolean
}

/**
 * Create or update the `calls` row.
 *
 * ==================== WHY THIS IS AN UPSERT, NOT AN INSERT ====================
 * Retell's three events arrive in order but not reliably: `call_started` can be
 * missed, and any of them can be redelivered. So each event upserts the columns it
 * knows about and leaves the rest alone, and `ingest_state` only ever moves
 * forward -- a redelivered `call_started` after `call_analyzed` must not reset the
 * row to 'started' and drop the transcript.
 * ============================================================================
 */
export async function upsertCallFromEvent(
  db: Database,
  args: { eventType: RetellEventType; parsed: ParsedRetellCall },
): Promise<UpsertCallResult> {
  const { parsed } = args
  const incoming: CallIngestState =
    args.eventType === 'call_analyzed' ? 'analyzed' : args.eventType === 'call_ended' ? 'ended' : 'started'

  /**
   * The site is read from metadata ONLY.
   *
   * Not from to_number. Resolving by number here would silently reattribute every
   * historical call the moment a number moves between sites. When metadata is
   * absent the call is stored unattributed with a reason, which is how a failed
   * inbound webhook becomes visible instead of vanishing.
   */
  const siteId = parsed.siteId
  const unattributedReason =
    siteId === null
      ? `No site_id in call metadata (to_number ${parsed.toNumber ?? 'unknown'}). ` +
        'The inbound webhook did not run or did not resolve a site.'
      : null

  const existing = await db
    .select()
    .from(calls)
    .where(eq(calls.retellCallId, parsed.callId))
    .limit(1)

  const patch = {
    siteId,
    unattributedReason,
    simulated: isSimulatedCallId(parsed.callId),
    direction: parsed.direction,
    fromNumber: parsed.fromNumber,
    toNumber: parsed.toNumber,
    agentId: parsed.agentId,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    durationMs: parsed.durationMs,
    disconnectionReason: parsed.disconnectionReason,
    transcript: parsed.transcript,
    transcriptObject: parsed.transcriptObject as never,
    analysis: parsed.analysis as never,
    userSentiment: parsed.userSentiment,
    callSuccessful: parsed.callSuccessful,
    inVoicemail: parsed.inVoicemail,
    latencyE2eP50Ms: parsed.latencyE2e.p50,
    latencyE2eP90Ms: parsed.latencyE2e.p90,
    latencyE2eP95Ms: parsed.latencyE2e.p95,
    latencyLlmP50Ms: parsed.latencyLlm.p50,
    latencyTtsP50Ms: parsed.latencyTts.p50,
    costMicros: parsed.costMicros,
    recordingUrlUpstream: parsed.recordingUrl,
  }

  if (existing.length === 0) {
    const [row] = await db
      .insert(calls)
      .values({ retellCallId: parsed.callId, ingestState: incoming, ...patch })
      .onConflictDoUpdate({
        // Concurrent redelivery can lose the insert race. Merging here rather than
        // throwing keeps the second delivery a success, so Retell stops retrying.
        target: calls.retellCallId,
        set: { ...definedOnly(patch), ingestState: incoming },
      })
      .returning()
    return { call: row!, created: true }
  }

  const prior = existing[0]!
  const [row] = await db
    .update(calls)
    .set({
      // Only overwrite with values we actually received. A `call_started`
      // redelivery carries no transcript, and blindly writing its nulls would
      // erase one already stored.
      ...definedOnly(patch),
      ingestState: nextIngestState(prior.ingestState, incoming),
    })
    .where(eq(calls.id, prior.id))
    .returning()

  return { call: row!, created: false }
}

/** Drop null/undefined so a later sparse event cannot erase an earlier full one. */
function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/**
 * Write the call's cost to the ledger.
 *
 * Retell reports cents; `parseRetellCall` already converted to micros. Idempotent
 * on (site, endpoint, note) via a pre-check rather than a unique index, because
 * `spend_ledger` deliberately allows many rows per site.
 */
export async function recordCallSpend(db: Database, call: Call): Promise<void> {
  if (call.costMicros === null || call.costMicros === 0n) return

  const note = `retell:${call.retellCallId}`
  const existing = await db
    .select({ id: spendLedger.id })
    .from(spendLedger)
    .where(eq(spendLedger.note, note))
    .limit(1)
  if (existing.length > 0) return

  await db.insert(spendLedger).values({
    siteId: call.siteId,
    scanRunId: null,
    endpoint: 'retell/call',
    costMicros: call.costMicros,
    note,
  })
}

// ---------------------------------------------------------------------------

export interface SaveLeadResult {
  lead: Lead
  created: boolean
  /** True when this write completed the fields needed to alert the contractor. */
  readyToDeliver: boolean
}

/**
 * The mid-call `save_lead` tool. AUTHORITATIVE.
 *
 * Called repeatedly during one call, each time with whatever the agent has learned
 * so far, so this merges rather than replaces: a later call carrying only an
 * address must not blank the name captured earlier.
 *
 * This is what makes a lead survive a hang-up. In HVAC the caller who gives a name
 * and "my furnace is dead" and then hangs up is still worth $50-200.
 */
export async function saveLeadFromTool(
  db: Database,
  args: { call: Call; rawArgs: unknown },
): Promise<SaveLeadResult> {
  const { call } = args
  const parsed = parseSaveLeadArgs(args.rawArgs)

  // Site config, for the service-area check. One small read; this runs mid-call.
  const siteRow = call.siteId === null ? null : (
    await db
      .select({ zips: sites.serviceAreaZips })
      .from(sites)
      .where(eq(sites.id, call.siteId))
      .limit(1)
  )[0]

  const existing = (
    await db.select().from(leads).where(eq(leads.callId, call.id)).limit(1)
  )[0]

  // Merge: new non-null wins, otherwise keep what we had.
  const pick = <T>(incoming: T | null, prior: T | null | undefined): T | null =>
    incoming !== null ? incoming : (prior ?? null)

  const name = pick(parsed.name, existing?.name)
  const phone = pick(parsed.phone, existing?.phone)
  const zip = pick(parsed.zip, existing?.zip)
  const problem = pick(parsed.problem, existing?.problem)
  const isOwner = pick(parsed.isOwner, existing?.isOwner)

  /**
   * Emergency, from two independent sources.
   *
   * ==================== TRIAGE CAN ONLY PROMOTE ====================
   * The model's `is_emergency` is the only thing that may establish a NEGATIVE,
   * because only the agent can have actually asked. Deterministic triage over the
   * problem text can raise null-or-false to TRUE -- that is the safety net that
   * stops a mis-classifying model burying a gas leak -- but it must never supply a
   * `false`.
   *
   * An earlier version ended `... : modelSaid ?? triageSaid`, and that was a real
   * bug caught by the e2e suite: "furnace making a grinding noise" contains no
   * hazard keywords, so triage returned false, and a lead where urgency was NEVER
   * ASKED ABOUT was stored as explicitly routine. A keyword scan finding nothing is
   * absence of evidence, not evidence of absence -- the governing rule of this
   * codebase, applied to the one column where being wrong sends a truck tomorrow
   * instead of tonight.
   * ================================================================
   */
  const triaged = triage([problem, parsed.notes, call.transcript].filter(Boolean).join(' '))
  const modelSaid = pick(parsed.isEmergency, existing?.isEmergency)
  const triageSaid = isEmergencyFrom(problem ?? call.transcript)
  const isEmergency = modelSaid === true || triageSaid === true ? true : modelSaid

  const hazard = pick(parsed.hazard, existing?.hazard) ?? triaged.hazard
  const area = inServiceArea(zip, siteRow?.zips ?? null)

  const capturedFields = [...new Set([...(existing?.capturedFields ?? []), ...parsed.captured])]

  const qualified = qualifyLead({
    name,
    phone,
    problem,
    inServiceArea: area,
    isOwner,
  })

  const values = {
    siteId: call.siteId,
    callId: call.id,
    source: 'call' as const,
    name,
    phone,
    email: pick(parsed.email, existing?.email),
    addressLine: pick(parsed.addressLine, existing?.addressLine),
    city: pick(parsed.city, existing?.city),
    zip,
    problem,
    systemType: pick(parsed.systemType, existing?.systemType),
    systemAgeYears: pick(parsed.systemAgeYears, existing?.systemAgeYears),
    isEmergency,
    hazard,
    inServiceArea: area,
    isOwner,
    isCommercial: pick(parsed.isCommercial, existing?.isCommercial),
    qualified,
    capturedFields,
    capturedVia: 'tool' as const,
    appointmentAt: pick(parsed.appointmentAt, existing?.appointmentAt),
    notes: pick(parsed.notes, existing?.notes),
    updatedAt: new Date(),
  }

  if (existing === undefined) {
    const [row] = await db
      .insert(leads)
      .values(values)
      .onConflictDoUpdate({ target: leads.callId, set: values })
      .returning()
    return { lead: row!, created: true, readyToDeliver: deliverable(row!) }
  }

  const [row] = await db.update(leads).set(values).where(eq(leads.id, existing.id)).returning()
  return { lead: row!, created: false, readyToDeliver: deliverable(row!) }
}

/**
 * Enough to be worth texting the contractor about.
 *
 * A phone number is the floor -- without it there is nothing actionable to send.
 * An emergency goes out on the number alone, before anything else is known.
 */
function deliverable(lead: Lead): boolean {
  if (lead.phone === null) return false
  if (lead.isEmergency === true) return true
  return lead.name !== null || lead.problem !== null
}

// ---------------------------------------------------------------------------

/**
 * Backfill from post-call analysis, and record where it disagreed.
 *
 * ==================== THE TOOL WINS ====================
 * Post-call analysis re-reads the transcript after the fact. It lands seconds
 * late, it produces nothing at all for an abandoned call, and it can contradict
 * what the agent actually confirmed with the caller out loud.
 *
 * So it only FILLS NULLS. Where it disagrees with a value the tool captured, the
 * tool's value stays and the disagreement is written to `reconcile_conflict` --
 * because a recurring conflict on one field is a prompt bug, and this is the only
 * place it ever becomes visible.
 * ======================================================
 */
export async function reconcileLeadFromAnalysis(
  db: Database,
  args: { call: Call; customAnalysis: Record<string, unknown> | null },
): Promise<Lead | null> {
  const { call, customAnalysis } = args
  if (customAnalysis === null || Object.keys(customAnalysis).length === 0) return null

  const parsed = parseSaveLeadArgs(customAnalysis)
  const existing = (
    await db.select().from(leads).where(eq(leads.callId, call.id)).limit(1)
  )[0]

  // No mid-call lead at all: analysis is the only source, so it creates the row.
  if (existing === undefined) {
    if (parsed.captured.length === 0) return null
    const created = await saveLeadFromTool(db, { call, rawArgs: customAnalysis })
    await db
      .update(leads)
      .set({ capturedVia: 'analysis' })
      .where(eq(leads.id, created.lead.id))
    return { ...created.lead, capturedVia: 'analysis' }
  }

  const conflicts: Record<string, { tool: unknown; analysis: unknown }> = {}
  const fills: Record<string, unknown> = {}

  const consider = <K extends keyof Lead>(field: K, incoming: Lead[K] | null): void => {
    if (incoming === null) return
    const current = existing[field]
    if (current === null || current === undefined) {
      fills[field as string] = incoming
      return
    }
    // Compare loosely: the analysis pass reformats strings ("Dana" vs "dana").
    const a = typeof current === 'string' ? current.trim().toLowerCase() : current
    const b = typeof incoming === 'string' ? (incoming as string).trim().toLowerCase() : incoming
    if (a !== b) conflicts[field as string] = { tool: current, analysis: incoming }
  }

  consider('name', parsed.name)
  consider('phone', parsed.phone)
  consider('email', parsed.email)
  consider('addressLine', parsed.addressLine)
  consider('city', parsed.city)
  consider('zip', parsed.zip)
  consider('problem', parsed.problem)
  consider('systemType', parsed.systemType)
  consider('systemAgeYears', parsed.systemAgeYears)
  consider('isEmergency', parsed.isEmergency)
  consider('isOwner', parsed.isOwner)
  consider('isCommercial', parsed.isCommercial)

  if (Object.keys(fills).length === 0 && Object.keys(conflicts).length === 0) return existing

  const [row] = await db
    .update(leads)
    .set({
      ...fills,
      ...(Object.keys(conflicts).length > 0 ? { reconcileConflict: conflicts as never } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, existing.id))
    .returning()

  // Requalify: a filled-in phone or zip can change the answer.
  const merged = row!
  const qualified = qualifyLead({
    name: merged.name,
    phone: merged.phone,
    problem: merged.problem,
    inServiceArea: merged.inServiceArea,
    isOwner: merged.isOwner,
  })
  if (qualified !== merged.qualified) {
    await db.update(leads).set({ qualified }).where(eq(leads.id, merged.id))
    return { ...merged, qualified }
  }
  return merged
}

// ---------------------------------------------------------------------------

/**
 * Everything that must happen after a call event, in one place.
 *
 * Called by the route handler after the event row exists. Each step is independent
 * and failures are isolated: a recording that cannot be queued must not prevent
 * the lead from being delivered.
 */
export async function handleCallEvent(
  db: Database,
  args: { eventType: RetellEventType; parsed: ParsedRetellCall },
): Promise<{ call: Call }> {
  const { call } = await upsertCallFromEvent(db, args)

  // Marks the site as reachable, which is what clears the "not connected" banner.
  if (call.siteId !== null) await touchSiteWebhook(db, call.siteId)

  if (args.eventType === 'call_ended' || args.eventType === 'call_analyzed') {
    await recordCallSpend(db, call)
  }

  if (args.eventType === 'call_analyzed') {
    // Recording first: Retell's link can be a 10-MINUTE window when the PII opt-out
    // is enabled, so this is the most time-critical thing on the page.
    if (call.recordingUrlUpstream !== null && call.recordingPath === null) {
      await enqueueVoiceJob(db, { kind: 'fetch_recording', callId: call.id })
    }

    const lead = await reconcileLeadFromAnalysis(db, {
      call,
      customAnalysis: args.parsed.customAnalysis,
    })
    if (lead !== null && lead.phone !== null) {
      await enqueueLeadDelivery(db, lead.id)
    }
  }

  return { call }
}

/**
 * How many stored webhooks failed signature verification.
 *
 * Surfaced in the connection panel. Those payloads were stored but never applied,
 * so nothing is lost -- but a non-zero count means either RETELL_API_KEY is wrong
 * (and the events can be replayed once fixed) or someone is probing the endpoint.
 * Either way it must be visible, not buried in a column nobody selects.
 */
export async function countInvalidSignatures(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(
      and(eq(webhookEvents.signatureValid, false), eq(webhookEvents.provider, 'retell')),
    )
  return row?.n ?? 0
}

export async function getCallByRetellId(db: Database, retellCallId: string): Promise<Call | null> {
  const rows = await db.select().from(calls).where(eq(calls.retellCallId, retellCallId)).limit(1)
  return rows[0] ?? null
}

export async function getCallById(db: Database, id: number): Promise<Call | null> {
  const rows = await db.select().from(calls).where(eq(calls.id, id)).limit(1)
  return rows[0] ?? null
}

export { sql }
