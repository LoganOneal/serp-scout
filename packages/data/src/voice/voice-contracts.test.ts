import { describe, expect, it } from 'vitest'
import { centsToMicros } from '@rnr/core'
import {
  parseInboundEvent,
  parseRetellCall,
  parseRetellEvent,
  parseToolCall,
} from '../providers/retell/contracts.js'
import {
  signRetellPayload,
  verifyRetellSignature,
  SIGNATURE_TOLERANCE_MS,
} from '../providers/retell/signature.js'
import { fixtureCall, FIXTURE_SCENARIOS } from '../providers/fixtures/voice.js'
import { backoffSeconds, MAX_ATTEMPTS } from './jobs.js'
import { recordingRelPath, resolveRecordingPath } from './recordings.js'
import { composeLeadSms } from './delivery.js'
import type { Lead, Site } from '../schema.js'

/**
 * No database. These cover the parsing, signing and path handling -- the layers
 * where a mistake is silent and lands as a NULL that reads like a measurement.
 */

// --- Signature ---------------------------------------------------------------

describe('verifyRetellSignature', () => {
  const apiKey = 'key_abc123'
  const rawBody = '{"event":"call_ended","call":{"call_id":"c1"}}'

  it('accepts what signRetellPayload produces', () => {
    const now = 1_800_000_000_000
    const sig = signRetellPayload({ rawBody, apiKey, now })
    expect(verifyRetellSignature({ rawBody, signature: sig, apiKey, now })).toEqual({
      valid: true,
      reason: null,
    })
  })

  it('is bound to the exact bytes, not the parsed object', () => {
    const now = 1_800_000_000_000
    // Formatted exactly as a real webhook body might arrive: whitespace between
    // tokens. Re-serialising strips it -- same meaning, different bytes.
    const pretty = '{\n  "event": "call_ended",\n  "call": { "call_id": "c1" }\n}'
    const sig = signRetellPayload({ rawBody: pretty, apiKey, now })

    const reserialised = JSON.stringify(JSON.parse(pretty))
    expect(reserialised).not.toBe(pretty)

    // This is the mistake that wastes an afternoon looking like a wrong secret,
    // which is why the route handlers read req.text() and never req.json().
    expect(
      verifyRetellSignature({ rawBody: reserialised, signature: sig, apiKey, now }).valid,
    ).toBe(false)
    expect(verifyRetellSignature({ rawBody: pretty, signature: sig, apiKey, now }).valid).toBe(true)
  })

  it('rejects a replay outside the 5 minute window, in either direction', () => {
    const now = 1_800_000_000_000
    const sig = signRetellPayload({ rawBody, apiKey, now })
    const justInside = now + SIGNATURE_TOLERANCE_MS - 1000
    const justOutside = now + SIGNATURE_TOLERANCE_MS + 1000

    expect(verifyRetellSignature({ rawBody, signature: sig, apiKey, now: justInside }).valid).toBe(true)
    expect(verifyRetellSignature({ rawBody, signature: sig, apiKey, now: justOutside })).toEqual({
      valid: false,
      reason: 'stale_timestamp',
    })
    // A future-dated signature is what a replay looks like, so it fails too.
    expect(
      verifyRetellSignature({ rawBody, signature: sig, apiKey, now: now - SIGNATURE_TOLERANCE_MS - 1000 })
        .reason,
    ).toBe('stale_timestamp')
  })

  it('names each failure, and never throws on a malformed header', () => {
    const now = 1_800_000_000_000
    expect(verifyRetellSignature({ rawBody, signature: null, apiKey, now }).reason).toBe(
      'missing_signature',
    )
    expect(verifyRetellSignature({ rawBody, signature: 'garbage', apiKey, now }).reason).toBe(
      'malformed_signature',
    )
    expect(verifyRetellSignature({ rawBody, signature: 'v=abc,d=ff', apiKey, now }).reason).toBe(
      'malformed_signature',
    )
    // A digest of the wrong LENGTH must not blow up timingSafeEqual (which throws
    // on length mismatch) -- that would be a 500 where a 401 belongs.
    expect(verifyRetellSignature({ rawBody, signature: `v=${now},d=ff`, apiKey, now }).reason).toBe(
      'digest_mismatch',
    )
    expect(verifyRetellSignature({ rawBody, signature: 'v=1,d=x', apiKey: null, now }).reason).toBe(
      'missing_key',
    )
  })

  it('rejects a signature made with a different key', () => {
    const now = 1_800_000_000_000
    const sig = signRetellPayload({ rawBody, apiKey: 'other_key', now })
    expect(verifyRetellSignature({ rawBody, signature: sig, apiKey, now }).reason).toBe(
      'digest_mismatch',
    )
  })
})

