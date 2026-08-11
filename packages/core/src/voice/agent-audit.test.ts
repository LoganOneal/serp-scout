import { describe, expect, it } from 'vitest'
import { CAPTURED_AGENT, CAPTURED_FLOW } from './__fixtures__/captured-agent.js'
import {
  auditAgent,
  auditVerdict,
  crmWouldReceiveNothing,
  parseAgent,
  parseFlow,
  SAVE_LEAD_TOOL_NAME,
} from './agent-audit.js'

/**
 * Audited against a REAL captured agent, not an invented one.
 *
 * The fixture is the live "Roger - Old Pueblo Heating and Air Intake" agent as the
 * API actually returned it. That matters because the shape was not what the docs
 * implied: it is a `conversation-flow` engine with no `general_prompt`, no `tools`,
 * and no `webhook_url` key at all -- three absences an invented fixture would have
 * filled in, and the audit exists precisely to catch them.
 */

const BASE = 'https://tunnel.example.com'

describe('parseAgent (real captured payload)', () => {
  it('reads a conversation-flow agent', () => {
    const agent = parseAgent(CAPTURED_AGENT)
    expect(agent).not.toBeNull()
    expect(agent!.agentId).toBe('agent_57f4e0346389a82e7b699a4fbf')
    expect(agent!.responseEngineType).toBe('conversation-flow')
    expect(agent!.conversationFlowId).toBe('conversation_flow_669c8b0c2a05')
    // No single prompt exists on this engine, so there is no llm id either.
    expect(agent!.llmId).toBeNull()
    expect(agent!.voiceId).toBe('11labs-Gilfoy')
  })

  it('reports the three absences as nulls/empties rather than defaults', () => {
    const agent = parseAgent(CAPTURED_AGENT)!
    expect(agent.webhookUrl).toBeNull()
    expect(agent.postCallAnalysisFields).toEqual([])
    expect(agent.isPublished).toBe(false)
  })

  it('rejects junk without throwing', () => {
    for (const junk of [null, undefined, 'x', 42, [], {}, { agent_name: 'no id' }]) {
      expect(parseAgent(junk)).toBeNull()
    }
  })
})

describe('parseFlow', () => {
  it('reads structure, not script', () => {
    const flow = parseFlow(CAPTURED_FLOW)!
    expect(flow.conversationFlowId).toBe('conversation_flow_669c8b0c2a05')
    expect(flow.nodeCount).toBe(14)
    expect(flow.nodeNames).toContain('Safety Check')
    expect(flow.nodeNames).toContain('Collect Contact Info')
    expect(flow.toolNames).toEqual([])
    expect(flow.modelChoice).toBe('gpt-4.1')
  })

  it('rejects junk', () => {
    expect(parseFlow(null)).toBeNull()
    expect(parseFlow({ nodes: [] })).toBeNull()
  })
})

