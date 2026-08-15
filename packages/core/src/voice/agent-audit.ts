/**
 * Audit a live Retell agent against what this CRM needs from it.
 *
 * ==================== WHO OWNS WHAT ====================
 * A Retell agent can be a single prompt (`retell-llm`) or a visual Conversation
 * Flow (`conversation-flow`). A flow is 14 hand-built nodes of branching dialogue,
 * and this repo must NEVER overwrite it -- pushing `AGENT_PROMPT` over a flow would
 * delete the conversation design and replace it with something that does not branch.
 *
 * So ownership splits:
 *   Retell owns  the conversation: nodes, instructions, edges, voice, model.
 *   This repo owns the INTEGRATION CONTRACT: where webhooks go, the save_lead tool,
 *                 the post-call analysis fields, the per-site dynamic variables.
 *
 * This module checks only the second list. Everything it reports is something the
 * CRM genuinely needs; nothing it reports is a matter of taste about the script.
 * ======================================================
 *
 * Pure functions over parsed JSON. No network, so the whole audit is unit-testable
 * against a real captured agent payload.
 */

export type ResponseEngineType = 'retell-llm' | 'conversation-flow' | 'custom-llm' | (string & {})

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown'

export interface AgentCheck {
  id: string
  label: string
  status: CheckStatus
  /** What is true right now. */
  detail: string
  /**
   * What to do about it, when there is something to do.
   *
   * Non-null on every fail. A red row with no remedy is the dashboard equivalent of
   * a dead button -- it tells you something is wrong and leaves you nowhere to go.
   */
  remedy: string | null
  /** True when `applyIntegration` can fix this without touching the conversation. */
  autoFixable: boolean
}

export interface ParsedAgent {
  agentId: string
  agentName: string | null
  responseEngineType: ResponseEngineType
  /** Set only for conversation-flow agents. */
  conversationFlowId: string | null
  /** Set only for retell-llm agents. */
  llmId: string | null
  version: number | null
  isPublished: boolean | null
  voiceId: string | null
  language: string | null
  webhookUrl: string | null
  /** Present only when post-call analysis fields are configured. */
  postCallAnalysisFields: string[]
  /**
   * 'everything' means Retell keeps recordings. The PII opt-out modes shorten the
   * recording link to TEN MINUTES, which changes how urgent the fetch job is.
   */
  dataStorageSetting: string | null
  lastModifiedAt: Date | null
}

/**
 * The response engine of a single-prompt agent.
 *
 * Parallel to ParsedFlow rather than folded into it: an `llm_id` is not a
 * `conversation_flow_id`, and storing one in the other's field would put a value in
 * a column whose name is a lie. The audit reads tools from whichever one is present.
 */
export interface ParsedLlm {
  llmId: string
  version: number | null
  generalPrompt: string | null
  toolNames: string[]
  toolUrls: string[]
  model: string | null
  isPublished: boolean | null
}

export interface ParsedFlow {
  conversationFlowId: string
  version: number | null
  globalPrompt: string | null
  nodeCount: number
  nodeNames: string[]
  /** Custom function tools defined on the flow. */
  toolNames: string[]
  toolUrls: string[]
  modelChoice: string | null
}

// --- Parsing -----------------------------------------------------------------

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

export function parseAgent(raw: unknown): ParsedAgent | null {
  const a = obj(raw)
  if (!a) return null
  const agentId = str(a['agent_id'])
  if (!agentId) return null

  const engine = obj(a['response_engine'])
  const engineType = (str(engine?.['type']) ?? 'unknown') as ResponseEngineType

  const analysis = a['post_call_analysis_data']
  const fields = Array.isArray(analysis)
    ? analysis.map((f) => str(obj(f)?.['name'])).filter((n): n is string => n !== null)
    : []

  const modified = int(a['last_modification_timestamp'])

  return {
    agentId,
    agentName: str(a['agent_name']),
    responseEngineType: engineType,
    conversationFlowId: str(engine?.['conversation_flow_id']),
    llmId: str(engine?.['llm_id']),
    version: int(a['version']),
    isPublished: bool(a['is_published']),
    voiceId: str(a['voice_id']),
    language: str(a['language']),
    webhookUrl: str(a['webhook_url']),
    postCallAnalysisFields: fields,
    dataStorageSetting: str(a['data_storage_setting']),
    lastModifiedAt: modified === null ? null : new Date(modified),
  }
}

export function parseFlow(raw: unknown): ParsedFlow | null {
  const f = obj(raw)
  if (!f) return null
  const id = str(f['conversation_flow_id'])
  if (!id) return null

  const nodes = Array.isArray(f['nodes']) ? f['nodes'] : []
  const tools = Array.isArray(f['tools']) ? f['tools'] : []
  const model = obj(f['model_choice'])

  return {
    conversationFlowId: id,
    version: int(f['version']),
    globalPrompt: str(f['global_prompt']),
    nodeCount: nodes.length,
    nodeNames: nodes.map((n) => str(obj(n)?.['name']) ?? '(unnamed)'),
    toolNames: tools.map((t) => str(obj(t)?.['name']) ?? '(unnamed)'),
    toolUrls: tools.map((t) => str(obj(t)?.['url']) ?? '').filter((u) => u !== ''),
    modelChoice: str(model?.['model']),
  }
}

