import { describe, expect, it } from 'vitest'
import { buildSaveLeadTool } from './agent-template.js'
import { parseSaveLeadArgs, jobTypesForNiche } from './lead.js'
import { PLUMBING_PROMPT, hasNicheScript, scriptForNiche } from './niche-scripts.js'
import { AGENT_PROMPT, referencedVariables } from './prompt.js'
import { triage } from './triage.js'

describe('plumbing script', () => {
  it('is used for the plumber niche and not for one without a script', () => {
    expect(scriptForNiche('plumber')).toBe(PLUMBING_PROMPT)
    expect(hasNicheScript('plumber')).toBe(true)
    // Falls back rather than throwing, but the UI says so before you click create.
    expect(scriptForNiche('roofing')).toBe(AGENT_PROMPT)
    expect(hasNicheScript('roofing')).toBe(false)
  })

  /**
   * The supplied script ended with "produce a structured summary", which is post-call
   * work. Without an instruction to call save_lead mid-conversation, a caller who
   * hangs up after giving a name and a problem leaves nothing at all.
   */
  it('tells the agent to call save_lead during the call', () => {
    expect(PLUMBING_PROMPT).toContain('save_lead')
    expect(PLUMBING_PROMPT).toMatch(/Do not wait until the end of the call/i)
  })

  /**
   * "[Company Name]" is not a Retell variable. Left in, the agent says the words
   * "Company Name" to every caller.
   */
  it('uses dynamic variables, not square-bracket placeholders', () => {
    expect(PLUMBING_PROMPT).toContain('{{business_name}}')
    const placeholders = PLUMBING_PROMPT.match(/\[[A-Z][a-z]+ [A-Z][a-z]+\]/g)
    expect(placeholders).toBeNull()
  })

  it('only references variables the inbound webhook actually supplies', () => {
    const supplied = new Set(referencedVariables(AGENT_PROMPT))
    for (const v of referencedVariables(PLUMBING_PROMPT)) {
      expect(supplied.has(v), `{{${v}}} has no value from buildDynamicVariables`).toBe(true)
    }
  })
})

describe('per-trade job types', () => {
  it('offers a plumbing agent plumbing categories, not thermostats', () => {
    const plumbing = jobTypesForNiche('plumber')
    expect(plumbing).toContain('drain_clog')
    expect(plumbing).toContain('sewer_backup')
    expect(plumbing).not.toContain('thermostat')
    expect(jobTypesForNiche('hvac-repair')).toContain('thermostat')
  })

  it('narrows the enum on the tool handed to the agent', () => {
    const tool = buildSaveLeadTool('https://x.test', 'plumber')
    const params = tool['parameters'] as Record<string, unknown>
    const props = params['properties'] as Record<string, Record<string, unknown>>
    expect(props['system_type']!['enum']).toContain('toilet')
    expect(props['system_type']!['enum']).not.toContain('furnace')
  })

  /**
   * The furnace pattern matched the substring "heater", so every water heater was
   * filed as a furnace before it could reach its own branch. Harmless-looking on an
   * HVAC line; wrong on a large share of plumbing calls.
   */
  it('does not file a water heater as a furnace', () => {
    expect(parseSaveLeadArgs({ system_type: 'water heater' }).systemType).toBe('water_heater')
    expect(parseSaveLeadArgs({ system_type: 'tankless water heater' }).systemType).toBe('water_heater')
    // The HVAC mapping still works.
    expect(parseSaveLeadArgs({ system_type: 'furnace' }).systemType).toBe('furnace')
    expect(parseSaveLeadArgs({ system_type: 'space heater' }).systemType).toBe('furnace')
  })

  it('maps plumbing wording the model actually uses', () => {
    expect(parseSaveLeadArgs({ system_type: 'clogged kitchen drain' }).systemType).toBe('drain_clog')
    expect(parseSaveLeadArgs({ system_type: 'sewer backing up' }).systemType).toBe('sewer_backup')
    expect(parseSaveLeadArgs({ system_type: 'running toilet' }).systemType).toBe('toilet')
    expect(parseSaveLeadArgs({ system_type: 'garbage disposal' }).systemType).toBe('garbage_disposal')
    expect(parseSaveLeadArgs({ system_type: 'burst pipe' }).systemType).toBe('leak_burst_pipe')
  })
})

describe('plumbing hazards', () => {
  it('escalates sewage entering the property', () => {
    const t = triage('there is sewage coming up through the shower drain')
    expect(t.hazard).toBe('sewage')
    expect(t.action).toBe('escalate_now')
  })

  /**
   * The guard that keeps the on-call plumber's phone quiet: a sewer line mentioned in
   * a quote request is not an emergency, and treating every mention of the word as one
   * makes the escalation worthless.
   */
  it('does not escalate a sewer line mentioned in an estimate request', () => {
    const t = triage('I want a quote to replace my sewer line next month')
    expect(t.hazard).not.toBe('sewage')
    expect(t.action).toBe('normal')
  })

  it('treats water reaching electrical equipment as life safety', () => {
    const t = triage('water is dripping onto the electrical panel in the basement')
    expect(t.hazard).toBe('water_electrical')
    expect(t.lifeSafety).toBe(true)
  })

  it('still ranks a gas smell above every plumbing hazard', () => {
    const t = triage('water is pouring onto the breaker box and I smell gas')
    expect(t.hazard).toBe('gas')
    expect(t.action).toBe('evacuate_and_escalate')
  })
})
