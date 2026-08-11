import { Rng } from './prng.js'

/**
 * Deterministic fake calls.
 *
 * ==================== WHY THIS EXISTS BEFORE THE WEBHOOKS DO ====================
 * The alternative way to build a call dashboard is to phone the number, hang up,
 * and squint at logs -- once per iteration, at whatever pace the PSTN allows.
 *
 * With this, `pnpm voice:simulate` produces a complete call (inbound -> started ->
 * save_lead -> ended -> analyzed) in about a second, so the ingest layer and every
 * pixel of the dashboard are developable and testable with no Retell account, no
 * Twilio trunk, and no phone. It is also what lets the e2e suite assert spend === 0
 * across the whole voice path.
 *
 * Seeded from the call id, so the same call is the same call forever and the
 * assertions in the e2e suite do not have to be loosened until they stop meaning
 * anything.
 *
 * DETERMINISM, PRECISELY: everything is derived from `callId` EXCEPT the
 * timestamps, which are anchored to `at`. Pass `at` and the output is
 * byte-identical across processes; omit it and only the clock moves. The e2e suite
 * passes it; the `voice:simulate` script does not, because a dashboard full of
 * calls dated 1970 would be useless to look at.
 * ==============================================================================
 */

export interface FixtureCallOptions {
  /** Stable seed. Same id => byte-identical payloads, in any process, forever. */
  callId: string
  siteId: number
  toNumber: string
  fromNumber?: string
  agentId?: string
  /** Force a scenario instead of letting the seed pick one. */
  scenario?: FixtureScenario
  /**
   * Base time for the call. Defaults to now.
   *
   * Supply it for byte-identical output -- it is the ONLY non-seed-derived input.
   */
  at?: Date
}

/**
 * The scenarios worth having fixtures for.
 *
 * `abandoned` and `gas_emergency` are the two that matter most and are the two a
 * hand-written happy-path fixture would omit: one exercises "a row must exist for
 * a call that produced no lead", the other exercises the life-safety branch.
 */
export type FixtureScenario =
  | 'booked'
  | 'urgent_no_heat'
  | 'gas_emergency'
  | 'out_of_area'
  | 'abandoned'
  | 'voicemail'

const SCENARIOS: readonly FixtureScenario[] = [
  'booked',
  'urgent_no_heat',
  'gas_emergency',
  'out_of_area',
  'abandoned',
  'voicemail',
]

const NAMES = [
  'Dana Reyes',
  'Marcus Feld',
  'Priya Raman',
  'Tom Vasquez',
  'Ellen Boyd',
  'Sam Okafor',
  'Rita Nowak',
]

const STREETS = ['Sheridan Road', '52nd Street', 'Green Bay Road', 'Washington Road', '22nd Avenue']

export interface FixtureCall {
  scenario: FixtureScenario
  /** The inbound-webhook request Retell would send. */
  inboundPayload: unknown
  /** call_started / call_ended / call_analyzed, in order. */
  eventPayloads: unknown[]
  /** The save_lead tool POSTs the agent would make, in order. Empty when abandoned. */
  toolPayloads: unknown[]
  /** For assertions in tests. */
  expected: {
    durationMs: number
    isEmergency: boolean | null
    hasLead: boolean
    disconnectionReason: string
  }
}

