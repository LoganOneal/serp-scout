import { describe, expect, it } from 'vitest'
import { describeHours, localNow, openStateAt, speakClock, DEFAULT_HOURS } from './hours.js'
import {
  formatPhone,
  inServiceArea,
  normalizeDomain,
  normalizeZip,
  speakPhone,
  speakUsdFromMicros,
  toE164,
} from './normalize.js'
import { isEmergencyFrom, safetyScriptFor, triage } from './triage.js'
import { parseSaveLeadArgs, qualifyLead, triBool } from './lead.js'
import {
  AGENT_PROMPT,
  buildDynamicVariables,
  FALLBACK_VARIABLES,
  referencedVariables,
  type SiteVoiceContext,
} from './prompt.js'

// --- normalize ---------------------------------------------------------------

describe('normalizeDomain', () => {
  it('strips scheme, www, path, port and trailing dot', () => {
    for (const input of [
      'https://www.KenoshaAir.com/',
      'http://kenoshaair.com',
      'KENOSHAAIR.COM.',
      'www.kenoshaair.com:443/contact?x=1',
      '  kenoshaair.com  ',
    ]) {
      expect(normalizeDomain(input)).toBe('kenoshaair.com')
    }
  })

  it('returns null rather than guessing, because domain is UNIQUE', () => {
    // A normaliser that accepts garbage creates rows nothing can match again.
    for (const bad of ['', '   ', 'localhost', 'no-tld', '.com', 'a..b.com', '-bad.com', 'bad-.com', 'foo.123']) {
      expect(normalizeDomain(bad), bad).toBeNull()
    }
  })
})

describe('toE164', () => {
  it('accepts the shapes a human and Twilio each produce', () => {
    for (const input of ['4145550134', '(414) 555-0134', '414.555.0134', '1-414-555-0134', '+14145550134']) {
      expect(toE164(input), input).toBe('+14145550134')
    }
  })

  it('rejects invalid NANP area codes rather than dialling somewhere wrong', () => {
    expect(toE164('0145550134')).toBeNull()
    expect(toE164('1145550134')).toBeNull()
    expect(toE164('555')).toBeNull()
    expect(toE164('')).toBeNull()
  })

  it('formats and speaks', () => {
    expect(formatPhone('+14145550134')).toBe('(414) 555-0134')
    // Digits, grouped. A bare 10-digit string is read by TTS as one huge number,
    // which is the most common way a phone agent gives itself away.
    expect(speakPhone('+14145550134')).toBe('4 1 4, 5 5 5, 0 1 3 4')
    expect(formatPhone(null)).toBeNull()
  })
})

describe('inServiceArea', () => {
  it('returns null when unconfigured or unparseable, never false', () => {
    // The whole reason leads.in_service_area is nullable: "we never checked" must
    // not read as "outside the area", which would decline a bookable customer.
    expect(inServiceArea('53140', null)).toBeNull()
    expect(inServiceArea('53140', [])).toBeNull()
    expect(inServiceArea(null, ['53140'])).toBeNull()
    expect(inServiceArea('not a zip', ['53140'])).toBeNull()
  })

  it('matches through ZIP+4', () => {
    expect(inServiceArea('53140-1234', ['53140'])).toBe(true)
    expect(inServiceArea('53142', ['53140', '53141'])).toBe(false)
  })

  it('normalizeZip truncates to five', () => {
    expect(normalizeZip('53140-1234')).toBe('53140')
    expect(normalizeZip('abc')).toBeNull()
  })
})

describe('speakUsdFromMicros', () => {
  it('produces words, not a currency symbol', () => {
    expect(speakUsdFromMicros(89_000_000n)).toBe('89 dollars')
    expect(speakUsdFromMicros(1_000_000n)).toBe('1 dollar')
    expect(speakUsdFromMicros(89_500_000n)).toBe('89 dollars and 50 cents')
    expect(speakUsdFromMicros(null)).toBeNull()
  })
})

// --- hours -------------------------------------------------------------------

