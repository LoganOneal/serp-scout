import 'server-only'
import { desc, eq } from 'drizzle-orm'
import {
  auditAgent,
  parseAgent,
  parseFlow,
  parseRetellLlm,
  type AgentCheck,
  type ParsedAgent,
  type ParsedFlow,
  type ParsedLlm,
} from '@rnr/core'
import type { Database } from '../db.js'
import { retellAgents, type RetellAgent } from '../schema.js'
import type { VoiceProviders } from '../providers/voice.js'

/**
 * Pulling, uploading and auditing the Retell agent.
 *
 * `pnpm voice:agent-pull` and the /agent page both go through here, so there is one
 * definition of what "connected" means.
 */

export interface AgentSnapshot {
  agent: ParsedAgent
  flow: ParsedFlow | null
  /** Set instead of `flow` when the agent is a single-prompt `retell-llm`. */
  llm: ParsedLlm | null
  checks: AgentCheck[]
  /** 'api' = read from Retell. 'upload' = a JSON someone handed us. */
  source: 'api' | 'upload'
}

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['PUBLIC_BASE_URL']?.trim()
  if (!raw) return null
  return raw.replace(/\/$/, '')
}

/**
 * Fetch the agent (and its flow) from Retell and store the snapshot.
 *
 * This is the answer to "do I have to import it every time I change something":
 * no. The dashboard stays the place you edit; this reads the result on demand.
 */
export async function pullAgent(
  db: Database,
  args: { agentId: string; providers: VoiceProviders; env?: NodeJS.ProcessEnv },
): Promise<AgentSnapshot> {
  const rawAgent = await args.providers.getAgent(args.agentId)
  const agent = parseAgent(rawAgent)
  if (agent === null) {
    throw new Error(
      `Retell returned no usable agent for "${args.agentId}". Check the id and that the API key ` +
        'has access to it.',
    )
  }

  /**
   * Fetch whichever response engine this agent actually has.
   *
   * A conversation-flow agent has a graph; a single-prompt agent has an LLM holding
   * `general_tools`. Both carry the `save_lead` tool the audit looks for, so reading
   * only the flow would report "no custom functions at all" for every agent this
   * repo creates -- a red row describing a tool that is present and working.
   *
   * A failure here is recorded as "engine unknown" rather than failing the whole
   * pull: the agent-level checks (webhook URL, analysis fields) are still worth having.
   */
  let rawEngine: unknown = null
  let flow: ParsedFlow | null = null
  let llm: ParsedLlm | null = null
  if (agent.conversationFlowId !== null) {
    rawEngine = await args.providers.getConversationFlow(agent.conversationFlowId).catch(() => null)
    flow = parseFlow(rawEngine)
  } else if (agent.llmId !== null) {
    rawEngine = await args.providers.getRetellLlm(agent.llmId).catch(() => null)
    llm = parseRetellLlm(rawEngine)
  }

  const checks = auditAgent({ agent, flow, llm, baseUrl: publicBaseUrl(args.env) })
  await storeSnapshot(db, { agent, flow, llm, rawAgent, rawFlow: rawEngine, source: 'api' })
  return { agent, flow, llm, checks, source: 'api' }
}

/**
 * Accept an exported agent JSON instead of calling the API.
 *
 * Useful for a config produced in the builder before credentials exist, or for
 * pinning a known-good version in the repo. The snapshot is marked `source:
 * 'upload'` because an uploaded file is a CLAIM about what Retell holds, not a
 * reading of it -- and the UI says so, since a stale export looks exactly like a
 * current one.
 */
export async function ingestAgentJson(
  db: Database,
  args: { json: unknown; env?: NodeJS.ProcessEnv },
): Promise<AgentSnapshot> {
  const parsed = unwrapUpload(args.json)
  if (parsed === null) {
    throw new Error(
      'That JSON does not look like a Retell agent. Expected an object with "agent_id", ' +
        'or a wrapper like { "agent": {...}, "flow": {...} }.',
    )
  }

  const agent = parseAgent(parsed.agent)
  if (agent === null) {
    throw new Error('The agent object has no "agent_id", so it cannot be identified.')
  }
  const flow = parsed.flow === null ? null : parseFlow(parsed.flow)

  const checks = auditAgent({ agent, flow, baseUrl: publicBaseUrl(args.env) })
  await storeSnapshot(db, {
    agent,
    flow,
    llm: null,
    rawAgent: parsed.agent,
    rawFlow: parsed.flow,
    source: 'upload',
  })
  return { agent, flow, llm: null, checks, source: 'upload' }
}

/**
 * Accept the several shapes an export can arrive in.
 *
 * The dashboard, the API and this repo's own fixture all wrap the agent
 * differently. Sniffing rather than demanding one shape means a paste that
 * obviously contains an agent is not rejected on a technicality.
 */