export function fixtureCall(opts: FixtureCallOptions): FixtureCall {
  const rng = new Rng(`voice:${opts.callId}`)
  const scenario = opts.scenario ?? rng.pick(SCENARIOS)
  const startedAt = (opts.at ?? new Date()).getTime()

  const name = rng.pick(NAMES)
  const fromNumber = opts.fromNumber ?? `+1414555${String(rng.int(1000, 9999))}`
  const agentId = opts.agentId ?? 'agent_fixture'
  const street = `${rng.int(100, 9999)} ${rng.pick(STREETS)}`

  // Abandoned calls are short by definition. That is the point of the scenario:
  // the calls row must exist so abandon rate is measurable at all.
  const durationMs =
    scenario === 'abandoned'
      ? rng.int(2_000, 9_000)
      : scenario === 'voicemail'
        ? rng.int(12_000, 25_000)
        : rng.int(95_000, 320_000)

  const endedAt = startedAt + durationMs

  const inServiceZip = scenario === 'out_of_area' ? '60085' : '53140'
  const problem = problemFor(scenario, rng)
  const isEmergency = emergencyFor(scenario)
  const hasLead = scenario !== 'abandoned' && scenario !== 'voicemail'

  const transcript = transcriptFor({ scenario, name, street, zip: inServiceZip, problem, phone: fromNumber })

  const disconnectionReason =
    scenario === 'abandoned'
      ? 'user_hangup'
      : scenario === 'voicemail'
        ? 'voicemail_reached'
        : scenario === 'gas_emergency'
          ? 'call_transfer'
          : 'agent_hangup'

  // Latency: plausible, and deliberately including a p95 tail well above p50 --
  // Deepgram-class endpointing has exactly that shape, and a fixture with a flat
  // distribution would let a UI that ignores p95 look correct.
  const p50 = rng.int(420, 760)
  const latency = {
    e2e: { p50, p90: p50 + rng.int(150, 400), p95: p50 + rng.int(400, 900) },
    llm: { p50: rng.int(180, 420) },
    tts: { p50: rng.int(40, 120) },
  }

  const baseCall = {
    call_id: opts.callId,
    agent_id: agentId,
    call_type: 'phone_call',
    direction: 'inbound',
    from_number: fromNumber,
    to_number: opts.toNumber,
    // The frozen join key. Everything downstream reads the site from here.
    metadata: { site_id: opts.siteId },
    retell_llm_dynamic_variables: { business_name: 'Fixture HVAC' },
    start_timestamp: startedAt,
  }

  const endedCall = {
    ...baseCall,
    call_status: 'ended',
    end_timestamp: endedAt,
    duration_ms: durationMs,
    disconnection_reason: disconnectionReason,
    transcript,
    transcript_object: transcript
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line) => ({
        role: line.startsWith('Agent:') ? 'agent' : 'user',
        content: line.replace(/^(Agent|User):\s*/, ''),
      })),
    recording_url: `https://fixture.invalid/recordings/${opts.callId}.wav`,
    call_cost: {
      // Cents, as Retell reports. ~$0.11/min all-in.
      combined_cost: Math.max(1, Math.round((durationMs / 60_000) * 11)),
      total_duration_seconds: Math.round(durationMs / 1000),
    },
    latency,
  }

  const analyzedCall = {
    ...endedCall,
    call_analysis: {
      call_summary: summaryFor(scenario, name),
      user_sentiment: scenario === 'gas_emergency' ? 'Negative' : rng.pick(['Positive', 'Neutral']),
      call_successful: hasLead,
      in_voicemail: scenario === 'voicemail',
      custom_analysis_data: hasLead
        ? {
            name,
            phone: fromNumber,
            zip: inServiceZip,
            problem,
            system_type: rng.pick(['furnace', 'air_conditioner', 'heat_pump']),
            // Post-call analysis genuinely omits fields it could not determine.
            // Left absent rather than false so the reconcile path is exercised.
            ...(isEmergency === null ? {} : { is_emergency: isEmergency }),
          }
        : {},
    },
  }

  const toolPayloads: unknown[] = []
  if (hasLead) {
    // Two calls, as the real agent does: contact first, details as they arrive.
    toolPayloads.push({
      call_id: opts.callId,
      name: 'save_lead',
      args: { name, phone: fromNumber, problem },
    })
    toolPayloads.push({
      call_id: opts.callId,
      name: 'save_lead',
      args: {
        address_line: street,
        city: scenario === 'out_of_area' ? 'Zion' : 'Kenosha',
        zip: inServiceZip,
        system_type: 'furnace',
        system_age_years: `about ${rng.int(4, 22)} years`,
        is_owner: rng.bool(0.8) ? 'yes' : 'unknown',
        // The important fixture detail: 'unknown' must land as NULL, not false.
        is_emergency: isEmergency === null ? 'unknown' : isEmergency ? 'yes' : 'no',
        ...(scenario === 'gas_emergency' ? { hazard: 'gas' } : {}),
      },
    })
  }

  return {
    scenario,
    inboundPayload: {
      event: 'call_inbound',
      event_timestamp: startedAt,
      call_inbound: { from_number: fromNumber, to_number: opts.toNumber, agent_id: agentId },
    },
    eventPayloads: [
      { event: 'call_started', call: { ...baseCall, call_status: 'ongoing' } },
      { event: 'call_ended', call: endedCall },
      { event: 'call_analyzed', call: analyzedCall },
    ],
    toolPayloads,
    expected: { durationMs, isEmergency, hasLead, disconnectionReason },
  }
}

