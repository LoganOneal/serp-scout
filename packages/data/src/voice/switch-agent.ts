import 'server-only'
import { parsePhoneNumber, type AgentCheck } from '@rnr/core'
import type { Database } from '../db.js'
import { getSiteById, updateSite } from '../sites.js'
import type { VoiceProviders } from '../providers/voice.js'
import { publicBaseUrl, pullAgent, type AgentSnapshot } from './agents.js'

/**
 * Point a site -- and the number that rings it -- at a different Retell agent.
 *
 * ==================== THIS RE-ROUTES A LIVE BUSINESS LINE ====================
 * The write itself is one narrow PATCH: `inbound_agents` and `inbound_webhook_url`,
 * never `termination_uri` or the SIP credentials, because those are trunk topology and
 * getting them wrong takes the line down entirely.
 *
 * The value is not the PATCH. It is the preflight. Switching a number to an agent with
 * no webhook produces calls that happen and a CRM that stays empty; switching to one
 * with no `save_lead` produces an agent that answers perfectly and captures nothing
 * until post-call analysis, and nothing at all for a caller who hangs up. Both look
 * fine from every screen. So both are checked BEFORE the PATCH, and both take an
 * explicit override rather than a silent pass.
 * ===========================================================================
 */

export class SwitchAgentError extends Error {}

export interface SwitchBlocker {
  id: 'webhook_url' | 'save_lead_tool' | 'unpublished' | 'not_imported'
  detail: string
  /** What happens if this is overridden and a customer calls. */
  consequence: string
}

export interface SwitchPreflight {
  targetAgentId: string
  targetAgentName: string | null
  currentAgentId: string | null
  /** The number that would be re-pointed. NULL = nothing to re-point yet. */
  phoneNumber: string | null
  numberIsImported: boolean
  checks: AgentCheck[]
  blockers: SwitchBlocker[]
  /** The target as Retell holds it right now, already stored. */
  snapshot: AgentSnapshot
}

/**
 * Read-only. Pulls the target agent (which stores a snapshot and audits it) and reports
 * what switching would mean. Safe to call as often as the UI likes.
 */
export async function preflightSwitch(
  db: Database,
  args: { siteId: number; targetAgentId: string; providers: VoiceProviders; env?: NodeJS.ProcessEnv },
): Promise<SwitchPreflight> {
  const site = await getSiteById(db, args.siteId)
  if (site === null) throw new SwitchAgentError(`No site #${args.siteId}.`)

  if (site.retellAgentId === args.targetAgentId) {
    throw new SwitchAgentError('That is already this site’s agent. Nothing to switch.')
  }

  const snapshot = await pullAgent(db, {
    agentId: args.targetAgentId,
    providers: args.providers,
    ...(args.env ? { env: args.env } : {}),
  })

  const blockers: SwitchBlocker[] = []
  const failing = new Map(snapshot.checks.filter((c) => c.status === 'fail').map((c) => [c.id, c]))

  const webhook = failing.get('webhook_url')
  if (webhook) {
    blockers.push({
      id: 'webhook_url',
      detail: webhook.detail,
      consequence:
        'Calls would connect and be answered, and this CRM would never hear about them. ' +
        'No call row, no lead, no recording — the dashboard simply stays empty.',
    })
  }

  const tool = failing.get('save_lead_tool')
  if (tool) {
    blockers.push({
      id: 'save_lead_tool',
      detail: tool.detail,
      consequence:
        'The agent would answer normally and capture nothing during the call. Anyone who ' +
        'hangs up mid-intake is lost entirely; the rest depend on post-call analysis.',
    })
  }

  /**
   * Unpublished is a WARNING, not a defect.
   *
   * An unpinned number follows the latest version, so an unpublished agent answers fine.
   * The hazard is afterwards: every dashboard edit goes live on a line customers dial,
   * the moment it is typed.
   */
  if (snapshot.agent.isPublished === false) {
    blockers.push({
      id: 'unpublished',
      detail: `Version ${snapshot.agent.version ?? '?'} is not published.`,
      consequence:
        'The number follows the latest version, so this answers — but every edit you make ' +
        'in the Retell dashboard goes live immediately on a line customers are dialling.',
    })
  }

  const imported = site.retellNumberImportedAt !== null && site.trackingNumber !== null
  if (site.trackingNumber !== null && !imported) {
    blockers.push({
      id: 'not_imported',
      detail: `${site.trackingNumber} is recorded on this site but was never imported into Retell.`,
      consequence:
        'There is no imported number to re-point, so switching updates this database only. ' +
        'Run pnpm sites:provision to attach and import it.',
    })
  }

  return {
    targetAgentId: args.targetAgentId,
    targetAgentName: snapshot.agent.agentName,
    currentAgentId: site.retellAgentId,
    phoneNumber: site.trackingNumber,
    numberIsImported: imported,
    checks: snapshot.checks,
    blockers,
    snapshot,
  }
}

