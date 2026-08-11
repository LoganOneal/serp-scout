import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { centsToMicros } from '@rnr/core'
import { createDb, type Database } from '../db.js'
import {
  calls,
  leadDeliveries,
  leads,
  localities,
  niches,
  sites,
  spendLedger,
  voiceJobs,
  webhookEvents,
} from '../schema.js'
import { fixtureCall } from '../providers/fixtures/voice.js'
import { parseRetellEvent, parseToolCall } from '../providers/retell/contracts.js'
import { createVoiceProviders } from '../providers/voice.js'
import {
  clearEventHandlerError,
  getCallByRetellId,
  handleCallEvent,
  markEventHandlerError,
  recordWebhookEvent,
  saveLeadFromTool,
} from './ingest.js'
import { claimNextVoiceJob } from './jobs.js'
import { runVoiceJob } from './run-job.js'
import { resolveSiteByNumber } from '../sites.js'
import { resetSchema } from '../test-support/schema-sql.js'
import { getSiteStats, listUnattributedCalls } from '../sites.js'

/**
 * The voice path, end to end, against a real Postgres. $0 and no network.
 *
 * ==================== WHAT THIS SUITE IS ACTUALLY FOR ====================
 * Every claim this feature makes about nullability is a claim about what survives a
 * database round trip. A parser that returns `null` correctly is worthless if the
 * INSERT coerces it, or if a later sparse webhook overwrites it, or if the column
 * has a DEFAULT false nobody noticed.
 *
 * So the assertions here are mostly about NULL vs false: `is_emergency` on a call
 * where urgency was never established, a `calls` row existing for an abandoned
 * call, `qualified` staying null rather than becoming a judgement nobody made.
 * ========================================================================
 *
 * The schema comes from the drizzle-kit generated migration rather than
 * hand-written DDL, so this suite also proves that migration actually applies.
 *
 * Requires a reachable Postgres. Set E2E_DATABASE_URL (preferred) or DATABASE_URL.
 */

const DB_URL = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL']
const SCHEMA = 'rnr_voice_e2e'
const TRACKING = '+14145550134'

let db: Database
let raw: postgres.Sql
let siteId: number
let recordingsDir: string

