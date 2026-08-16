import 'server-only'
import type { AgentCheck } from '@rnr/core'
import type { Database } from '../db.js'
import { getSiteById } from '../sites.js'
import { auditStored, getStoredAgent, publicBaseUrl } from './agents.js'

/**
 * Where a site is in voice setup, derived entirely from stored state.
 *
 * ==================== DERIVED, NEVER REMEMBERED ====================
 * No `wizard_step` column and no client-side cursor. Every step's status is recomputed
 * from what is actually true -- the site row, the last agent snapshot, whether a real
 * call has landed -- so closing the tab loses nothing, and a step that was completed
 * and then UNDONE (an agent unbound, a number released) goes back to incomplete by
 * itself. A remembered step would keep claiming success.
 * =================================================================
 */

export type StepStatus = 'done' | 'current' | 'blocked' | 'todo' | 'skipped'

export interface WizardStep {
  id: 'pick' | 'audit' | 'fix' | 'save_lead' | 'bind' | 'number' | 'prove'
  title: string
  status: StepStatus
  /** What is true right now. */
  detail: string
  /** What to do about it. Null when there is nothing to do. */
  action: string | null
}

export interface WizardState {
  siteId: number
  agentId: string | null
  agentName: string | null
  responseEngineType: string | null
  checks: AgentCheck[] | null
  steps: WizardStep[]
  /** The first step that is not done. NULL when setup is complete. */
  currentStepId: WizardStep['id'] | null
  complete: boolean
}

/** Everything the derivation needs. Plain data, so it is testable without a database. */
export interface WizardInput {
  siteId: number
  retellAgentId: string | null
  agentName: string | null
  responseEngineType: string | null
  trackingNumber: string | null
  retellNumberImportedAt: Date | null
  firstWebhookAt: Date | null
  /** From a call this system did NOT generate. See schema: sites.first_real_call_at. */
  firstRealCallAt: Date | null
  checks: AgentCheck[] | null
  baseUrl: string | null
}

export async function loadWizardState(db: Database, siteId: number): Promise<WizardState> {
  const site = await getSiteById(db, siteId)
  if (site === null) throw new Error(`No site #${siteId}.`)

  const stored = site.retellAgentId === null ? null : await getStoredAgent(db, site.retellAgentId)

  return deriveWizardState({
    siteId,
    retellAgentId: site.retellAgentId,
    agentName: stored?.agentName ?? null,
    responseEngineType: stored?.responseEngineType ?? null,
    trackingNumber: site.trackingNumber,
    retellNumberImportedAt: site.retellNumberImportedAt,
    firstWebhookAt: site.firstWebhookAt,
    firstRealCallAt: site.firstRealCallAt,
    checks: stored === null ? null : auditStored(stored),
    baseUrl: publicBaseUrl(),
  })
}

