'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { usdToMicros, type SiteStatus, type WeeklyHours } from '@rnr/core'
import {
  createSite,
  db,
  enqueueVoiceJob,
  fixtureCall,
  FIXTURE_SCENARIOS,
  getCallById,
  getSiteById,
  getSiteDetail,
  SiteValidationError,
  updateSite,
  type FixtureScenario,
} from '@rnr/data'

/**
 * Site server actions.
 *
 * Mirrors app/actions.ts: validation errors come back as values for the form to
 * render, never as thrown exceptions -- a redirect-on-error would lose everything
 * the operator typed.
 */

export interface CreateSiteResult {
  ok: boolean
  siteId?: number
  error?: string
}

export async function createSiteAction(formData: FormData): Promise<CreateSiteResult> {
  const s = (k: string): string | null => {
    const v = formData.get(k)
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }
  const n = (k: string): number | null => {
    const v = s(k)
    if (v === null) return null
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }

  const domain = s('domain')
  const localityId = n('localityId')
  const nicheId = n('nicheId')

  if (domain === null) return { ok: false, error: 'A domain is required.' }
  if (localityId === null) return { ok: false, error: 'Pick a locality.' }
  if (nicheId === null) return { ok: false, error: 'Pick a niche.' }

  // Zips: split on anything non-numeric so "53140, 53142" and "53140 53142" both work.
  const zipsRaw = s('serviceAreaZips')
  const serviceAreaZips =
    zipsRaw === null
      ? null
      : [...new Set(zipsRaw.split(/[^0-9]+/).filter((z) => z.length === 5))]

  const feeUsd = n('dispatchFeeUsd')

  // Hours: the form posts open/close per day, and an absent day means CLOSED --
  // never "open all day". See @rnr/core hours.ts for why that polarity matters.
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
  const hours: WeeklyHours = {}
  let anyDay = false
  for (const d of days) {
    const open = s(`hours_${d}_open`)
    const close = s(`hours_${d}_close`)
    if (formData.get(`hours_${d}_enabled`) === 'on' && open && close) {
      hours[d] = { open, close }
      anyDay = true
    } else {
      hours[d] = null
    }
  }

  const purchased = s('purchasedAt')

  try {
    const site = await createSite(db(), {
      domain,
      localityId,
      nicheId,
      shortlistItemId: n('shortlistItemId'),
      displayName: s('displayName'),
      status: (s('status') as SiteStatus | null) ?? 'parked',
      timezone: s('timezone') ?? 'America/Chicago',
      hours: anyDay ? hours : null,
      serviceAreaZips: serviceAreaZips && serviceAreaZips.length > 0 ? serviceAreaZips : null,
      dispatchFeeMicros: feeUsd === null ? null : usdToMicros(feeUsd),
      onCallNumber: s('onCallNumber'),
      leadAlertNumber: s('leadAlertNumber'),
      purchasedAt: purchased === null ? null : new Date(purchased),
      notes: s('notes'),
    })

    revalidatePath('/sites')
    revalidatePath('/shortlist')
    return { ok: true, siteId: site.id }
  } catch (e) {
    if (e instanceof SiteValidationError) return { ok: false, error: e.message }
    const message = (e as Error).message ?? String(e)
    // The one failure worth naming: a UNIQUE violation on domain is a real
    // operator mistake, not a bug, and "duplicate key value violates..." is not
    // an answer.
    if (/sites_domain_uq|duplicate key/i.test(message)) {
      return { ok: false, error: `${domain} is already in the list.` }
    }
    return { ok: false, error: message }
  }
}

export async function setSiteStatusAction(siteId: number, status: SiteStatus): Promise<void> {
  await updateSite(db(), siteId, { status })
  revalidatePath('/sites')
  revalidatePath(`/sites/${siteId}`)
}

export interface SaveTelephonyResult {
  ok: boolean
  error?: string
}

/**
 * Record the Retell/Twilio wiring for a site.
 *
 * Deliberately does NOT set `retellNumberImportedAt` -- only the provisioning
 * script does, because that timestamp claims "the number is attached to the trunk
 * and imported into Retell", and typing a number into a form is not evidence of
 * either.
 */