// --- Contract parsing --------------------------------------------------------

describe('parseRetellCall', () => {
  it('reads the site only from metadata, never from to_number', () => {
    // The whole point of freezing site_id: a number reassigned between sites must
    // not retroactively reattribute historical calls.
    const withMeta = parseRetellCall({
      call_id: 'c1',
      to_number: '+14145550134',
      metadata: { site_id: 42 },
    })
    expect(withMeta?.siteId).toBe(42)

    const withoutMeta = parseRetellCall({ call_id: 'c1', to_number: '+14145550134' })
    expect(withoutMeta?.siteId).toBeNull()
  })

  it('rejects a payload with no call_id rather than inventing one', () => {
    expect(parseRetellCall({ to_number: '+1' })).toBeNull()
    expect(parseRetellCall(null)).toBeNull()
    expect(parseRetellCall('nope')).toBeNull()
    expect(parseRetellCall([])).toBeNull()
  })

  it('converts cost from cents to micros', () => {
    const p = parseRetellCall({ call_id: 'c1', call_cost: { combined_cost: 47 } })
    expect(p?.costMicros).toBe(centsToMicros(47))
    // Absent cost is null, not 0n -- a call with unknown cost is not a free call.
    expect(parseRetellCall({ call_id: 'c1' })?.costMicros).toBeNull()
  })

  it('survives a seconds-vs-millis timestamp mixup instead of landing in 1970', () => {
    const secs = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000)
    const p = parseRetellCall({ call_id: 'c1', start_timestamp: secs })
    expect(p?.startedAt?.getUTCFullYear()).toBe(2026)
    // Zero and nonsense are rejected outright.
    expect(parseRetellCall({ call_id: 'c1', start_timestamp: 0 })?.startedAt).toBeNull()
    expect(parseRetellCall({ call_id: 'c1', start_timestamp: 'soon' })?.startedAt).toBeNull()
  })

  it('derives duration from the timestamps when duration_ms is absent', () => {
    const start = Date.UTC(2026, 0, 15, 12, 0, 0)
    const p = parseRetellCall({ call_id: 'c1', start_timestamp: start, end_timestamp: start + 90_000 })
    expect(p?.durationMs).toBe(90_000)
  })

  it('keeps call_successful nullable so "not analyzed" is not "unsuccessful"', () => {
    expect(parseRetellCall({ call_id: 'c1' })?.callSuccessful).toBeNull()
    expect(
      parseRetellCall({ call_id: 'c1', call_analysis: { call_successful: false } })?.callSuccessful,
    ).toBe(false)
  })

  it('pulls latency percentiles', () => {
    const p = parseRetellCall({
      call_id: 'c1',
      latency: { e2e: { p50: 520, p90: 780, p95: 1100 }, llm: { p50: 210 }, tts: { p50: 60 } },
    })
    expect(p?.latencyE2e).toEqual({ p50: 520, p90: 780, p95: 1100 })
    expect(p?.latencyLlm.p50).toBe(210)
    // A missing percentile block yields nulls, not zeros.
    expect(parseRetellCall({ call_id: 'c1' })?.latencyE2e).toEqual({
      p50: null,
      p90: null,
      p95: null,
    })
  })
})