export interface SwitchResult {
  siteId: number
  from: string | null
  to: string
  /** True when Retell's own read-back confirms the number now points at the new agent. */
  numberRepointed: boolean
  /** What Retell reports after the PATCH, not what we asked for. */
  confirmedAgentIds: string[]
  overrode: SwitchBlocker[]
  snapshot: AgentSnapshot
}

export async function switchSiteAgent(
  db: Database,
  args: {
    siteId: number
    targetAgentId: string
    providers: VoiceProviders
    /** Proceed despite blockers. The UI must show what is being accepted. */
    override?: boolean
    env?: NodeJS.ProcessEnv
  },
): Promise<SwitchResult> {
  const pre = await preflightSwitch(db, {
    siteId: args.siteId,
    targetAgentId: args.targetAgentId,
    providers: args.providers,
    ...(args.env ? { env: args.env } : {}),
  })

  // 'unpublished' is advisory on its own and never blocks by itself.
  const hard = pre.blockers.filter((b) => b.id !== 'unpublished')
  if (hard.length > 0 && args.override !== true) {
    throw new SwitchAgentError(
      `Refusing to switch: ${hard.map((b) => b.detail).join(' ')} ` +
        'Re-run with override if that is genuinely what you want.',
    )
  }

  const site = (await getSiteById(db, args.siteId))!
  const base = publicBaseUrl(args.env ?? process.env)

  let numberRepointed = false
  let confirmedAgentIds: string[] = []

  if (pre.numberIsImported && site.trackingNumber !== null) {
    if (base === null) {
      throw new SwitchAgentError(
        'PUBLIC_BASE_URL is not set, so the inbound webhook cannot be written. Refusing to ' +
          'switch the number — it would keep pointing at whatever URL it holds now.',
      )
    }
    await args.providers.updatePhoneNumberWebhook({
      phoneNumber: site.trackingNumber,
      inboundWebhookUrl: `${base}/api/retell/inbound`,
      inboundAgentId: args.targetAgentId,
    })

    /**
     * Re-read from Retell rather than trusting the PATCH.
     *
     * A green result here means Retell confirmed the binding, not that a request was
     * accepted -- the same discipline as applyIntegration and retarget-tools. This is a
     * live phone line; "probably switched" is not a state worth reporting.
     */
    const numbers = await args.providers.listPhoneNumbers().catch(() => [])
    const mine = numbers
      .map(parsePhoneNumber)
      .find((n) => n !== null && n.phoneNumber === site.trackingNumber)
    confirmedAgentIds = mine?.inboundAgentIds ?? []
    numberRepointed = confirmedAgentIds.includes(args.targetAgentId)
  }

  await updateSite(db, args.siteId, {
    retellAgentId: args.targetAgentId,
    previousRetellAgentId: site.retellAgentId,
    /**
     * Nulled, not carried over.
     *
     * The fingerprint records the script THIS repo last pushed. An agent built in the
     * Retell dashboard was never pushed from here, so keeping the old value would claim
     * the new agent runs a script it has never seen.
     */
    promptFingerprint: null,
  })

  return {
    siteId: args.siteId,
    from: site.retellAgentId,
    to: args.targetAgentId,
    numberRepointed,
    confirmedAgentIds,
    overrode: hard,
    snapshot: pre.snapshot,
  }
}

/** Undo the last switch. Available for as long as `previous_retell_agent_id` is set. */
export async function switchBack(
  db: Database,
  args: { siteId: number; providers: VoiceProviders; env?: NodeJS.ProcessEnv },
): Promise<SwitchResult> {
  const site = await getSiteById(db, args.siteId)
  if (site === null) throw new SwitchAgentError(`No site #${args.siteId}.`)
  if (site.previousRetellAgentId === null) {
    throw new SwitchAgentError('This site has no previous agent recorded, so there is nothing to go back to.')
  }

  // Override is implied: the previous agent was live on this number, which is stronger
  // evidence that it works than any check could be.
  return switchSiteAgent(db, {
    siteId: args.siteId,
    targetAgentId: site.previousRetellAgentId,
    providers: args.providers,
    override: true,
    ...(args.env ? { env: args.env } : {}),
  })
}