describe('hours', () => {
  it('speaks clock times TTS can read', () => {
    expect(speakClock('08:00')).toBe('8 AM')
    expect(speakClock('17:00')).toBe('5 PM')
    expect(speakClock('17:30')).toBe('5:30 PM')
    expect(speakClock('00:00')).toBe('12 AM')
    expect(speakClock('12:00')).toBe('12 PM')
  })

  it('resolves local time in the site timezone, not the process timezone', () => {
    // 2026-01-15T18:30:00Z is 12:30 in Chicago (CST, UTC-6).
    const now = localNow('America/Chicago', new Date('2026-01-15T18:30:00Z'))
    expect(now).not.toBeNull()
    expect(now!.weekday).toBe('thu')
    expect(now!.clock).toBe('12:30')
  })

  it('handles DST without offset arithmetic', () => {
    // July: Chicago is CDT (UTC-5), so 18:30Z is 13:30 local, not 12:30.
    const summer = localNow('America/Chicago', new Date('2026-07-15T18:30:00Z'))
    expect(summer!.clock).toBe('13:30')
  })

  it('returns null for an unknown timezone rather than defaulting to UTC', () => {
    expect(localNow('Mars/Olympus')).toBeNull()
    // ...and that propagates as 'unknown', not as 'closed'.
    expect(openStateAt(DEFAULT_HOURS, 'Mars/Olympus')).toBe('unknown')
  })

  it('distinguishes unknown from closed', () => {
    const thuNoon = new Date('2026-01-15T18:30:00Z')
    const sunNoon = new Date('2026-01-18T18:30:00Z')
    const thu3am = new Date('2026-01-15T09:00:00Z')

    expect(openStateAt(DEFAULT_HOURS, 'America/Chicago', thuNoon)).toBe('open')
    // Sunday is explicitly null in DEFAULT_HOURS -> closed, a real answer.
    expect(openStateAt(DEFAULT_HOURS, 'America/Chicago', sunNoon)).toBe('closed')
    expect(openStateAt(DEFAULT_HOURS, 'America/Chicago', thu3am)).toBe('closed')
    // No hours configured is NOT "closed" -- the agent says different things.
    expect(openStateAt(null, 'America/Chicago', thuNoon)).toBe('unknown')
    expect(openStateAt({}, 'America/Chicago', thuNoon)).toBe('unknown')
  })

  it('groups contiguous identical days for speech', () => {
    expect(describeHours(DEFAULT_HOURS)).toBe(
      'Monday through Friday 8 AM to 5 PM, Saturday 9 AM to 1 PM',
    )
    expect(describeHours({ wed: { open: '08:00', close: '17:00' } })).toBe('Wednesday 8 AM to 5 PM')
    expect(describeHours(null)).toBeNull()
    expect(describeHours({ sun: null })).toBeNull()
  })
})

// --- triage ------------------------------------------------------------------

describe('triage', () => {
  it('catches gas in real phrasings, mid-sentence', () => {
    for (const utterance of [
      'I smell gas',
      // Filler between verb and noun. The substring version of this matcher
      // missed exactly this sentence, which is why the patterns are regexes.
      "it's, uh, smelling like gas in the basement",
      'smells kind of like gas in here',
      'there is a gas leak I think',
      'I think the gas is leaking',
      'smells like rotten eggs down here',
      'my thermostat is broken and also I smell gas',
      'theres a strong odor of gas',
      'I smell propane',
    ]) {
      const t = triage(utterance)
      expect(t.hazard, utterance).toBe('gas')
      expect(t.action).toBe('evacuate_and_escalate')
      expect(t.lifeSafety).toBe(true)
    }
  })

  it('catches burning and smoke with filler between the words', () => {
    for (const utterance of [
      'I smell something burning',
      'theres a burning smell coming from the vents',
      'it smells kind of electrical',
      'I see smoke coming from the furnace',
      'the wires look melted',
    ]) {
      expect(triage(utterance).hazard, utterance).toBe('fire_electrical')
    }
  })

  it('does NOT fire on ordinary HVAC vocabulary', () => {
    // Single-token matching on "gas" would make every gas-furnace call an
    // evacuation, and an unbounded gap would fire on the negated sentences here.
    for (const benign of [
      'my gas furnace is making a noise',
      'I have a gas furnace and a heat pump',
      'I need a quote on a new air conditioner',
      'can someone come do the annual maintenance',
      'I want to ask about a gas line for a new stove',
      'the thermostat batteries are dead',
    ]) {
      const t = triage(benign)
      expect(t.hazard, benign).toBeNull()
      expect(t.action, benign).toBe('normal')
    }
  })

  it('treats CO and the caller-mangled "co2 alarm" as carbon monoxide', () => {
    expect(triage('the carbon monoxide detector went off').hazard).toBe('carbon_monoxide')
    expect(triage('my co2 alarm is beeping').hazard).toBe('carbon_monoxide')
  })

  it('picks the worst hazard when several fire', () => {
    const t = triage('no heat at all, and I smell gas')
    expect(t.hazard).toBe('gas')
    expect(t.matches.length).toBeGreaterThan(1)
    expect(t.matches.map((m) => m.kind)).toContain('no_heat')
  })

  it('classifies no-heat and no-cool as urgent but bookable', () => {
    expect(triage('we have no heat').action).toBe('book_urgent')
    expect(triage('the ac stopped working').action).toBe('book_urgent')
    expect(triage('no a c and it is 95 degrees').action).toBe('book_urgent')
  })

  it('gives a real safety script for every life-safety hazard', () => {
    for (const h of ['gas', 'carbon_monoxide', 'fire_electrical'] as const) {
      const script = safetyScriptFor(h)
      expect(script, h).toBeTruthy()
      expect(script!.length).toBeGreaterThan(80)
      expect(script).toMatch(/911|utility/)
    }
    expect(safetyScriptFor('no_heat')).toBeNull()
    expect(safetyScriptFor(null)).toBeNull()
  })

  it('isEmergencyFrom returns null for no evidence, not false', () => {
    // Nothing to judge is not "routine". This is why the column is nullable.
    expect(isEmergencyFrom(null)).toBeNull()
    expect(isEmergencyFrom('')).toBeNull()
    expect(isEmergencyFrom('   ')).toBeNull()
    expect(isEmergencyFrom('I want a maintenance quote')).toBe(false)
    expect(isEmergencyFrom('no heat since last night')).toBe(true)
  })
})

