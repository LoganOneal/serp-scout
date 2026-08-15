import 'server-only'
import {
  buildCreateAgentPayload,
  buildRetellLlmPayload,
  promptFingerprint,
  scriptForNiche,
  type AgentDefaults,
} from '@rnr/core'
import type { Database } from '../db.js'
import { getSiteDetail, updateSite } from '../sites.js'
import type { VoiceProviders } from '../providers/voice.js'
import { ANALYSIS_FIELDS } from './analysis-fields.js'
import { publicBaseUrl, pullAgent, type AgentSnapshot } from './agents.js'

/**
 * Create a Retell agent for a site, from the script in this repo.
 *
 * ==================== WHAT THIS DOES AND DOES NOT TOUCH ====================
 * It creates. It never edits an existing agent, and it never writes a Conversation
 * Flow. The agent it produces is a `retell-llm`: a prompt plus the `save_lead` tool,
 * both of which are already versioned here.
 *
 * The phone number is NOT touched. Creating an agent changes nothing a caller can
 * reach; attaching a DID to a trunk takes a working business line off Programmable
 * Voice and is irreversible in the ways that matter. Those stay separate steps, and
 * only the second one requires --confirm.
 * =========================================================================
 */

export class AgentCreateError extends Error {}

export interface CreateAgentForSiteArgs {
  siteId: number
  providers: VoiceProviders
  /** The script. Defaults to this niche's script, or AGENT_PROMPT when it has none. */
  prompt?: string
  /** Dashboard label. Defaults to the site's business name and cell. */
  agentName?: string
  /** Voice, model and call settings. Defaults to HVAC_INBOUND_DEFAULTS. */
  defaults?: AgentDefaults
  env?: NodeJS.ProcessEnv
}

export interface CreateAgentForSiteResult {
  agentId: string
  llmId: string
  agentName: string
  snapshot: AgentSnapshot
}

export async function createAgentForSite(
  db: Database,
  args: CreateAgentForSiteArgs,
): Promise<CreateAgentForSiteResult> {
  const env = args.env ?? process.env
  const base = publicBaseUrl(env)
  if (base === null) {
    throw new AgentCreateError(
      'PUBLIC_BASE_URL is not set, so the agent would be created with no webhook and no ' +
        'reachable save_lead URL — it would answer calls and record nothing.',
    )
  }
  if (/localhost|127\.0\.0\.1/.test(base)) {
    /**
     * Refused rather than written, exactly as retarget-tools does.
     *
     * Retell cannot reach localhost. An agent created against one has a save_lead URL
     * that never fires, and every screen would show it as configured.
     */
    throw new AgentCreateError(
      `PUBLIC_BASE_URL is ${base}, which Retell cannot reach. The agent's webhook and ` +
        'save_lead URL would both be dead. Refusing.',
    )
  }

  const detail = await getSiteDetail(db, args.siteId)
  if (detail === null) throw new AgentCreateError(`No site #${args.siteId}.`)

  /**
   * One agent per site, and this refuses to make a second.
   *
   * Overwriting `retell_agent_id` would orphan the previous agent -- still live, still
   * billable, still the one the imported phone number points at, and no longer named
   * anywhere in this database. Deleting the old one is a decision for whoever knows
   * whether it is answering a real line.
   */
  if (detail.site.retellAgentId !== null) {
    throw new AgentCreateError(
      `Site #${args.siteId} already has agent ${detail.site.retellAgentId}. Creating another ` +
        'would leave that one live and unreferenced. Clear the field first if it is genuinely stale.',
    )
  }

  const prompt = args.prompt?.trim() || scriptForNiche(detail.nicheSlug)
  const agentName = args.agentName?.trim() || defaultAgentName(detail)

  const build = {
    prompt,
    baseUrl: base,
    agentName,
    analysisFields: ANALYSIS_FIELDS,
    // Narrows the mid-call job-type enum to this trade's vocabulary.
    nicheSlug: detail.nicheSlug,
    ...(args.defaults ? { defaults: args.defaults } : {}),
  }

  const { llmId } = await args.providers.createRetellLlm(buildRetellLlmPayload(build))
  const { agentId } = await args.providers.createAgent(
    buildCreateAgentPayload({ ...build, llmId }),
  )

  /**
   * Re-read rather than trust the create response.
   *
   * Same discipline as applyIntegration: this stores the snapshot and runs the audit
   * against what Retell actually holds, so the webhook and save_lead rows on /agent
   * are evidence rather than an echo of the request body.
   */
  const snapshot = await pullAgent(db, {
    agentId,
    providers: args.providers,
    ...(args.env ? { env: args.env } : {}),
  })

  await updateSite(db, args.siteId, {
    retellAgentId: agentId,
    // Fingerprint the script that was actually sent, not AGENT_PROMPT, or an edited
    // script would show as current the moment the file it diverged from was unchanged.
    promptFingerprint: promptFingerprint(prompt),
  })

  return { agentId, llmId, agentName, snapshot }
}

/** e.g. "Kenosha Air — Kenosha WI HVAC Repair intake". */
function defaultAgentName(detail: NonNullable<Awaited<ReturnType<typeof getSiteDetail>>>): string {
  const business = detail.site.displayName?.trim() || detail.site.domain || `Site #${detail.site.id}`
  return `${business} — ${detail.localityName} ${detail.stateCode} ${detail.nicheLabel} intake`
}
