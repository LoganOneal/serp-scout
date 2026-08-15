import { describe, expect, it } from 'vitest'
import { CAPTURED_AGENT } from './__fixtures__/captured-agent.js'
import { auditAgent, parseAgent, parseRetellLlm } from './agent-audit.js'
import {
  HVAC_INBOUND_DEFAULTS,
  buildCreateAgentPayload,
  buildRetellLlmPayload,
  buildSaveLeadTool,
} from './agent-template.js'
import { AGENT_PROMPT } from './prompt.js'

const BASE = 'https://rank-and-rent-beta.vercel.app'

const ARGS = {
  prompt: AGENT_PROMPT,
  baseUrl: BASE,
  agentName: 'Kenosha Air — Kenosha WI HVAC intake',
  analysisFields: [{ type: 'string', name: 'name', description: "The caller's full name." }],
}

describe('agent creation payloads', () => {
  /**
   * The defaults claim to be copied from the live HVAC agent. This is what stops
   * that claim from quietly becoming false -- an edited constant with a comment
   * still saying "observed, not chosen" is worse than no comment at all.
   */
  it('matches the captured HVAC agent it says it was copied from', () => {
    const a = CAPTURED_AGENT as Record<string, unknown>
    expect(HVAC_INBOUND_DEFAULTS.voiceId).toBe(a['voice_id'])
    expect(HVAC_INBOUND_DEFAULTS.language).toBe(a['language'])
    expect(HVAC_INBOUND_DEFAULTS.voiceSpeed).toBe(a['voice_speed'])
    expect(HVAC_INBOUND_DEFAULTS.volume).toBe(a['volume'])
    expect(HVAC_INBOUND_DEFAULTS.maxCallDurationMs).toBe(a['max_call_duration_ms'])
    expect(HVAC_INBOUND_DEFAULTS.dataStorageSetting).toBe(a['data_storage_setting'])
    expect(HVAC_INBOUND_DEFAULTS.allowUserDtmf).toBe(a['allow_user_dtmf'])
    expect(HVAC_INBOUND_DEFAULTS.postCallAnalysisModel).toBe(a['post_call_analysis_model'])
  })

  it('points save_lead at this app and keeps both speak settings off', () => {
    const tool = buildSaveLeadTool(BASE)
    expect(tool['url']).toBe(`${BASE}/api/retell/tool/save-lead`)
    // Both off because this fires inside the caller's turn -- see the save-lead route.
    expect(tool['speak_during_execution']).toBe(false)
    expect(tool['speak_after_execution']).toBe(false)
  })

  /**
   * The parameter names the model is told to send must be the ones parseLead reads.
   * A mismatch returns `200 saved:true` and stores a lead with every field null,
   * which is exactly the failure FIELD_ALIASES exists to survive.
   */
  it('declares parameters the lead parser recognises', () => {
    const params = buildSaveLeadTool(BASE)['parameters'] as Record<string, unknown>
    const props = params['properties'] as Record<string, unknown>
    for (const field of ['name', 'phone', 'zip', 'problem', 'is_emergency']) {
      expect(props[field]).toBeDefined()
    }
  })

  it('sets the events webhook and analysis fields at creation', () => {
    const payload = buildCreateAgentPayload({ ...ARGS, llmId: 'llm_abc' })
    expect(payload['webhook_url']).toBe(`${BASE}/api/retell/events`)
    expect(payload['post_call_analysis_data']).toEqual(ARGS.analysisFields)
    expect(payload['response_engine']).toEqual({ type: 'retell-llm', llm_id: 'llm_abc' })
  })

  /**
   * The test that matters: an agent built from these payloads passes the audit that
   * judges it. Retell echoes the request fields back on create, so replaying them
   * through the parsers is a faithful stand-in for a live create-then-pull.
   */
  it('produces an agent that passes its own integration audit', () => {
    const llmPayload = buildRetellLlmPayload(ARGS)
    const agentPayload = buildCreateAgentPayload({ ...ARGS, llmId: 'llm_abc' })

    const agent = parseAgent({ ...agentPayload, agent_id: 'agent_xyz', version: 0 })
    const llm = parseRetellLlm({ ...llmPayload, llm_id: 'llm_abc', version: 0 })
    expect(agent).not.toBeNull()
    expect(llm).not.toBeNull()

    const checks = auditAgent({ agent: agent!, flow: null, llm, baseUrl: BASE })
    const failing = checks.filter((c) => c.status === 'fail')
    expect(failing.map((c) => c.id)).toEqual([])
  })

  /**
   * Without the `llm` input the same agent fails save_lead -- the tool is on
   * general_tools, and an audit that only reads flows cannot see it. This pins the
   * reason that argument exists.
   */
  it('would report a phantom missing tool if the llm were not passed', () => {
    const agentPayload = buildCreateAgentPayload({ ...ARGS, llmId: 'llm_abc' })
    const agent = parseAgent({ ...agentPayload, agent_id: 'agent_xyz' })!
    const checks = auditAgent({ agent, flow: null, baseUrl: BASE })
    expect(checks.find((c) => c.id === 'save_lead_tool')!.status).toBe('fail')
  })
})