describe('parseRetellEvent', () => {
  it('ignores event types we do not model', () => {
    expect(parseRetellEvent({ event: 'something_new', call: {} })).toBeNull()
    expect(parseRetellEvent({ call: {} })).toBeNull()
    expect(parseRetellEvent(null)).toBeNull()
  })

  it('parses the three we do', () => {
    for (const event of ['call_started', 'call_ended', 'call_analyzed']) {
      const p = parseRetellEvent({ event, call: { call_id: 'c1' } })
      expect(p?.eventType, event).toBe(event)
      expect(p?.call?.callId).toBe('c1')
    }
  })
})

describe('parseInboundEvent', () => {
  it('reads from/to, and rejects anything else', () => {
    const p = parseInboundEvent({
      event: 'call_inbound',
      call_inbound: { from_number: '+14145551111', to_number: '+14145550134' },
    })
    expect(p?.toNumber).toBe('+14145550134')
    expect(parseInboundEvent({ event: 'call_started', call: {} })).toBeNull()
  })
})

describe('parseToolCall', () => {
  it('accepts every observed argument shape', () => {
    // Nested under args.
    expect(parseToolCall({ call_id: 'c1', name: 'save_lead', args: { name: 'Dana' } })).toEqual({
      callId: 'c1',
      name: 'save_lead',
      args: { name: 'Dana' },
    })
    // Flattened at the top level -- the envelope keys are stripped.
    expect(parseToolCall({ call_id: 'c1', name: 'save_lead', phone: '4145550134' }).args).toEqual({
      phone: '4145550134',
    })
    // call_id nested inside call.
    expect(parseToolCall({ call: { call_id: 'c2' }, name: 'save_lead', args: {} }).callId).toBe('c2')
  })

  it('returns nulls instead of throwing on junk', () => {
    expect(parseToolCall(null)).toEqual({ callId: null, name: null, args: null })
    expect(parseToolCall('x').callId).toBeNull()
  })
})

// --- Fixtures ----------------------------------------------------------------

describe('fixtureCall', () => {
  it('is byte-identical for a given call id and anchor time', () => {
    // `at` is the only non-seed-derived input. With it pinned, the whole payload is
    // reproducible -- which is what lets the e2e suite assert on exact values
    // instead of loosening until the assertions stop meaning anything.
    const at = new Date('2026-03-09T15:04:05Z')
    const a = fixtureCall({ callId: 'c_same', siteId: 1, toNumber: '+14145550134', at })
    const b = fixtureCall({ callId: 'c_same', siteId: 1, toNumber: '+14145550134', at })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('varies only the clock when `at` is omitted', () => {
    const a = fixtureCall({ callId: 'c_same', siteId: 1, toNumber: '+14145550134' })
    const b = fixtureCall({ callId: 'c_same', siteId: 1, toNumber: '+14145550134' })
    // Same scenario, same caller, same duration, same latency -- only timestamps
    // differ. `voice:simulate` relies on this: calls dated 1970 would be useless to
    // look at, but the content still has to be reproducible.
    expect(a.scenario).toBe(b.scenario)
    expect(a.expected).toEqual(b.expected)
    expect(JSON.stringify(a.toolPayloads)).toBe(JSON.stringify(b.toolPayloads))
  })

  it('always carries metadata.site_id on every event', () => {
    for (const scenario of FIXTURE_SCENARIOS) {
      const f = fixtureCall({ callId: `c_${scenario}`, siteId: 7, toNumber: '+1', scenario })
      for (const payload of f.eventPayloads) {
        const call = (payload as { call: { metadata: { site_id: number } } }).call
        expect(call.metadata.site_id, scenario).toBe(7)
      }
    }
  })

  it('produces an abandoned call with a row but no lead', () => {
    // The scenario a hand-written happy path would omit, and the one that proves
    // abandon rate is measurable at all.
    const f = fixtureCall({ callId: 'c_ab', siteId: 1, toNumber: '+1', scenario: 'abandoned' })
    expect(f.toolPayloads).toHaveLength(0)
    expect(f.expected.hasLead).toBe(false)
    expect(f.expected.durationMs).toBeLessThan(10_000)
    expect(f.expected.isEmergency).toBeNull()
  })

  it('sends is_emergency as the string "unknown" where urgency was never set', () => {
    // Which the tool parser must turn into NULL, not false.
    const f = fixtureCall({ callId: 'c_oa', siteId: 1, toNumber: '+1', scenario: 'out_of_area' })
    const second = f.toolPayloads[1] as { args: { is_emergency: string } }
    expect(second.args.is_emergency).toBe('unknown')
  })

  it('gives the gas scenario a hazard and a transfer', () => {
    const f = fixtureCall({ callId: 'c_gas', siteId: 1, toNumber: '+1', scenario: 'gas_emergency' })
    expect(f.expected.isEmergency).toBe(true)
    expect(f.expected.disconnectionReason).toBe('call_transfer')
    expect(JSON.stringify(f.toolPayloads)).toContain('gas')
  })

  it('models a p95 tail well above p50, because a flat one would hide UI bugs', () => {
    const f = fixtureCall({ callId: 'c_lat', siteId: 1, toNumber: '+1', scenario: 'booked' })
    const ended = f.eventPayloads[1] as {
      call: { latency: { e2e: { p50: number; p95: number } } }
    }
    const { p50, p95 } = ended.call.latency.e2e
    expect(p95).toBeGreaterThan(p50 + 300)
  })
})

// --- Job backoff -------------------------------------------------------------

describe('backoffSeconds', () => {
  it('grows and then caps', () => {
    expect(backoffSeconds(1)).toBe(30)
    expect(backoffSeconds(2)).toBe(120)
    expect(backoffSeconds(3)).toBe(480)
    expect(backoffSeconds(4)).toBe(1800)
    expect(backoffSeconds(99)).toBe(1800)
  })

  it('reaches the cap before giving up, so retries actually span time', () => {
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, i) => backoffSeconds(i + 1)).reduce(
      (a, b) => a + b,
      0,
    )
    // A recording whose upstream link lives 10 minutes deserves more than one shot.
    expect(total).toBeGreaterThan(600)
  })
})

