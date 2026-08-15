/**
 * The payloads that CREATE a Retell agent from this repo's script.
 *
 * ==================== WHY THIS IS A SINGLE-PROMPT AGENT ====================
 * Retell offers two response engines. A `conversation-flow` is a hand-built graph of
 * nodes, and `agent-audit.ts` is emphatic that this repo must never author one --
 * pushing a prompt over a flow deletes branching dialogue somebody drew by hand.
 *
 * That prohibition is about OVERWRITING. Creating a NEW `retell-llm` agent from a
 * script is a different act: nothing exists to destroy, and the whole configuration
 * is a prompt plus a tool list, both of which already live in this repo.
 *
 * It also removes the one step that could not be automated. A custom function has to
 * be wired into specific flow nodes to ever fire, which is why `applyIntegration`
 * refuses to add `save_lead` -- picking nodes is a decision about the conversation.
 * A single-prompt agent has no nodes: `general_tools` is available from the first
 * turn, so the tool arrives correctly wired or not at all.
 * =========================================================================
 *
 * Pure. Returns plain objects in Retell's wire shape; the client posts them.
 */

import { buildSaveLeadSchema, SAVE_LEAD_DESCRIPTION } from './lead.js'

/**
 * Agent settings, captured from the live HVAC inbound agent.
 *
 * ==================== THESE ARE OBSERVED, NOT CHOSEN ====================
 * Every value here was read from `agent_57f4e0346389a82e7b699a4fbf` ("Roger -- Old
 * Pueblo Heating and Air Intake"), the agent already answering a real business line.
 * They are copied so a newly created agent sounds and behaves like the one whose
 * calls you have actually listened to, rather than like Retell's defaults.
 *
 * The voice in particular is not a detail: changing it changes what every caller
 * hears, and there is no way to evaluate that from a config file.
 * =======================================================================
 */
export interface AgentDefaults {
  voiceId: string
  language: string
  /** The LLM behind the conversation. `post_call_analysis_model` matches it. */
  model: string
  voiceSpeed: number
  voiceTemperature: number
  volume: number
  maxCallDurationMs: number
  /** 'everything' keeps recordings. The PII modes cut the recording link to 10 minutes. */
  dataStorageSetting: string
  allowUserDtmf: boolean
  postCallAnalysisModel: string
  /** 'agent' means the agent greets first, which is what an inbound line should do. */
  startSpeaker: 'agent' | 'user'
  /**
   * The first thing the caller hears.
   *
   * References `{{business_name}}`, which has a speakable fallback ("our office") for
   * the degraded path where the inbound webhook times out and Retell supplies no
   * variables at all -- see FALLBACK_VARIABLES. A greeting that hard-coded a business
   * name would announce the wrong company on every other site.
   */
  beginMessage: string
}

export const HVAC_INBOUND_DEFAULTS: AgentDefaults = {
  voiceId: '11labs-Gilfoy',
  language: 'en-US',
  model: 'gpt-4.1',
  voiceSpeed: 1,
  voiceTemperature: 1,
  volume: 1,
  maxCallDurationMs: 3_600_000,
  dataStorageSetting: 'everything',
  allowUserDtmf: true,
  postCallAnalysisModel: 'gpt-4.1',
  startSpeaker: 'agent',
  beginMessage: 'Thanks for calling {{business_name}}. How can I help you today?',
}

// ---------------------------------------------------------------------------

export interface BuildAgentArgs {
  /** The script. Becomes `general_prompt`. */
  prompt: string
  /** PUBLIC_BASE_URL with no trailing slash. */
  baseUrl: string
  /** Shown in the Retell dashboard. Reference label only -- callers never hear it. */
  agentName: string
  /** ANALYSIS_FIELDS from @rnr/data. Passed in so this package stays dependency-free. */
  analysisFields: readonly unknown[]
  /**
   * `niches.slug`. Narrows the `system_type` enum the agent picks from mid-call --
   * a plumbing agent offered furnace/heat_pump/thermostat files every call as `other`.
   */
  nicheSlug?: string | null
  defaults?: AgentDefaults
}

/**
 * The `save_lead` custom function, in `general_tools` form.
 *
 * Both speak settings are OFF for the reason the save-lead route documents: this
 * fires inside the caller's turn, and an agent narrating "let me just save that"
 * costs a turn and reads as a machine.
 */
export function buildSaveLeadTool(
  baseUrl: string,
  nicheSlug?: string | null,
): Record<string, unknown> {
  return {
    type: 'custom',
    name: 'save_lead',
    description: SAVE_LEAD_DESCRIPTION,
    url: `${baseUrl}/api/retell/tool/save-lead`,
    speak_during_execution: false,
    speak_after_execution: false,
    parameters: buildSaveLeadSchema(nicheSlug),
  }
}

/** Body for `POST /create-retell-llm`. */
export function buildRetellLlmPayload(args: BuildAgentArgs): Record<string, unknown> {
  const d = args.defaults ?? HVAC_INBOUND_DEFAULTS
  return {
    general_prompt: args.prompt,
    general_tools: [buildSaveLeadTool(args.baseUrl, args.nicheSlug)],
    model: d.model,
    start_speaker: d.startSpeaker,
    begin_message: d.beginMessage,
  }
}

/**
 * Body for `POST /create-agent`.
 *
 * `webhook_url` and `post_call_analysis_data` are set HERE, at creation, rather than
 * by a follow-up PATCH. Same reasoning as `inbound_webhook_url` on number import:
 * a field that cannot be forgotten is better than one that is merely checked for.
 */
export function buildCreateAgentPayload(
  args: BuildAgentArgs & { llmId: string },
): Record<string, unknown> {
  const d = args.defaults ?? HVAC_INBOUND_DEFAULTS
  return {
    response_engine: { type: 'retell-llm', llm_id: args.llmId },
    agent_name: args.agentName,
    voice_id: d.voiceId,
    language: d.language,
    voice_speed: d.voiceSpeed,
    voice_temperature: d.voiceTemperature,
    volume: d.volume,
    max_call_duration_ms: d.maxCallDurationMs,
    data_storage_setting: d.dataStorageSetting,
    allow_user_dtmf: d.allowUserDtmf,
    webhook_url: `${args.baseUrl}/api/retell/events`,
    post_call_analysis_data: [...args.analysisFields],
    post_call_analysis_model: d.postCallAnalysisModel,
  }
}