describe('auditAgent', () => {
  const agent = parseAgent(CAPTURED_AGENT)!
  const flow = parseFlow(CAPTURED_FLOW)!

  it('fails the webhook check, and says the CRM would see nothing', () => {
    // The single most important thing this audit does. Without a webhook URL, calls
    // happen and no row ever appears -- indistinguishable from "nobody called".
    const checks = auditAgent({ agent, flow, baseUrl: BASE })
    const webhook = checks.find((c) => c.id === 'webhook_url')!
    expect(webhook.status).toBe('fail')
    expect(webhook.remedy).toContain(`${BASE}/api/retell/events`)
    expect(webhook.autoFixable).toBe(true)
    expect(crmWouldReceiveNothing(checks)).toBe(true)
  })

  it('fails save_lead and refuses to call it auto-fixable', () => {
    const checks = auditAgent({ agent, flow, baseUrl: BASE })
    const tool = checks.find((c) => c.id === 'save_lead_tool')!
    expect(tool.status).toBe('fail')
    expect(tool.detail).toContain('no custom functions at all')
    // A tool has to be wired into specific flow nodes to ever fire. Guessing which
    // ones would either do nothing or corrupt a 14-node conversation, so this is a
    // human decision and the audit must not pretend otherwise.
    expect(tool.autoFixable).toBe(false)
    expect(tool.remedy).toContain('speak-during and speak-after both OFF')
  })

  it('warns rather than fails on analysis fields, which are only backfill', () => {
    const checks = auditAgent({ agent, flow, baseUrl: BASE })
    expect(checks.find((c) => c.id === 'analysis_fields')!.status).toBe('warn')
  })

  it('passes recording retention because this agent stores everything', () => {
    // data_storage_setting "everything" means no 10-minute link race.
    const checks = auditAgent({ agent, flow, baseUrl: BASE })
    expect(checks.find((c) => c.id === 'recording_retention')!.status).toBe('pass')
  })

  it('flags the PII opt-out as a worker-uptime requirement', () => {
    const optedOut = { ...agent, dataStorageSetting: 'everything_except_pii' }
    const checks = auditAgent({ agent: optedOut, flow, baseUrl: BASE })
    const check = checks.find((c) => c.id === 'recording_retention')!
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('TEN MINUTES')
    expect(check.remedy).toContain('worker')
  })

  it('warns that an unpublished version may not serve calls', () => {
    const checks = auditAgent({ agent, flow, baseUrl: BASE })
    expect(checks.find((c) => c.id === 'published')!.status).toBe('warn')
  })

  it('goes green once the integration is actually wired', () => {
    const fixed = {
      ...agent,
      webhookUrl: `${BASE}/api/retell/events`,
      postCallAnalysisFields: ['name', 'phone', 'zip', 'problem', 'is_emergency'],
      isPublished: true,
    }
    const wiredFlow = {
      ...flow,
      toolNames: [SAVE_LEAD_TOOL_NAME],
      toolUrls: [`${BASE}/api/retell/tool/save-lead`],
    }
    const checks = auditAgent({ agent: fixed, flow: wiredFlow, baseUrl: BASE })
    expect(checks.every((c) => c.status === 'pass')).toBe(true)
    expect(auditVerdict(checks)).toBe('pass')
    expect(crmWouldReceiveNothing(checks)).toBe(false)
  })

  it('catches a webhook pointing at someone else, not just a missing one', () => {
    // The failure mode after moving tunnels: the URL is set, and stale.
    const stale = { ...agent, webhookUrl: 'https://old-tunnel.ngrok.app/api/retell/events' }
    const checks = auditAgent({ agent: stale, flow, baseUrl: BASE })
    const webhook = checks.find((c) => c.id === 'webhook_url')!
    expect(webhook.status).toBe('fail')
    expect(webhook.detail).toContain('not at this app')
  })

  it('says "unknown", not "pass", when PUBLIC_BASE_URL is unset', () => {
    const withUrl = { ...agent, webhookUrl: 'https://something/api/retell/events' }
    const checks = auditAgent({ agent: withUrl, flow, baseUrl: null })
    expect(checks.find((c) => c.id === 'webhook_url')!.status).toBe('unknown')
    expect(auditVerdict(checks)).not.toBe('pass')
  })

  it('gives every failing check a remedy', () => {
    // A red row with no next step is a dead button with extra steps.
    const checks = auditAgent({ agent, flow, baseUrl: BASE })
    for (const c of checks.filter((x) => x.status === 'fail' || x.status === 'warn')) {
      expect(c.remedy, c.id).toBeTruthy()
    }
  })

  it('handles a retell-llm agent with no flow at all', () => {
    const llmAgent = {
      ...agent,
      responseEngineType: 'retell-llm' as const,
      conversationFlowId: null,
      llmId: 'llm_abc',
    }
    const checks = auditAgent({ agent: llmAgent, flow: null, baseUrl: BASE })
    // Must not throw, and must still report the missing tool.
    expect(checks.find((c) => c.id === 'save_lead_tool')!.status).toBe('fail')
  })
})