// --- Recording paths ---------------------------------------------------------

describe('recording paths', () => {
  // Spread over the real env rather than casting a bare literal: the functions take
  // a full ProcessEnv, and faking one hides the fact that they only read one key.
  const env: NodeJS.ProcessEnv = { ...process.env, RECORDINGS_DIR: '/srv/recordings' }

  it('partitions by site and the month the CALL happened', () => {
    const rel = recordingRelPath({
      siteId: 42,
      retellCallId: 'call_abc',
      startedAt: new Date('2026-03-09T10:00:00Z'),
      // Row written later (a backfill). The path must follow the conversation, not
      // the INSERT, or browsing by month is useless.
      createdAt: new Date('2026-08-01T10:00:00Z'),
    })
    expect(rel).toBe('42/2026-03/call_abc.wav')
  })

  it('falls back to createdAt when the call never reported a start time', () => {
    const rel = recordingRelPath({
      siteId: 42,
      retellCallId: 'call_abc',
      startedAt: null,
      createdAt: new Date('2026-08-01T10:00:00Z'),
    })
    expect(rel).toBe('42/2026-08/call_abc.wav')
  })

  it('files an unattributed call somewhere real rather than under "null"', () => {
    const rel = recordingRelPath({
      siteId: null,
      retellCallId: 'c1',
      createdAt: new Date('2026-03-09T10:00:00Z'),
    })
    expect(rel).toBe('unattributed/2026-03/c1.wav')
  })

  it('sanitises the call id, which reaches the filesystem', () => {
    const rel = recordingRelPath({
      siteId: 1,
      retellCallId: '../../etc/passwd',
      createdAt: new Date('2026-03-09T10:00:00Z'),
    })
    expect(rel).not.toContain('..')
    expect(rel).toBe('1/2026-03/______etc_passwd.wav')
  })

  it('refuses to resolve outside the recordings directory', () => {
    // recording_path is read from the database and used to open a file that is then
    // streamed to an HTTP client. This is the only thing between a bad row and an
    // arbitrary file read.
    expect(resolveRecordingPath('42/2026-03/ok.wav', env)).not.toBeNull()
    expect(resolveRecordingPath('../../../etc/passwd', env)).toBeNull()
    expect(resolveRecordingPath('42/../../../etc/passwd', env)).toBeNull()
    expect(resolveRecordingPath('/etc/passwd', env)).toBeNull()
  })
})

