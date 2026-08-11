/**
 * Print the Retell agent configuration that this repo is the source of truth for.
 *
 *   pnpm voice:agent-config
 *   pnpm voice:agent-config --json
 *
 * ==================== THE PROMPT LIVES HERE, NOT IN THE DASHBOARD ====================
 * Retell holds a rendered copy. @rnr/core holds the truth. A prompt edited in the
 * dashboard is an untracked config change that silently diverges from the `sites`
 * row claiming to describe it -- and it forfeits the portability hedge: with the
 * prompt, the variables and the tool contract all in this repo, moving off Retell
 * is a transport swap rather than a rebuild.
 *
 * `promptFingerprint()` is recorded on each site at provision time, so the
 * connection panel can say whether what Retell holds is still current.
 * ==================================================================================
 */
import 'dotenv/config'
import {
  AGENT_PROMPT,
  FALLBACK_VARIABLES,
  promptFingerprint,
  referencedVariables,
  SAVE_LEAD_DESCRIPTION,
  SAVE_LEAD_SCHEMA,
} from '@rnr/core'

const base = (process.env['PUBLIC_BASE_URL'] ?? 'https://YOUR-TUNNEL-HERE').replace(/\/$/, '')

const config = {
  prompt_fingerprint: promptFingerprint(),
  general_prompt: AGENT_PROMPT,
  webhook_url: `${base}/api/retell/events`,
  inbound_webhook_url: `${base}/api/retell/inbound`,
  dynamic_variables_supplied: referencedVariables(AGENT_PROMPT),
  general_tools: [
    {
      type: 'custom',
      name: 'save_lead',
      description: SAVE_LEAD_DESCRIPTION,
      url: `${base}/api/retell/tool/save-lead`,
      // BOTH off, deliberately. An agent narrating "let me just save that for you"
      // while it writes to a database is pure tell, and it costs a turn.
      speak_during_execution: false,
      speak_after_execution: false,
      parameters: SAVE_LEAD_SCHEMA,
    },
  ],
  post_call_analysis_data: [
    { type: 'string', name: 'name', description: "The caller's full name." },
    { type: 'string', name: 'phone', description: 'Callback number.' },
    { type: 'string', name: 'address_line', description: 'Street address.' },
    { type: 'string', name: 'city', description: 'City.' },
    { type: 'string', name: 'zip', description: '5-digit ZIP.' },
    { type: 'string', name: 'problem', description: "The problem in the caller's words." },
    {
      type: 'enum',
      name: 'system_type',
      choices: ['furnace', 'air_conditioner', 'heat_pump', 'mini_split', 'boiler', 'water_heater', 'thermostat', 'other'],
      description: 'Type of system. Omit if never established.',
    },
    { type: 'number', name: 'system_age_years', description: 'Approximate age in years.' },
    {
      type: 'boolean',
      name: 'is_emergency',
      // The instruction that matters most. A model that guesses `false` here is how
      // a no-heat call in January gets queued for Tuesday.
      description:
        'True only if urgency was actually established. If the agent never asked, OMIT this ' +
        'field rather than answering false.',
    },
    { type: 'boolean', name: 'is_owner', description: 'True if they own the property. Omit if unknown.' },
    { type: 'boolean', name: 'is_commercial', description: 'True for a business. Omit if unknown.' },
  ],
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(config, null, 2))
} else {
  console.log(`
Retell agent configuration
==========================
Prompt fingerprint : ${config.prompt_fingerprint}
Agent webhook URL  : ${config.webhook_url}
Inbound webhook URL: ${config.inbound_webhook_url}

Dynamic variables the prompt expects (every one has a speakable fallback, so the
degraded path never reads braces out loud):
${config.dynamic_variables_supplied.map((v) => `  {{${v}}}  fallback: ${JSON.stringify(FALLBACK_VARIABLES[v] ?? '(computed)')}`).join('\n')}

Custom function: save_lead -> ${config.general_tools[0]!.url}
  speak_during_execution: false
  speak_after_execution:  false

Post-call analysis fields: ${config.post_call_analysis_data.map((f) => f.name).join(', ')}

--- PROMPT (paste into the agent) ------------------------------------------------
${config.general_prompt}
--------------------------------------------------------------------------------

Run with --json to get the whole thing as JSON.
`)
}