describe.skipIf(!DB_URL)('voice ingest e2e ($0, fixtures)', () => {
  beforeAll(async () => {
    recordingsDir = join(tmpdir(), `rnr-recordings-${process.pid}`)
    process.env['RECORDINGS_DIR'] = recordingsDir

    const admin = postgres(DB_URL!, { max: 1, onnotice: () => {} })
    await resetSchema(admin, SCHEMA)
    await admin.end({ timeout: 5 })

    const created = createDb(DB_URL!, { searchPath: SCHEMA })
    db = created.db
    raw = created.sql

    const [loc] = await db
      .insert(localities)
      .values({
        slug: 'kenosha-wi',
        kind: 'city',
        name: 'Kenosha',
        rawName: 'Kenosha city',
        stateCode: 'WI',
        stateName: 'Wisconsin',
        fips: '5539225',
        population: 99_500,
        searchText: 'kenosha wi wisconsin',
      })
      .returning({ id: localities.id })

    const [niche] = await db
      .insert(niches)
      .values({
        slug: 'hvac',
        label: 'HVAC',
        keywordNoun: 'hvac',
        emdToken: 'hvac',
        domainStems: ['hvac', 'heating'],
        category: 'home',
        demandPerCapitaPer1k: 1.2,
        valuePerSearchMicros: 1_000_000n,
        rentFloorMicros: 100_000_000n,
        rentCeilingMicros: 2_000_000_000n,
      })
      .returning({ id: niches.id })

    const [site] = await db
      .insert(sites)
      .values({
        domain: 'kenoshaair.com',
        localityId: loc!.id,
        nicheId: niche!.id,
        displayName: 'Kenosha Air',
        status: 'live',
        trackingNumber: TRACKING,
        onCallNumber: '+14145550199',
        leadAlertNumber: '+14145550177',
        serviceAreaZips: ['53140', '53142'],
        dispatchFeeMicros: 89_000_000n,
      })
      .returning({ id: sites.id })
    siteId = site!.id
  })

  afterAll(async () => {
    if (raw) {
      await raw.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
      await raw.end({ timeout: 5 })
    }
    if (recordingsDir) await rm(recordingsDir, { recursive: true, force: true }).catch(() => {})
  })

  // --- The banner ----------------------------------------------------------

  it('starts with firstWebhookAt NULL, which is what drives the "not connected" banner', async () => {
    const [row] = await db.select().from(sites).where(eq(sites.id, siteId))
    expect(row!.firstWebhookAt).toBeNull()
    // And the count of calls is genuinely 0 -- the UI must not present those two
    // facts the same way, which is the whole reason the column exists.
    const stats = await getSiteStats(db, siteId)
    expect(stats.calls).toBe(0)
  })

  it('resolves the site by dialled number for the inbound webhook', async () => {
    const ctx = await resolveSiteByNumber(db, TRACKING)
    expect(ctx?.siteId).toBe(siteId)
    expect(ctx?.displayName).toBe('Kenosha Air')
    expect(ctx?.dispatchFeeMicros).toBe(89_000_000n)
    // Formatting variants must resolve to the same row.
    expect((await resolveSiteByNumber(db, '(414) 555-0134'))?.siteId).toBe(siteId)
    expect(await resolveSiteByNumber(db, '+19995550000')).toBeNull()
  })

  // --- A full booked call --------------------------------------------------

  it('ingests a complete call: row, lead, spend, latency, recording job', async () => {
    const at = new Date('2026-03-09T15:00:00Z')
    const fixture = fixtureCall({
      callId: 'e2e_booked',
      siteId,
      toNumber: TRACKING,
      scenario: 'booked',
      at,
    })

    await drive(fixture)

    const call = await getCallByRetellId(db, 'e2e_booked')
    expect(call).not.toBeNull()
    expect(call!.siteId).toBe(siteId)
    expect(call!.unattributedReason).toBeNull()
    expect(call!.ingestState).toBe('analyzed')
    expect(call!.transcript).toContain('Thanks for calling')

    // Latency percentiles persisted -- "callers can't tell it's an AI" needs a number.
    expect(call!.latencyE2eP50Ms).toBeGreaterThan(0)
    expect(call!.latencyE2eP95Ms).toBeGreaterThan(call!.latencyE2eP50Ms!)

    // Cost converted from Retell's cents into micros and written to the ledger.
    const ended = fixture.eventPayloads[1] as { call: { call_cost: { combined_cost: number } } }
    expect(call!.costMicros).toBe(centsToMicros(ended.call.call_cost.combined_cost))
    const [ledger] = await db
      .select()
      .from(spendLedger)
      .where(and(eq(spendLedger.siteId, siteId), eq(spendLedger.endpoint, 'retell/call')))
    expect(ledger!.costMicros).toBe(call!.costMicros)

    // Lead captured mid-call.
    const [lead] = await db.select().from(leads).where(eq(leads.callId, call!.id))
    expect(lead!.name).toBeTruthy()
    expect(lead!.phone).toMatch(/^\+1\d{10}$/)
    expect(lead!.inServiceArea).toBe(true)
    expect(lead!.qualified).toBe(true)
    expect(lead!.capturedVia).toBe('tool')
    expect(lead!.capturedFields).toContain('name')
    expect(lead!.capturedFields).toContain('phone')

    // The banner is now clear, and it is a real measurement.
    const [siteRow] = await db.select().from(sites).where(eq(sites.id, siteId))
    expect(siteRow!.firstWebhookAt).not.toBeNull()

    // Recording queued, not fetched inline -- the upstream link can be a 10-minute
    // window, so this has to be retryable.
    const jobs = await db
      .select()
      .from(voiceJobs)
      .where(and(eq(voiceJobs.kind, 'fetch_recording'), eq(voiceJobs.callId, call!.id)))
    expect(jobs).toHaveLength(1)
  })

  // --- The two cases a happy-path test would miss --------------------------

  it('keeps a row for an abandoned call, with no lead', async () => {
    // Abandon rate is how you learn the greeting is too slow or too synthetic.
    // Creating the row at end-of-call would make every one of these vanish.
    const fixture = fixtureCall({
      callId: 'e2e_abandoned',
      siteId,
      toNumber: TRACKING,
      scenario: 'abandoned',
      at: new Date('2026-03-09T16:00:00Z'),
    })
    await drive(fixture)

    const call = await getCallByRetellId(db, 'e2e_abandoned')
    expect(call).not.toBeNull()
    expect(call!.durationMs).toBeLessThan(10_000)
    expect(call!.disconnectionReason).toBe('user_hangup')

    const found = await db.select().from(leads).where(eq(leads.callId, call!.id))
    expect(found).toHaveLength(0)

    const stats = await getSiteStats(db, siteId)
    expect(stats.abandonedUnder10s).toBeGreaterThanOrEqual(1)
  })

  it('stores is_emergency as NULL when urgency was never established', async () => {
    // ========== THE MOST IMPORTANT ASSERTION IN THIS FILE ==========
    // The fixture sends is_emergency: "unknown". If that lands as `false`, the UI
    // renders "routine" for a call nobody ever asked about -- which is how a
    // no-heat call at 11pm in January gets queued for Tuesday.
    const fixture = fixtureCall({
      callId: 'e2e_unknown_urgency',
      siteId,
      toNumber: TRACKING,
      scenario: 'out_of_area',
      at: new Date('2026-03-09T17:00:00Z'),
    })
    await drive(fixture)

    const call = await getCallByRetellId(db, 'e2e_unknown_urgency')
    const [lead] = await db.select().from(leads).where(eq(leads.callId, call!.id))

    expect(lead!.isEmergency).toBeNull()
    expect(lead!.isEmergency).not.toBe(false)

    // Out of area is a definite false, and disqualifies -- but the lead is KEPT,
    // because in a rank-and-rent business those are resellable inventory.
    expect(lead!.inServiceArea).toBe(false)
    expect(lead!.qualified).toBe(false)
  })

  it('promotes a hazard to emergency even when the model did not say so', async () => {
    // Two independent paths to the same escalation: the model's own flag, and
    // deterministic triage over the problem text. Triage can promote, never demote.
    const fixture = fixtureCall({
      callId: 'e2e_gas',
      siteId,
      toNumber: TRACKING,
      scenario: 'gas_emergency',
      at: new Date('2026-03-09T18:00:00Z'),
    })
    await drive(fixture)

    const call = await getCallByRetellId(db, 'e2e_gas')
    const [lead] = await db.select().from(leads).where(eq(leads.callId, call!.id))
    expect(lead!.isEmergency).toBe(true)
    expect(lead!.hazard).toBe('gas')
  })

  // --- Idempotency and retry ----------------------------------------------

  it('treats a redelivered webhook as a duplicate, but a FAILED one as reprocessable', async () => {
    const payload = { event: 'call_ended', call: { call_id: 'e2e_dupe', metadata: { site_id: siteId } } }

    const first = await recordWebhookEvent(db, {
      eventType: 'call_ended',
      retellCallId: 'e2e_dupe',
      payload,
      signatureValid: true,
    })
    expect(first).toMatchObject({ fresh: true, shouldProcess: true })

    // Retell's normal 3x retry of a delivery that already succeeded.
    const second = await recordWebhookEvent(db, {
      eventType: 'call_ended',
      retellCallId: 'e2e_dupe',
      payload,
      signatureValid: true,
    })
    expect(second).toMatchObject({ fresh: false, shouldProcess: false })

    // Now simulate the handler having thrown. The retry MUST reprocess, otherwise
    // the 500 the route returns is advice nobody can act on and the call is lost.
    await markEventHandlerError(db, first.eventId!, 'boom')
    const third = await recordWebhookEvent(db, {
      eventType: 'call_ended',
      retellCallId: 'e2e_dupe',
      payload,
      signatureValid: true,
    })
    expect(third.shouldProcess).toBe(true)

    // And once it succeeds it stops being reprocessable.
    await clearEventHandlerError(db, first.eventId!)
    const fourth = await recordWebhookEvent(db, {
      eventType: 'call_ended',
      retellCallId: 'e2e_dupe',
      payload,
      signatureValid: true,
    })
    expect(fourth.shouldProcess).toBe(false)
  })

  it('never lets a sparse later event erase data an earlier one carried', async () => {
    const at = new Date('2026-03-09T19:00:00Z')
    const fixture = fixtureCall({
      callId: 'e2e_order',
      siteId,
      toNumber: TRACKING,
      scenario: 'booked',
      at,
    })
    await drive(fixture)

    const before = await getCallByRetellId(db, 'e2e_order')
    expect(before!.transcript).toBeTruthy()

    // A redelivered `call_started` arrives AFTER `call_analyzed`. It carries no
    // transcript. Writing its nulls would erase one we already have, and
    // ingest_state must not walk backwards either.
    const started = parseRetellEvent(fixture.eventPayloads[0])!
    await handleCallEvent(db, { eventType: 'call_started', parsed: started.call! })

    const after = await getCallByRetellId(db, 'e2e_order')
    expect(after!.transcript).toBe(before!.transcript)
    expect(after!.ingestState).toBe('analyzed')
  })

  // --- Unattributed --------------------------------------------------------

  it('keeps a call with no site_id, with a stated reason, rather than guessing', async () => {
    // This is what a failed inbound webhook looks like. Resolving by to_number here
    // instead would silently reattribute history whenever a number moves.
    const fixture = fixtureCall({
      callId: 'e2e_orphan',
      siteId,
      toNumber: TRACKING,
      scenario: 'booked',
      at: new Date('2026-03-09T20:00:00Z'),
    })
    const stripped = JSON.parse(JSON.stringify(fixture.eventPayloads[1])) as {
      call: { metadata?: unknown }
    }
    delete stripped.call.metadata

    const parsed = parseRetellEvent(stripped)!
    await handleCallEvent(db, { eventType: 'call_ended', parsed: parsed.call! })

    const call = await getCallByRetellId(db, 'e2e_orphan')
    expect(call!.siteId).toBeNull()
    expect(call!.unattributedReason).toContain('inbound webhook')
    expect(call!.unattributedReason).toContain(TRACKING)

    const orphans = await listUnattributedCalls(db)
    expect(orphans.map((c) => c.retellCallId)).toContain('e2e_orphan')

    // And it is excluded from the site's own numbers rather than inflating them.
    const stats = await getSiteStats(db, siteId)
    expect(stats.unattributed).toBeGreaterThanOrEqual(1)
  })

  // --- Worker jobs ---------------------------------------------------------

  it('runs the recording job to disk and the delivery job to a ledger row', async () => {
    const providers = createVoiceProviders()
    expect(providers.live).toBe(false)

    let ran = 0
    let job = await claimNextVoiceJob(db, 'e2e-worker')
    while (job !== null && ran < 40) {
      const res = await runVoiceJob(db, { job, providers })
      // Delivery for a lead whose site has an alert number should succeed; a
      // recording fetch against the fixture provider should store bytes.
      if (job.kind === 'fetch_recording' || job.kind === 'deliver_lead') {
        expect(res.ok, `${job.kind} #${job.id}: ${res.detail}`).toBe(true)
      }
      ran++
      job = await claimNextVoiceJob(db, 'e2e-worker')
    }
    expect(ran).toBeGreaterThan(0)

    const booked = await getCallByRetellId(db, 'e2e_booked')
    expect(booked!.recordingPath).toBe(`${siteId}/2026-03/e2e_booked.wav`)
    expect(booked!.recordingBytes).toBeGreaterThan(0)
    expect(booked!.recordingMissingReason).toBeNull()

    const deliveries = await db.select().from(leadDeliveries)
    expect(deliveries.length).toBeGreaterThan(0)
    expect(deliveries.every((d) => d.status === 'sent')).toBe(true)
    // sentAt is NOT defaulted to now() -- it is set only when the provider confirmed.
    expect(deliveries.every((d) => d.sentAt !== null)).toBe(true)
    expect(deliveries.some((d) => d.target === '+14145550177')).toBe(true)
  })

  // --- Reconciliation ------------------------------------------------------

  it('lets post-call analysis fill nulls but never overwrite the mid-call value', async () => {
    const at = new Date('2026-03-09T21:00:00Z')
    const fixture = fixtureCall({
      callId: 'e2e_reconcile',
      siteId,
      toNumber: TRACKING,
      scenario: 'booked',
      at,
    })

    // Ingest through `call_ended` and save a lead with a KNOWN name, no email.
    const started = parseRetellEvent(fixture.eventPayloads[0])!
    await handleCallEvent(db, { eventType: 'call_started', parsed: started.call! })
    const call = await getCallByRetellId(db, 'e2e_reconcile')
    await saveLeadFromTool(db, {
      call: call!,
      rawArgs: { name: 'Mid Call Name', phone: '4145559999', problem: 'no cooling' },
    })

    // Analysis now disagrees on the name and adds an email.
    const analyzed = JSON.parse(JSON.stringify(fixture.eventPayloads[2])) as {
      call: { call_analysis: { custom_analysis_data: Record<string, unknown> } }
    }
    analyzed.call.call_analysis.custom_analysis_data = {
      name: 'Analysis Name',
      email: 'someone at example dot com',
    }
    const parsed = parseRetellEvent(analyzed)!
    await handleCallEvent(db, { eventType: 'call_analyzed', parsed: parsed.call! })

    const [lead] = await db.select().from(leads).where(eq(leads.callId, call!.id))
    // The tool wins. Analysis re-reads a transcript; the tool recorded what the
    // agent actually confirmed with the caller out loud.
    expect(lead!.name).toBe('Mid Call Name')
    // But it fills what was missing.
    expect(lead!.email).toBe('someone@example.com')
    // And the disagreement is recorded, because a recurring conflict on one field
    // is a prompt bug and this is the only place it becomes visible.
    expect(lead!.reconcileConflict).toMatchObject({
      name: { tool: 'Mid Call Name', analysis: 'Analysis Name' },
    })
  })

  // --- The $0 assertion ----------------------------------------------------

  it('spent nothing on providers -- only Retell-reported call costs are in the ledger', async () => {
    // The voice provider seam defaults to fixtures, so no recording download, no
    // get-call, and no SMS actually left the machine. The only ledger rows are the
    // costs Retell REPORTED in the fixture payloads, which is data, not spend.
    const rows = await db.select().from(spendLedger)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.endpoint === 'retell/call')).toBe(true)

    const [dfs] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(spendLedger)
      .where(sql`${spendLedger.endpoint} <> 'retell/call'`)
    expect(dfs!.n).toBe(0)
  })

  it('recorded every webhook, so any ingest bug is replayable', async () => {
    const events = await db.select().from(webhookEvents)
    expect(events.length).toBeGreaterThan(5)
    // Insert-first means the payload survives even a handler that threw.
    expect(events.every((e) => e.payload !== null)).toBe(true)
    const [orphanEvents] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(isNull(webhookEvents.retellCallId))
    expect(orphanEvents!.n).toBe(0)
  })
})

// ---------------------------------------------------------------------------

/** Push a fixture call through the ingest layer in the order Retell would. */
async function drive(fixture: ReturnType<typeof fixtureCall>): Promise<void> {
  const post = async (payload: unknown): Promise<void> => {
    const parsed = parseRetellEvent(payload)
    if (parsed === null || parsed.call === null) return
    const rec = await recordWebhookEvent(db, {
      eventType: parsed.eventType,
      retellCallId: parsed.call.callId,
      siteId: parsed.call.siteId,
      payload,
      signatureValid: true,
    })
    if (!rec.shouldProcess) return
    await handleCallEvent(db, { eventType: parsed.eventType, parsed: parsed.call })
  }

  await post(fixture.eventPayloads[0])

  for (const toolPayload of fixture.toolPayloads) {
    const tool = parseToolCall(toolPayload)
    const call = await getCallByRetellId(db, tool.callId!)
    if (call === null) continue
    await saveLeadFromTool(db, { call, rawArgs: tool.args })
  }

  await post(fixture.eventPayloads[1])
  await post(fixture.eventPayloads[2])
}