export function parseRetellLlm(raw: unknown): ParsedLlm | null {
  const l = obj(raw)
  if (!l) return null
  const id = str(l['llm_id'])
  if (!id) return null

  const tools = Array.isArray(l['general_tools']) ? l['general_tools'] : []

  return {
    llmId: id,
    version: int(l['version']),
    generalPrompt: str(l['general_prompt']),
    toolNames: tools.map((t) => str(obj(t)?.['name']) ?? '(unnamed)'),
    toolUrls: tools.map((t) => str(obj(t)?.['url']) ?? '').filter((u) => u !== ''),
    model: str(l['model']),
    isPublished: bool(l['is_published']),
  }
}

// --- The audit ---------------------------------------------------------------

export interface AuditInput {
  agent: ParsedAgent
  /** Null for a retell-llm agent, or when the flow could not be fetched. */
  flow: ParsedFlow | null
  /**
   * The single-prompt engine, when the agent is a `retell-llm`.
   *
   * Optional so every existing caller keeps compiling. Without it a created
   * single-prompt agent fails the save_lead check while holding a perfectly good
   * tool -- the tool is simply on `general_tools` rather than on a flow, and an
   * audit that cannot see it reports a problem that does not exist.
   */
  llm?: ParsedLlm | null
  /** PUBLIC_BASE_URL, no trailing slash. Null when unconfigured. */
  baseUrl: string | null
}

export const SAVE_LEAD_TOOL_NAME = 'save_lead'

/** Fields the reconcile path reads out of `custom_analysis_data`. */
export const EXPECTED_ANALYSIS_FIELDS = [
  'name',
  'phone',
  'zip',
  'problem',
  'is_emergency',
] as const