function problemFor(scenario: FixtureScenario, rng: Rng): string {
  switch (scenario) {
    case 'gas_emergency':
      return 'I smell gas in the basement near the furnace'
    case 'urgent_no_heat':
      return 'No heat at all since last night and it is freezing in here'
    case 'out_of_area':
      return 'Furnace is making a grinding noise'
    case 'booked':
      return rng.pick([
        'AC is blowing warm air',
        'Need the annual furnace tune up',
        'Thermostat is not responding',
      ])
    default:
      return 'Caller did not describe the problem'
  }
}

/**
 * `null` for the scenarios where urgency was never established.
 *
 * This is the fixture's most important job: it is what proves the ingest layer
 * stores NULL rather than false for a call that never got there.
 */
function emergencyFor(scenario: FixtureScenario): boolean | null {
  if (scenario === 'gas_emergency' || scenario === 'urgent_no_heat') return true
  if (scenario === 'booked') return false
  return null
}

function summaryFor(scenario: FixtureScenario, name: string): string {
  switch (scenario) {
    case 'gas_emergency':
      return `${name} reported a gas smell. Agent gave the evacuation script and transferred to on-call.`
    case 'urgent_no_heat':
      return `${name} has no heat. Urgent visit requested.`
    case 'out_of_area':
      return `${name} is outside the service area. Details taken for a callback.`
    case 'abandoned':
      return 'Caller hung up during the greeting.'
    case 'voicemail':
      return 'Reached voicemail.'
    default:
      return `${name} booked a visit.`
  }
}

function transcriptFor(a: {
  scenario: FixtureScenario
  name: string
  street: string
  zip: string
  problem: string
  phone: string
}): string {
  if (a.scenario === 'abandoned') {
    return 'Agent: Thanks for calling Fixture HVAC, this is the front desk.\n'
  }
  if (a.scenario === 'voicemail') {
    return 'Agent: Thanks for calling Fixture HVAC.\nUser: [voicemail greeting]\n'
  }
  if (a.scenario === 'gas_emergency') {
    return [
      'Agent: Thanks for calling Fixture HVAC, how can I help?',
      `User: ${a.problem}`,
      'Agent: Please stop what you are doing and leave the building now. Do not turn any lights or switches on or off. Once you are outside, call 911 or your gas utility right away.',
      'User: Okay, I am going outside now.',
      'Agent: I am transferring you to our on-call technician right now.',
    ].join('\n')
  }
  return [
    'Agent: Thanks for calling Fixture HVAC, how can I help?',
    `User: ${a.problem}`,
    'Agent: Got it. Can I start with your name?',
    `User: ${a.name}`,
    'Agent: And the best callback number?',
    `User: ${a.phone}`,
    'Agent: What is the service address?',
    `User: ${a.street}, ${a.zip}`,
    'Agent: I can do tomorrow between eight and eleven, or between one and four.',
    'User: The morning works.',
    'Agent: You are all set. Someone will call when they are on the way.',
  ].join('\n')
}

export { SCENARIOS as FIXTURE_SCENARIOS }