// --- lead parsing ------------------------------------------------------------

describe('triBool', () => {
  it('maps only clear yes/no, everything else to null', () => {
    for (const yes of [true, 'true', 'yes', 'Y', '1', 'owner']) expect(triBool(yes), String(yes)).toBe(true)
    for (const no of [false, 'false', 'no', 'N', '0', 'renter']) expect(triBool(no), String(no)).toBe(false)
    // The critical set: none of these may become `false`.
    for (const unknown of ['unknown', 'maybe', 'didn\'t ask', '', null, undefined, 'probably', 2, {}]) {
      expect(triBool(unknown), JSON.stringify(unknown)).toBeNull()
    }
  })
})

describe('parseSaveLeadArgs', () => {
  it('normalises what an LLM actually sends', () => {
    const p = parseSaveLeadArgs({
      name: '  Dana Reyes ',
      phone: '(414) 555-0134',
      email: 'dana at example dot com',
      zip: '53140-1234',
      system_type: 'gas furnace',
      system_age_years: 'about 15 years',
      is_owner: 'yes',
      is_emergency: 'unknown',
    })
    expect(p.name).toBe('Dana Reyes')
    expect(p.phone).toBe('+14145550134')
    expect(p.email).toBe('dana@example.com')
    expect(p.zip).toBe('53140')
    expect(p.systemType).toBe('furnace')
    expect(p.systemAgeYears).toBe(15)
    expect(p.isOwner).toBe(true)
    // The one that matters most.
    expect(p.isEmergency).toBeNull()
  })

  it('treats model placeholder strings as absent', () => {
    const p = parseSaveLeadArgs({ name: 'N/A', problem: 'unknown', city: 'not provided' })
    expect(p.name).toBeNull()
    expect(p.problem).toBeNull()
    expect(p.city).toBeNull()
    expect(p.captured).toEqual([])
  })

  it('records captured fields separately from values', () => {
    const p = parseSaveLeadArgs({ name: 'Dana', phone: '4145550134' })
    expect(p.captured).toEqual(['name', 'phone'])
    // Absent fields are not "captured with a null value".
    expect(p.captured).not.toContain('zip')
  })

  it('rejects a hallucinated appointment a year out', () => {
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString()
    expect(parseSaveLeadArgs({ appointment_at: far }).appointmentAt).toBeNull()
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString()
    expect(parseSaveLeadArgs({ appointment_at: soon }).appointmentAt).not.toBeNull()
  })

  it('survives garbage without throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, [], { phone: {} }]) {
      expect(() => parseSaveLeadArgs(junk)).not.toThrow()
    }
  })

  it('accepts the field names a real Retell flow actually sent', () => {
    // Captured from the live "Roger - Old Pueblo Heating and Air Intake" flow. With
    // strict names these five produced a lead with EVERY field null while the
    // endpoint answered 200 saved:true -- a silent failure whose only symptom was a
    // dashboard of empty rows.
    const p = parseSaveLeadArgs({
      caller_name: 'Dana Reyes',
      callback_number: '(520) 555-0134',
      problem_description: 'No cooling since yesterday',
      service_address: '2405 E Speedway Blvd, Tucson AZ 85719',
      homeowner_status: 'owner',
    })
    expect(p.name).toBe('Dana Reyes')
    expect(p.phone).toBe('+15205550134')
    expect(p.problem).toBe('No cooling since yesterday')
    expect(p.addressLine).toContain('Speedway')
    expect(p.isOwner).toBe(true)
    // The zip is pulled out of the single address string, so the service-area check
    // works instead of staying null forever.
    expect(p.zip).toBe('85719')
    expect(p.captured).toContain('name')
    expect(p.captured).toContain('phone')
  })

  it('is insensitive to case and separators in field names', () => {
    const p = parseSaveLeadArgs({ CallerName: 'Dana', 'callback-number': '5205550134' })
    expect(p.name).toBe('Dana')
    expect(p.phone).toBe('+15205550134')
  })

  it('still prefers the canonical name when both are present', () => {
    const p = parseSaveLeadArgs({ name: 'Canonical', caller_name: 'Alias' })
    expect(p.name).toBe('Canonical')
  })

  it('does not invent a zip when the address has none', () => {
    const p = parseSaveLeadArgs({ service_address: 'Speedway and Campbell, Tucson' })
    expect(p.zip).toBeNull()
  })
})