export async function saveTelephonyAction(formData: FormData): Promise<SaveTelephonyResult> {
  const s = (k: string): string | null => {
    const v = formData.get(k)
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }

  // siteId travels in the form rather than as a second argument, so this can be
  // handed to a client component as a plain action reference. A wrapper arrow that
  // closed over siteId cannot cross the server/client boundary -- that is the
  // "Event handlers cannot be passed to Client Component props" error.
  const siteId = Number(s('siteId'))
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return { ok: false, error: 'Missing site id.' }
  }

  const { toE164 } = await import('@rnr/core')
  const tracking = s('trackingNumber')
  const normalized = tracking === null ? null : toE164(tracking)
  if (tracking !== null && normalized === null) {
    return { ok: false, error: `"${tracking}" is not a valid US number.` }
  }

  const onCall = s('onCallNumber')
  const onCallE164 = onCall === null ? null : toE164(onCall)
  if (onCall !== null && onCallE164 === null) {
    return { ok: false, error: `On-call number "${onCall}" is not valid.` }
  }

  const alert = s('leadAlertNumber')
  const alertE164 = alert === null ? null : toE164(alert)
  if (alert !== null && alertE164 === null) {
    return { ok: false, error: `Lead alert number "${alert}" is not valid.` }
  }

  await updateSite(db(), siteId, {
    trackingNumber: normalized,
    retellAgentId: s('retellAgentId'),
    onCallNumber: onCallE164,
    leadAlertNumber: alertE164,
  })

  revalidatePath(`/sites/${siteId}`)
  return { ok: true }
}

/**
 * Create this site's Retell agent from the script in the form.
 *
 * ==================== THIS CREATES, IT DOES NOT DIAL ====================
 * Nothing a caller can reach changes here: the agent exists in Retell and answers
 * nothing until a number is imported against it, which is still `pnpm
 * sites:provision --confirm`. That separation is deliberate -- attaching a DID to
 * the trunk takes a live business line off Programmable Voice, and creating an
 * agent is reversible by deleting it.
 * ======================================================================
 */
export interface CreateAgentResult {
  ok: boolean
  detail: string
  agentId?: string
}

export async function createRetellAgentAction(formData: FormData): Promise<CreateAgentResult> {
  const s = (k: string): string | null => {
    const v = formData.get(k)
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }

  const siteId = Number(s('siteId'))
  if (!Number.isInteger(siteId) || siteId <= 0) return { ok: false, detail: 'Missing site id.' }

  const { createAgentForSite, createVoiceProviders, liveCallsEnabled, AgentCreateError } =
    await import('@rnr/data')

  if (!liveCallsEnabled()) {
    // Checked here so the message names the flag rather than surfacing the fixture
    // provider's refusal, which reads like a bug to anyone who has not read it.
    return {
      ok: false,
      detail:
        'LIVE_CALLS_ENABLED is not "true", so nothing was sent to Retell. This creates a real ' +
        'billable agent, so it refuses in fixture mode rather than inventing an agent id.',
    }
  }

  try {
    const result = await createAgentForSite(db(), {
      siteId,
      providers: createVoiceProviders(),
      ...(s('prompt') ? { prompt: s('prompt')! } : {}),
      ...(s('agentName') ? { agentName: s('agentName')! } : {}),
    })

    revalidatePath(`/sites/${siteId}`)
    const failing = result.snapshot.checks.filter((c) => c.status === 'fail')
    return {
      ok: true,
      agentId: result.agentId,
      detail:
        `Created "${result.agentName}" (${result.agentId}) and re-read it from Retell. ` +
        (failing.length === 0
          ? 'All integration checks pass. Edit the voice and script in the Retell dashboard, ' +
            'then provision a number.'
          : `${failing.length} check(s) still failing: ${failing.map((c) => c.label).join(', ')}.`),
    }
  } catch (e) {
    if (e instanceof AgentCreateError) return { ok: false, detail: e.message }
    return { ok: false, detail: (e as Error).message ?? String(e) }
  }
}