export function deriveWizardState(input: WizardInput): WizardState {
  const { checks, siteId } = input
  const check = (id: string): AgentCheck | undefined => checks?.find((c) => c.id === id)

  const site = {
    retellAgentId: input.retellAgentId,
    trackingNumber: input.trackingNumber,
    retellNumberImportedAt: input.retellNumberImportedAt,
    firstWebhookAt: input.firstWebhookAt,
    firstRealCallAt: input.firstRealCallAt,
  }
  const stored = { agentName: input.agentName, responseEngineType: input.responseEngineType }

  const bound = site.retellAgentId !== null
  const isSinglePrompt = stored.responseEngineType === 'retell-llm'
  const base = input.baseUrl

  const steps: WizardStep[] = []

  // --- 1. Pick -------------------------------------------------------------
  steps.push({
    id: 'pick',
    title: 'Build the agent in Retell, then pick it',
    status: bound ? 'done' : 'current',
    detail: bound
      ? `${stored.agentName ?? site.retellAgentId}`
      : 'No agent chosen yet. Build one in the Retell dashboard, then select it below.',
    action: bound ? null : 'Pick from the list of agents in your Retell account.',
  })

  // --- 2. Audit ------------------------------------------------------------
  steps.push({
    id: 'audit',
    title: 'Read it back and audit',
    status: !bound ? 'todo' : checks === null ? 'current' : 'done',
    detail:
      checks === null
        ? 'Never read from Retell, so nothing is known about how it is configured.'
        : `${checks.filter((c) => c.status === 'pass').length}/${checks.length} checks pass.`,
    action: checks === null ? 'Pull the agent to see what needs fixing.' : null,
  })

  // --- 3. Fix what this repo owns -----------------------------------------
  const webhook = check('webhook_url')
  const analysis = check('analysis_fields')
  const fixNeeded = webhook?.status === 'fail' || analysis?.status === 'fail'
  steps.push({
    id: 'fix',
    title: 'Apply webhook and analysis fields',
    status: !bound || checks === null ? 'todo' : fixNeeded ? 'current' : 'done',
    detail:
      checks === null
        ? 'Waiting on the audit.'
        : fixNeeded
          ? (webhook?.detail ?? analysis?.detail ?? 'Integration fields are not set.')
          : `Webhook points here${base === null ? '' : ` (${base}/api/retell/events)`}.`,
    action: fixNeeded ? 'One button. Writes only the two fields this repo owns.' : null,
  })

  // --- 4. save_lead --------------------------------------------------------
  const tool = check('save_lead_tool')
  steps.push({
    id: 'save_lead',
    title: 'save_lead custom function',
    status:
      !bound || checks === null
        ? 'todo'
        : tool?.status === 'pass'
          ? isSinglePrompt
            ? 'skipped'
            : 'done'
          : 'current',
    detail:
      checks === null
        ? 'Waiting on the audit.'
        : tool?.status === 'pass'
          ? isSinglePrompt
            ? 'Nothing to wire — a single-prompt agent carries the tool on general_tools, so it ' +
              'is available from the first turn.'
            : (tool.detail ?? 'Present.')
          : (tool?.detail ?? 'Not found on this agent.'),
    action:
      tool?.status === 'pass'
        ? null
        : isSinglePrompt
          ? 'Re-create the agent — a single-prompt agent should carry this automatically.'
          : 'Add it in Retell and attach it to the intake nodes, then re-check. This one is ' +
            'yours: a tool only fires from the nodes it is attached to, and guessing which ' +
            'nodes would either do nothing or corrupt the flow.',
  })

  // --- 5. Bind -------------------------------------------------------------
  steps.push({
    id: 'bind',
    title: 'Bind the agent to this site',
    status: bound ? 'done' : 'todo',
    detail: bound
      ? `Site #${siteId} answers with ${site.retellAgentId}.`
      : 'Not bound yet.',
    action: null,
  })

  // --- 6. Number -----------------------------------------------------------
  const hasNumber = site.trackingNumber !== null
  const imported = site.retellNumberImportedAt !== null
  steps.push({
    id: 'number',
    title: 'Attach and import the phone number',
    status: !bound ? 'todo' : imported ? 'done' : 'current',
    detail: !hasNumber
      ? 'No number recorded on this site.'
      : imported
        ? `${site.trackingNumber} attached to the trunk and imported into Retell.`
        : `${site.trackingNumber} is recorded here but was NEVER attached to the trunk or ` +
          'imported. Calls to it reach nothing.',
    action: imported
      ? null
      : hasNumber
        ? 'Run the provisioning check, then confirm. This changes live call routing.'
        : 'Add the number above first.',
  })

  // --- 7. Prove ------------------------------------------------------------
  /**
   * Reads `first_real_call_at`, NOT `first_webhook_at`.
   *
   * The test-event button sets the latter, so a site could show "connected" while its
   * number had never been provisioned -- which is exactly what happened here once.
   */
  const proven = site.firstRealCallAt !== null
  steps.push({
    id: 'prove',
    title: 'Call it from a real phone',
    status: !imported ? 'todo' : proven ? 'done' : 'current',
    detail: proven
      ? `A real call reached this site at ${site.firstRealCallAt!.toISOString().slice(0, 16).replace('T', ' ')}.`
      : site.firstWebhookAt !== null
        ? 'A test event has arrived, which proves the ingest path — but no real call has. ' +
          'Nothing except a phone call validates the SIP configuration.'
        : 'Nothing has arrived yet.',
    action: proven ? null : `Dial ${site.trackingNumber ?? 'the number'} from a cell phone.`,
  })

  const current = steps.find((s) => s.status === 'current')

  return {
    siteId,
    agentId: site.retellAgentId,
    agentName: stored.agentName,
    responseEngineType: stored.responseEngineType,
    checks,
    steps,
    currentStepId: current?.id ?? null,
    complete: steps.every((s) => s.status === 'done' || s.status === 'skipped'),
  }
}