// --- SMS body ----------------------------------------------------------------

describe('composeLeadSms', () => {
  const site = { domain: 'kenoshaair.com', displayName: 'Kenosha Air' } as Site
  const base = {
    name: 'Dana Reyes',
    phone: '+14145550134',
    addressLine: '2405 Sheridan Road',
    city: 'Kenosha',
    zip: '53140',
    problem: 'No heat since last night',
    systemType: 'furnace',
    systemAgeYears: 12,
    isEmergency: null,
    inServiceArea: true,
    isOwner: true,
    appointmentAt: null,
    hazard: null,
  } as unknown as Lead

  it('leads with EMERGENCY and names the hazard', () => {
    const body = composeLeadSms({
      lead: { ...base, isEmergency: true, hazard: 'gas' },
      site,
      domain: site.domain,
    })
    expect(body.split('\n')[0]).toContain('EMERGENCY')
    expect(body.split('\n')[0]).toContain('gas')
  })

  it('states urgency-unknown explicitly rather than omitting it', () => {
    // A message that just left it out would read as routine, which is the failure
    // the nullable column exists to prevent -- carried through to the lock screen.
    const body = composeLeadSms({ lead: base, site, domain: site.domain })
    expect(body.split('\n')[0]).toContain('urgency not established')
  })

  it('flags the two things that waste a truck roll', () => {
    const outside = composeLeadSms({
      lead: { ...base, inServiceArea: false },
      site,
      domain: site.domain,
    })
    expect(outside).toContain('OUTSIDE SERVICE AREA')

    const renter = composeLeadSms({ lead: { ...base, isOwner: false }, site, domain: site.domain })
    expect(renter).toContain('RENTER')
  })

  it('says so when there is no name, instead of a blank line', () => {
    const body = composeLeadSms({ lead: { ...base, name: null }, site, domain: site.domain })
    expect(body).toContain('Name not given')
  })

  it('stays inside one MMS-safe length', () => {
    const body = composeLeadSms({
      lead: { ...base, problem: 'x'.repeat(3000), notes: 'y'.repeat(3000) } as unknown as Lead,
      site,
      domain: site.domain,
    })
    expect(body.length).toBeLessThanOrEqual(1500)
  })
})

describe('composeLeadSms with no domain yet', () => {
  const lead = {
    name: 'Dana Reyes',
    phone: '+15205550134',
    problem: 'No cooling',
    isEmergency: true,
    hazard: null,
    addressLine: null,
    city: null,
    zip: null,
    systemType: null,
    systemAgeYears: null,
    inServiceArea: null,
    isOwner: null,
    appointmentAt: null,
  } as unknown as Lead

  it('never renders "null" as the business label', () => {
    // A cell is targeted before a domain is bought, so both displayName and domain can
    // be absent. The first line is all the contractor sees on a lock screen, and
    // "EMERGENCY - null" is worse than no label at all.
    const bare = { displayName: null, domain: null } as Site
    const body = composeLeadSms({ lead, site: bare, domain: null })
    expect(body).not.toContain('null')
    expect(body).not.toContain('undefined')
    expect(body.split('\n')[0]).toBe('EMERGENCY - your site')
  })

  it('prefers displayName, then domain', () => {
    expect(
      composeLeadSms({
        lead,
        site: { displayName: 'Old Pueblo HVAC', domain: 'x.com' } as Site,
        domain: 'x.com',
      }).split('\n')[0],
    ).toContain('Old Pueblo HVAC')

    expect(
      composeLeadSms({ lead, site: { displayName: null, domain: 'x.com' } as Site, domain: 'x.com' })
        .split('\n')[0],
    ).toContain('x.com')
  })
})