/**
 * Every agent in the Retell account, newest first, one row per agent.
 *
 * A picker rather than a text box. Copying a 30-character id out of a dashboard URL is
 * the step that silently binds a site to the wrong agent, and it is invisible until a
 * call comes in with the wrong greeting.
 */
export interface LiveAgentOption {
  agentId: string
  agentName: string | null
  responseEngineType: string
  version: number | null
  publishedVersion: number | null
  isPublished: boolean | null
}

export async function listLiveAgentsAction(): Promise<{
  ok: boolean
  detail?: string
  agents: LiveAgentOption[]
}> {
  const { collapseAgentVersions, parseAgent } = await import('@rnr/core')
  const { createVoiceProviders, liveCallsEnabled } = await import('@rnr/data')

  if (!process.env['RETELL_API_KEY']) {
    return { ok: false, detail: 'RETELL_API_KEY is not set.', agents: [] }
  }

  try {
    const raw = await createVoiceProviders().listAgents()
    const agents = collapseAgentVersions(
      raw.map(parseAgent).filter((a): a is NonNullable<typeof a> => a !== null),
    ).map((a) => ({
      agentId: a.agentId,
      agentName: a.agentName,
      responseEngineType: a.responseEngineType,
      version: a.version,
      publishedVersion: a.publishedVersion,
      isPublished: a.isPublished,
    }))

    return {
      ok: true,
      agents,
      ...(liveCallsEnabled()
        ? {}
        : { detail: 'LIVE_CALLS_ENABLED is not "true" — this is the offline fixture, not your account.' }),
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message, agents: [] }
  }
}

/** What switching to this agent would mean. Read-only. */
export async function preflightSwitchAction(
  siteId: number,
  targetAgentId: string,
): Promise<{ ok: boolean; detail?: string; preflight?: unknown }> {
  const { createVoiceProviders, preflightSwitch, SwitchAgentError } = await import('@rnr/data')
  try {
    const pre = await preflightSwitch(db(), {
      siteId,
      targetAgentId,
      providers: createVoiceProviders(),
    })
    // Only the serialisable parts cross the RSC boundary; the snapshot holds Dates and
    // the whole remote payload, and the client needs neither.
    return {
      ok: true,
      preflight: {
        targetAgentId: pre.targetAgentId,
        targetAgentName: pre.targetAgentName,
        currentAgentId: pre.currentAgentId,
        phoneNumber: pre.phoneNumber,
        numberIsImported: pre.numberIsImported,
        checks: pre.checks,
        blockers: pre.blockers,
      },
    }
  } catch (e) {
    if (e instanceof SwitchAgentError) return { ok: false, detail: e.message }
    return { ok: false, detail: (e as Error).message }
  }
}

/**
 * Re-point this site — and the number that rings it — at a different agent.
 *
 * Changes live call routing, so it refuses in fixture mode and refuses on a failing
 * preflight unless the caller explicitly overrode it in the UI.
 */
export async function switchAgentAction(formData: FormData): Promise<{
  ok: boolean
  detail: string
}> {
  const siteId = Number(formData.get('siteId'))
  const targetAgentId = String(formData.get('targetAgentId') ?? '').trim()
  const override = formData.get('override') === 'on'

  if (!Number.isInteger(siteId) || siteId <= 0) return { ok: false, detail: 'Missing site id.' }
  if (targetAgentId === '') return { ok: false, detail: 'Pick an agent first.' }

  const { createVoiceProviders, liveCallsEnabled, switchSiteAgent, SwitchAgentError } =
    await import('@rnr/data')

  if (!liveCallsEnabled()) {
    return {
      ok: false,
      detail:
        'LIVE_CALLS_ENABLED is not "true", so nothing was sent to Retell. This re-routes a live ' +
        'phone line, so it refuses in fixture mode rather than pretending.',
    }
  }

  try {
    const r = await switchSiteAgent(db(), {
      siteId,
      targetAgentId,
      providers: createVoiceProviders(),
      override,
    })
    revalidatePath(`/sites/${siteId}`)
    revalidatePath('/agent')

    const numberPart =
      r.confirmedAgentIds.length === 0
        ? 'No imported number to re-point, so only this database changed.'
        : r.numberRepointed
          ? 'Retell confirms the number now answers with it.'
          : `WARNING: Retell still reports ${r.confirmedAgentIds.join(', ')} on that number. ` +
            'The switch did not take — do not rely on it.'

    return {
      ok: r.confirmedAgentIds.length === 0 || r.numberRepointed,
      detail:
        `Switched from ${r.from ?? 'no agent'} to ${r.to}. ${numberPart}` +
        (r.overrode.length > 0 ? ` Overrode: ${r.overrode.map((b) => b.id).join(', ')}.` : ''),
    }
  } catch (e) {
    if (e instanceof SwitchAgentError) return { ok: false, detail: e.message }
    return { ok: false, detail: (e as Error).message }
  }
}