export function auditAgent(input: AuditInput): AgentCheck[] {
  const { agent, flow, baseUrl } = input
  const llm = input.llm ?? null
  const checks: AgentCheck[] = []

  const expectedEvents = baseUrl === null ? null : `${baseUrl}/api/retell/events`
  const expectedTool = baseUrl === null ? null : `${baseUrl}/api/retell/tool/save-lead`

  // --- 1. Events webhook. Without it the CRM sees literally nothing. ---------
  if (agent.webhookUrl === null) {
    checks.push({
      id: 'webhook_url',
      label: 'Agent webhook URL',
      status: 'fail',
      detail:
        'Not set. No call_started, call_ended or call_analyzed event will ever reach this CRM, ' +
        'so calls will happen and no row will appear.',
      remedy:
        expectedEvents === null
          ? 'Set PUBLIC_BASE_URL first, then apply the integration settings.'
          : `Set it to ${expectedEvents}`,
      autoFixable: expectedEvents !== null,
    })
  } else if (expectedEvents === null) {
    checks.push({
      id: 'webhook_url',
      label: 'Agent webhook URL',
      status: 'unknown',
      detail: `Set to ${agent.webhookUrl}, but PUBLIC_BASE_URL is unset so it cannot be compared.`,
      remedy: 'Set PUBLIC_BASE_URL.',
      autoFixable: false,
    })
  } else if (agent.webhookUrl !== expectedEvents) {
    checks.push({
      id: 'webhook_url',
      label: 'Agent webhook URL',
      status: 'fail',
      detail: `Points at ${agent.webhookUrl}, not at this app.`,
      remedy: `Change it to ${expectedEvents}`,
      autoFixable: true,
    })
  } else {
    checks.push({
      id: 'webhook_url',
      label: 'Agent webhook URL',
      status: 'pass',
      detail: agent.webhookUrl,
      remedy: null,
      autoFixable: false,
    })
  }

  // --- 2. The save_lead tool. Without it, no lead survives a hang-up. -------
  const toolNames = flow?.toolNames ?? llm?.toolNames ?? []
  const allToolUrls = flow?.toolUrls ?? llm?.toolUrls ?? []
  const hasTool = toolNames.includes(SAVE_LEAD_TOOL_NAME)
  const toolUrl = allToolUrls.find((u) => u.includes('/api/retell/tool/save-lead')) ?? null

  if (!hasTool) {
    checks.push({
      id: 'save_lead_tool',
      label: `${SAVE_LEAD_TOOL_NAME} custom function`,
      status: 'fail',
      detail:
        toolNames.length === 0
          ? 'The agent has no custom functions at all, so nothing is captured DURING a call. ' +
            'Every lead would depend on post-call analysis, which produces nothing for a caller ' +
            'who hangs up mid-conversation.'
          : `Not found. Existing functions: ${toolNames.join(', ')}.`,
      remedy:
        expectedTool === null
          ? 'Set PUBLIC_BASE_URL, then add the function.'
          : `Add a custom function named "${SAVE_LEAD_TOOL_NAME}" pointing at ${expectedTool}, ` +
            'with speak-during and speak-after both OFF. Run `pnpm voice:agent-config` for the ' +
            'parameter schema.',
      // Deliberately NOT auto-fixable: a tool has to be wired into specific nodes of
      // a conversation flow to ever fire, and guessing which nodes would either do
      // nothing or corrupt the flow. This one is a human decision.
      autoFixable: false,
    })
  } else if (expectedTool !== null && toolUrl === null) {
    checks.push({
      id: 'save_lead_tool',
      label: `${SAVE_LEAD_TOOL_NAME} custom function`,
      status: 'fail',
      detail: `Exists, but no function URL points at this app. URLs found: ${allToolUrls.join(', ') || 'none'}.`,
      remedy: `Point it at ${expectedTool}`,
      autoFixable: false,
    })
  } else {
    checks.push({
      id: 'save_lead_tool',
      label: `${SAVE_LEAD_TOOL_NAME} custom function`,
      status: 'pass',
      detail: toolUrl ?? 'present',
      remedy: null,
      autoFixable: false,
    })
  }

  // --- 3. Post-call analysis fields (backfill only, so a warn not a fail). ---
  const missingFields = EXPECTED_ANALYSIS_FIELDS.filter(
    (f) => !agent.postCallAnalysisFields.includes(f),
  )
  if (agent.postCallAnalysisFields.length === 0) {
    checks.push({
      id: 'analysis_fields',
      label: 'Post-call analysis fields',
      status: 'warn',
      detail:
        'None configured. Leads will come only from the mid-call tool, with nothing to ' +
        'reconcile against — so a field the agent mis-heard has no second source.',
      remedy: 'Add the fields printed by `pnpm voice:agent-config`.',
      autoFixable: true,
    })
  } else if (missingFields.length > 0) {
    checks.push({
      id: 'analysis_fields',
      label: 'Post-call analysis fields',
      status: 'warn',
      detail: `Configured: ${agent.postCallAnalysisFields.join(', ')}. Missing: ${missingFields.join(', ')}.`,
      remedy: `Add ${missingFields.join(', ')}.`,
      autoFixable: true,
    })
  } else {
    checks.push({
      id: 'analysis_fields',
      label: 'Post-call analysis fields',
      status: 'pass',
      detail: agent.postCallAnalysisFields.join(', '),
      remedy: null,
      autoFixable: false,
    })
  }

  // --- 4. Recording retention, because it sets the fetch deadline. ----------
  if (agent.dataStorageSetting === 'everything') {
    checks.push({
      id: 'recording_retention',
      label: 'Recording retention',
      status: 'pass',
      detail:
        'data_storage_setting is "everything", so Retell keeps recordings and the fetch job ' +
        'is not racing a 10-minute link expiry.',
      remedy: null,
      autoFixable: false,
    })
  } else if (agent.dataStorageSetting === null) {
    checks.push({
      id: 'recording_retention',
      label: 'Recording retention',
      status: 'unknown',
      detail: 'Not reported by the API.',
      remedy: null,
      autoFixable: false,
    })
  } else {
    checks.push({
      id: 'recording_retention',
      label: 'Recording retention',
      status: 'warn',
      detail:
        `data_storage_setting is "${agent.dataStorageSetting}". With the PII opt-out on, the ` +
        'recording link lives about TEN MINUTES.',
      remedy: 'Keep `pnpm worker` running at all times, or recordings will be lost permanently.',
      autoFixable: false,
    })
  }

  // --- 5. Published state. An unpublished version may not serve calls. ------
  if (agent.isPublished === false) {
    checks.push({
      id: 'published',
      label: 'Published',
      status: 'warn',
      detail: `Version ${agent.version ?? '?'} is not published.`,
      remedy:
        'Publish it in the Retell dashboard once the integration checks pass, or calls may be ' +
        'served by an older version that lacks them.',
      autoFixable: false,
    })
  } else if (agent.isPublished === true) {
    checks.push({
      id: 'published',
      label: 'Published',
      status: 'pass',
      detail: `Version ${agent.version ?? '?'} is published.`,
      remedy: null,
      autoFixable: false,
    })
  }

  return checks
}

/** Worst status present, for a headline badge. */
export function auditVerdict(checks: AgentCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail'
  if (checks.some((c) => c.status === 'warn')) return 'warn'
  if (checks.some((c) => c.status === 'unknown')) return 'unknown'
  return 'pass'
}

/**
 * Would the CRM record anything at all today?
 *
 * Kept separate from the verdict because it answers the only question that matters
 * before the first real call: a missing webhook URL means every call vanishes, and
 * that is a different severity from a missing analysis field.
 */
export function crmWouldReceiveNothing(checks: AgentCheck[]): boolean {
  return checks.some((c) => c.id === 'webhook_url' && c.status === 'fail')
}