describe('qualifyLead', () => {
  const base = { name: null, phone: null, problem: null, inServiceArea: null, isOwner: null }

  it('is null when the call never got far enough -- not false', () => {
    // false would read as "we looked at this and rejected it".
    expect(qualifyLead(base)).toBeNull()
    expect(qualifyLead({ ...base, name: 'Dana' })).toBeNull()
  })

  it('is false only for definite disqualifiers', () => {
    expect(qualifyLead({ ...base, name: 'Dana', problem: 'no heat', phone: null })).toBe(false)
    expect(qualifyLead({ ...base, name: 'D', phone: '+1', problem: 'x', inServiceArea: false })).toBe(false)
    expect(qualifyLead({ ...base, name: 'D', phone: '+1', problem: 'x', isOwner: false })).toBe(false)
  })

  it('is true with contact plus a problem', () => {
    expect(qualifyLead({ name: 'Dana', phone: '+14145550134', problem: 'no heat', inServiceArea: true, isOwner: true })).toBe(true)
    // Unknown owner/area does not block.
    expect(qualifyLead({ ...base, name: 'Dana', phone: '+14145550134', problem: 'no heat' })).toBe(true)
  })
})

// --- prompt ------------------------------------------------------------------

describe('prompt', () => {
  const site: SiteVoiceContext = {
    siteId: 1,
    domain: 'kenoshaair.com',
    displayName: 'Kenosha Air',
    localityName: 'Kenosha',
    stateCode: 'WI',
    nicheLabel: 'HVAC',
    timezone: 'America/Chicago',
    hours: DEFAULT_HOURS,
    serviceAreaZips: ['53140', '53142'],
    dispatchFeeMicros: 89_000_000n,
    onCallNumber: '+14145550199',
  }

  it('builds every variable the prompt references', () => {
    const vars = buildDynamicVariables(site, new Date('2026-01-15T18:30:00Z'))
    // The completeness check: nothing in the prompt may be unsupplied, or the
    // agent says the braces out loud.
    for (const name of referencedVariables(AGENT_PROMPT)) {
      expect(vars, `prompt references {{${name}}}`).toHaveProperty(name)
      expect(typeof vars[name]).toBe('string')
    }
  })

  it('renders speakable values, not raw ones', () => {
    const vars = buildDynamicVariables(site, new Date('2026-01-15T18:30:00Z'))
    expect(vars.dispatch_fee).toBe('89 dollars')
    expect(vars.open_state).toBe('open')
    expect(vars.hours).toContain('8 AM to 5 PM')
    expect(vars.can_transfer).toBe('yes')
  })

  it('falls back to speakable neutrals when the site is bare', () => {
    const bare = buildDynamicVariables({
      ...site,
      displayName: null,
      hours: null,
      serviceAreaZips: null,
      dispatchFeeMicros: null,
      onCallNumber: null,
    })
    expect(bare.business_name).toBe('our office')
    expect(bare.hours).toBe('normal business hours')
    expect(bare.has_dispatch_fee).toBe('no')
    expect(bare.can_transfer).toBe('no')
    // No fallback may be empty except the genuinely optional ones -- an empty
    // string in mid-sentence is a stutter the caller hears.
    for (const key of ['business_name', 'city', 'niche', 'hours', 'service_area'] as const) {
      expect(bare[key], key).not.toBe('')
      expect(FALLBACK_VARIABLES[key]).not.toBe('')
    }
  })

  it('embeds the safety scripts verbatim so both paths say the same words', () => {
    expect(AGENT_PROMPT).toContain('leave the building now')
    expect(AGENT_PROMPT).toContain('carbon monoxide')
    expect(AGENT_PROMPT).toMatch(/never say|Never say/)
  })
})