export async function switchBackAction(siteId: number): Promise<{ ok: boolean; detail: string }> {
  const { createVoiceProviders, liveCallsEnabled, switchBack, SwitchAgentError } =
    await import('@rnr/data')

  if (!liveCallsEnabled()) {
    return { ok: false, detail: 'LIVE_CALLS_ENABLED is not "true", so nothing was sent to Retell.' }
  }

  try {
    const r = await switchBack(db(), { siteId, providers: createVoiceProviders() })
    revalidatePath(`/sites/${siteId}`)
    revalidatePath('/agent')
    return {
      ok: true,
      detail: `Rolled back to ${r.to}.${r.numberRepointed ? ' Retell confirms the number.' : ''}`,
    }
  } catch (e) {
    if (e instanceof SwitchAgentError) return { ok: false, detail: e.message }
    return { ok: false, detail: (e as Error).message }
  }
}

/**
 * Send a signed fixture call at our own endpoints.
 *
 * This is the "Send test event" button, and it is the thing that stops a
 * misconfiguration from ever being silent: it proves the ingest path end to end
 * without waiting for a real caller, and it fails loudly when RETELL_API_KEY or
 * PUBLIC_BASE_URL is wrong.
 */
export interface TestEventResult {
  ok: boolean
  detail: string
}

export async function sendTestEventAction(
  siteId: number,
  /**
   * A plain string, VALIDATED here rather than cast.
   *
   * It arrives from a <select> in the browser, so it is untrusted input. The earlier
   * version took a `FixtureScenario` and the page cast to it -- which meant the type
   * was a claim about the client rather than a fact, and it forced an inline wrapper
   * arrow that Next cannot serialise across the server/client boundary at all.
   */
  scenario: string = 'urgent_no_heat',
): Promise<TestEventResult> {
  const chosen: FixtureScenario = (FIXTURE_SCENARIOS as readonly string[]).includes(scenario)
    ? (scenario as FixtureScenario)
    : 'urgent_no_heat'

  const site = await getSiteById(db(), siteId)
  if (site === null) return { ok: false, detail: 'Site not found.' }

  const apiKey = process.env['RETELL_API_KEY']
  if (!apiKey) {
    return {
      ok: false,
      detail:
        'RETELL_API_KEY is not set, so a signed test event cannot be produced. ' +
        'The ingest routes verify every payload and have no bypass.',
    }
  }

  const base = process.env['PUBLIC_BASE_URL']
  if (!base) {
    return { ok: false, detail: 'PUBLIC_BASE_URL is not set, so there is no URL to post to.' }
  }

  const { signRetellPayload } = await import('@rnr/data')
  const callId = `test_${siteId}_${Date.now().toString(36)}`
  const fixture = fixtureCall({
    callId,
    siteId,
    toNumber: site.trackingNumber ?? '+10000000000',
    scenario: chosen,
  })

  const post = async (path: string, payload: unknown): Promise<number> => {
    const raw = JSON.stringify(payload)
    const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-retell-signature': signRetellPayload({ rawBody: raw, apiKey }),
      },
      body: raw,
    })
    return res.status
  }

  try {
    const statuses: number[] = []
    statuses.push(await post('/api/retell/events', fixture.eventPayloads[0]))
    for (const tool of fixture.toolPayloads) {
      statuses.push(await post('/api/retell/tool/save-lead', tool))
    }
    statuses.push(await post('/api/retell/events', fixture.eventPayloads[1]))
    statuses.push(await post('/api/retell/events', fixture.eventPayloads[2]))

    revalidatePath(`/sites/${siteId}`)
    const bad = statuses.filter((s) => s >= 300)
    if (bad.length > 0) {
      return { ok: false, detail: `Some requests failed: ${statuses.join(', ')}` }
    }
    return {
      ok: true,
      detail: `Fixture call ${callId} (${fixture.scenario}) ingested. ${statuses.length} requests, all 2xx.`,
    }
  } catch (e) {
    return { ok: false, detail: `Could not reach ${base}: ${(e as Error).message}` }
  }
}

