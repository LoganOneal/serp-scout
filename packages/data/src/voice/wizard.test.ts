import { describe, expect, it } from 'vitest'
import type { AgentCheck } from '@rnr/core'
import { deriveWizardState, type WizardInput } from './wizard.js'

const pass = (id: string, label: string): AgentCheck => ({
  id,
  label,
  status: 'pass',
  detail: 'ok',
  remedy: null,
  autoFixable: false,
})
const fail = (id: string, label: string): AgentCheck => ({
  id,
  label,
  status: 'fail',
  detail: 'not set',
  remedy: 'set it',
  autoFixable: true,
})

const ALL_PASS = [
  pass('webhook_url', 'Agent webhook URL'),
  pass('save_lead_tool', 'save_lead custom function'),
  pass('analysis_fields', 'Post-call analysis fields'),
]

const base: WizardInput = {
  siteId: 1,
  retellAgentId: null,
  agentName: null,
  responseEngineType: null,
  trackingNumber: null,
  retellNumberImportedAt: null,
  firstWebhookAt: null,
  firstRealCallAt: null,
  checks: null,
  baseUrl: 'https://x.test',
}

const step = (input: WizardInput, id: string) =>
  deriveWizardState(input).steps.find((s) => s.id === id)!

describe('wizard derivation', () => {
  it('starts a fresh site at the pick step', () => {
    const state = deriveWizardState(base)
    expect(state.currentStepId).toBe('pick')
    expect(state.complete).toBe(false)
  })

  it('advances as state changes, with nothing remembered', () => {
    const bound: WizardInput = { ...base, retellAgentId: 'agent_x', checks: ALL_PASS }
    expect(deriveWizardState(bound).currentStepId).toBe('number')
  })

  /**
   * The property that makes a derived wizard better than a stored cursor: undo an
   * earlier step and the wizard goes back by itself. A `wizard_step` column would keep
   * claiming the later step was reached.
   */
  it('goes backwards when a completed step is undone', () => {
    const done: WizardInput = {
      ...base,
      retellAgentId: 'agent_x',
      checks: ALL_PASS,
      trackingNumber: '+15551234567',
      retellNumberImportedAt: new Date(),
      firstRealCallAt: new Date(),
    }
    expect(deriveWizardState(done).complete).toBe(true)

    const unbound = { ...done, retellAgentId: null }
    expect(deriveWizardState(unbound).currentStepId).toBe('pick')
  })

  it('sends you to the fix step when the webhook is not set', () => {
    const input: WizardInput = {
      ...base,
      retellAgentId: 'agent_x',
      checks: [fail('webhook_url', 'Agent webhook URL'), pass('save_lead_tool', 'save_lead')],
    }
    expect(deriveWizardState(input).currentStepId).toBe('fix')
  })

  it('skips save_lead wiring for a single-prompt agent rather than showing a dead step', () => {
    const input: WizardInput = {
      ...base,
      retellAgentId: 'agent_x',
      responseEngineType: 'retell-llm',
      checks: ALL_PASS,
    }
    expect(step(input, 'save_lead').status).toBe('skipped')
    // ...and still requires it for a flow, where it must be attached to nodes by hand.
    expect(step({ ...input, responseEngineType: 'conversation-flow' }, 'save_lead').status).toBe(
      'done',
    )
  })

  /**
   * The San Jose failure, pinned. The number was recorded on the site and never
   * imported, and a fixture had set first_webhook_at -- so every screen said connected
   * while a real call hung up immediately.
   */
  it('does not call a recorded-but-unimported number provisioned', () => {
    const input: WizardInput = {
      ...base,
      retellAgentId: 'agent_x',
      checks: ALL_PASS,
      trackingNumber: '+16693695287',
      retellNumberImportedAt: null,
    }
    const number = step(input, 'number')
    expect(number.status).toBe('current')
    expect(number.detail).toMatch(/NEVER attached/i)
  })

  it('does not accept a test event as proof the phone works', () => {
    const input: WizardInput = {
      ...base,
      retellAgentId: 'agent_x',
      checks: ALL_PASS,
      trackingNumber: '+16693695287',
      retellNumberImportedAt: new Date(),
      // A fixture arrived, but no real call did.
      firstWebhookAt: new Date(),
      firstRealCallAt: null,
    }
    const prove = step(input, 'prove')
    expect(prove.status).toBe('current')
    expect(prove.detail).toMatch(/no real call/i)
    expect(deriveWizardState(input).complete).toBe(false)
  })

  it('is complete only once a real call has landed', () => {
    const input: WizardInput = {
      ...base,
      retellAgentId: 'agent_x',
      checks: ALL_PASS,
      trackingNumber: '+16693695287',
      retellNumberImportedAt: new Date(),
      firstWebhookAt: new Date(),
      firstRealCallAt: new Date(),
    }
    expect(deriveWizardState(input).complete).toBe(true)
    expect(deriveWizardState(input).currentStepId).toBeNull()
  })
})
