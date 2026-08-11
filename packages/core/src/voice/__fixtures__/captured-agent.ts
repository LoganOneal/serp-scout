/**
 * A REAL Retell agent, captured from the live API on 2026-08-03.
 *
 * Agent "Roger - Old Pueblo Heating and Air Intake". Node instruction text and the
 * global prompt are REDACTED: the audit reads structure -- engine type, tools,
 * webhook URL, analysis fields -- and never script content, so the client's dialogue
 * does not belong in a committed fixture.
 *
 * ==================== WHY A REAL CAPTURE ====================
 * The shape was not what the docs implied. This agent is a `conversation-flow`
 * engine with NO general_prompt, NO tools and NO webhook_url key at all -- three
 * absences an invented fixture would have helpfully filled in, and exactly the three
 * things the audit exists to catch. Recapture with `pnpm voice:agent-pull --json`.
 *
 * A .ts module rather than a .json import, matching scoring/__fixtures__/archetypes.ts:
 * a JSON subpath import does not resolve through the web app's bundler.
 * ===========================================================
 */

export const CAPTURED_AGENT = {
  "agent_id": "agent_57f4e0346389a82e7b699a4fbf",
  "channel": "voice",
  "last_modification_timestamp": 1785810257237,
  "agent_name": "Roger - Old Pueblo Heating and Air Intake",
  "response_engine": {
    "type": "conversation-flow",
    "version": 2,
    "conversation_flow_id": "conversation_flow_669c8b0c2a05"
  },
  "language": "en-US",
  "data_storage_setting": "everything",
  "opt_in_signed_url": false,
  "version": 2,
  "base_version": 1,
  "assigned_tags": [],
  "is_published": false,
  "post_call_analysis_model": "gpt-4.1",
  "pii_config": {
    "mode": "post_call",
    "categories": []
  },
  "voice_id": "11labs-Gilfoy",
  "fallback_voice_ids": [],
  "voice_temperature": 1,
  "voice_speed": 1,
  "volume": 1,
  "enable_expressive_mode": false,
  "max_call_duration_ms": 3600000,
  "allow_user_dtmf": true,
  "user_dtmf_options": {}
} as const

export const CAPTURED_FLOW = {
  "conversation_flow_id": "conversation_flow_669c8b0c2a05",
  "version": 2,
  "last_modification_timestamp": 1785810257227,
  "global_prompt": "(redacted for the fixture -- structure only)",
  "start_node_id": "greeting",
  "start_speaker": "agent",
  "model_choice": {
    "type": "cascading",
    "model": "gpt-4.1"
  },
  "is_published": false,
  "nodes": [
    {
      "id": "emergency_end",
      "name": "Emergency End Call",
      "type": "end"
    },
    {
      "id": "greeting",
      "name": "Greeting",
      "type": "conversation"
    },
    {
      "id": "contact_info",
      "name": "Collect Contact Info",
      "type": "conversation"
    },
    {
      "id": "address_authorization",
      "name": "Collect Address and Authorization",
      "type": "conversation"
    },
    {
      "id": "problem_description",
      "name": "Problem Description",
      "type": "conversation"
    },
    {
      "id": "system_symptom",
      "name": "System Symptom Details",
      "type": "conversation"
    },
    {
      "id": "history_intent",
      "name": "System History and Intent",
      "type": "conversation"
    },
    {
      "id": "repair_timing",
      "name": "Repair Timing",
      "type": "conversation"
    },
    {
      "id": "replacement_scope",
      "name": "Replacement Scope",
      "type": "conversation"
    },
    {
      "id": "replacement_quotes_timeline",
      "name": "Replacement Quotes and Timeline",
      "type": "conversation"
    },
    {
      "id": "safety_check",
      "name": "Safety Check",
      "type": "conversation"
    },
    {
      "id": "callback_time",
      "name": "Callback Preference",
      "type": "conversation"
    },
    {
      "id": "summary_confirm",
      "name": "Summarize and Confirm",
      "type": "conversation"
    },
    {
      "id": "closing",
      "name": "End Call",
      "type": "end"
    }
  ],
  "tools": []
} as const