/**
 * Re-queue a recording fetch after a failure.
 *
 * Takes only the call id and looks the site up itself. The earlier version also took
 * a siteId from the caller, which forced an inline wrapper arrow in the page -- and
 * those cannot cross the server/client boundary, which is what produced the
 * "Event handlers cannot be passed to Client Component props" runtime error.
 *
 * Deriving it server-side is also correct on its own terms: the browser should not be
 * telling us which site a call belongs to, and we should not be trusting it if it did.
 */
export async function refetchRecordingAction(callId: number): Promise<void> {
  const database = db()
  const call = await getCallById(database, callId)
  if (call === null) return

  // If we already have bytes, revalidate so a false-negative UI clears without
  // re-downloading. Re-queue only when nothing is stored yet.
  if (call.recordingPath === null || call.recordingBytes === null || call.recordingBytes <= 0) {
    await enqueueVoiceJob(database, { kind: 'fetch_recording', callId })
  }
  if (call.siteId !== null) {
    revalidatePath(`/sites/${call.siteId}`)
    const detail = await getSiteDetail(database, call.siteId)
    if (detail) {
      revalidatePath(`/portfolio/${detail.localitySlug}/${detail.nicheSlug}`)
    }
    revalidatePath('/portfolio')
  }
}

export async function goToSite(siteId: number): Promise<void> {
  redirect(`/sites/${siteId}`)
}

/**
 * Record what became of a lead.
 *
 * FormData only, with `leadId` inside the form, so this can be handed to a client
 * component as a plain action reference -- a wrapper arrow closing over the id cannot
 * cross the server/client boundary, which is the "Event handlers cannot be passed to
 * Client Component props" error.
 */
export interface RecordOutcomeResult {
  ok: boolean
  error?: string
}

export async function recordLeadOutcomeAction(formData: FormData): Promise<RecordOutcomeResult> {
  const s = (k: string): string | null => {
    const v = formData.get(k)
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }

  const leadId = Number(s('leadId'))
  const siteId = Number(s('siteId'))
  if (!Number.isInteger(leadId) || leadId <= 0) return { ok: false, error: 'Missing lead id.' }

  const { LEAD_DISPOSITIONS, usdToMicros: toMicros } = await import('@rnr/core')
  const { clearLeadOutcome, recordLeadOutcome } = await import('@rnr/data')

  const raw = s('disposition')

  // Empty selection clears the outcome, returning the lead to "not followed up" --
  // which is NOT the same as recording it as lost, so it deletes rather than defaults.
  if (raw === null) {
    await clearLeadOutcome(db(), leadId)
    if (Number.isInteger(siteId)) revalidatePath(`/sites/${siteId}`)
    return { ok: true }
  }

  if (!(LEAD_DISPOSITIONS as readonly string[]).includes(raw)) {
    return { ok: false, error: `"${raw}" is not a disposition.` }
  }

  const valueRaw = s('jobValueUsd')
  let jobValueMicros: bigint | null = null
  if (valueRaw !== null) {
    const usd = Number(valueRaw.replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(usd) || usd < 0) {
      return { ok: false, error: `"${valueRaw}" is not a dollar amount.` }
    }
    jobValueMicros = toMicros(usd)
  }

  await recordLeadOutcome(db(), {
    leadId,
    disposition: raw as Parameters<typeof recordLeadOutcome>[1]['disposition'],
    jobValueMicros,
    notes: s('outcomeNotes'),
  })

  if (Number.isInteger(siteId)) revalidatePath(`/sites/${siteId}`)
  return { ok: true }
}