function unwrapUpload(json: unknown): { agent: unknown; flow: unknown } | null {
  if (typeof json !== 'object' || json === null) return null
  const o = json as Record<string, unknown>

  // Bare agent.
  if (typeof o['agent_id'] === 'string') {
    return { agent: o, flow: o['conversation_flow'] ?? null }
  }
  // { agent, flow } — what this repo's fixture and pull endpoint emit.
  const nested = o['agent']
  if (typeof nested === 'object' && nested !== null) {
    return { agent: nested, flow: o['flow'] ?? o['conversation_flow'] ?? null }
  }
  // A bare conversation flow with no agent is not enough to identify anything.
  return null
}

async function storeSnapshot(
  db: Database,
  args: {
    agent: ParsedAgent
    flow: ParsedFlow | null
    llm: ParsedLlm | null
    rawAgent: unknown
    /** The response engine payload -- a conversation flow OR a retell-llm. */
    rawFlow: unknown
    source: 'api' | 'upload'
  },
): Promise<void> {
  const values = {
    agentId: args.agent.agentId,
    agentName: args.agent.agentName,
    responseEngineType: args.agent.responseEngineType,
    conversationFlowId: args.agent.conversationFlowId,
    version: args.agent.version,
    isPublished: args.agent.isPublished,
    voiceId: args.agent.voiceId,
    language: args.agent.language,
    webhookUrl: args.agent.webhookUrl,
    postCallAnalysisFields: args.agent.postCallAnalysisFields,
    dataStorageSetting: args.agent.dataStorageSetting,
    // A single-prompt agent has no nodes, which is NULL rather than 0 -- zero nodes
    // would read as an empty flow. Its tools are on the LLM, so they land in the
    // same column and the /agent page needs no special case.
    nodeCount: args.flow?.nodeCount ?? null,
    toolNames: args.flow?.toolNames ?? args.llm?.toolNames ?? null,
    remoteAgent: args.rawAgent as never,
    remoteFlow: args.rawFlow as never,
    source: args.source,
    pulledAt: new Date(),
  }

  await db
    .insert(retellAgents)
    .values(values)
    .onConflictDoUpdate({ target: retellAgents.agentId, set: values })
}

export async function getStoredAgent(db: Database, agentId: string): Promise<RetellAgent | null> {
  const rows = await db.select().from(retellAgents).where(eq(retellAgents.agentId, agentId)).limit(1)
  return rows[0] ?? null
}

export async function listStoredAgents(db: Database): Promise<RetellAgent[]> {
  return db.select().from(retellAgents).orderBy(desc(retellAgents.pulledAt))
}

/** Re-audit a stored snapshot without touching the network. */
export function auditStored(
  row: RetellAgent,
  env: NodeJS.ProcessEnv = process.env,
): AgentCheck[] | null {
  const agent = parseAgent(row.remoteAgent)
  if (agent === null) return null
  // `remote_flow` holds whichever engine the agent has, so which parser to use is
  // decided by the agent rather than by trying one and hoping.
  const flow = row.remoteFlow === null ? null : parseFlow(row.remoteFlow)
  const llm = row.remoteFlow === null ? null : parseRetellLlm(row.remoteFlow)
  return auditAgent({ agent, flow, llm, baseUrl: publicBaseUrl(env) })
}

/**
 * Apply the integration settings this repo owns.
 *
 * Only `webhook_url` and `post_call_analysis_data`. The client enforces that
 * allowlist too -- twice, because there is no undo on a Conversation Flow and
 * "which fields does this touch" must be answerable without reading the call site.
 *
 * Notably NOT applied: the `save_lead` function. A custom function has to be wired
 * into specific nodes to ever fire, and choosing which nodes is a decision about the
 * conversation, not about plumbing.
 */
export async function applyIntegration(
  db: Database,
  args: {
    agentId: string
    providers: VoiceProviders
    analysisFields: unknown[]
    env?: NodeJS.ProcessEnv
  },
): Promise<{ applied: string[]; snapshot: AgentSnapshot }> {
  const base = publicBaseUrl(args.env)
  if (base === null) {
    throw new Error('PUBLIC_BASE_URL is not set, so there is no webhook URL to apply.')
  }

  const patch: Record<string, unknown> = {
    webhook_url: `${base}/api/retell/events`,
    post_call_analysis_data: args.analysisFields,
  }

  await args.providers.updateAgent(args.agentId, patch)

  // Re-pull rather than assuming the PATCH did what was asked. Retell is the source
  // of truth for what Retell holds, and a snapshot written from our own request body
  // would show green whether or not it landed.
  const snapshot = await pullAgent(db, {
    agentId: args.agentId,
    providers: args.providers,
    ...(args.env ? { env: args.env } : {}),
  })

  return { applied: Object.keys(patch), snapshot }
}
