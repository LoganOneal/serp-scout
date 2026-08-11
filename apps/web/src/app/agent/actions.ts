'use server'

import { revalidatePath } from 'next/cache'
import type { AgentCheck } from '@rnr/core'
import {
  ANALYSIS_FIELDS,
  applyIntegration,
  createVoiceProviders,
  db,
  ingestAgentJson,
  liveCallsEnabled,
  pullAgent,
} from '@rnr/data'

/**
 * Agent connection actions.
 *
 * All three answer "what does Retell hold right now", never "what do we wish it
 * held". Failures come back as values so the page can render them; a thrown error
 * here would blank the screen and lose the audit that was already on it.
 */

export interface AgentActionResult {
  ok: boolean
  detail: string
  checks?: AgentCheck[]
  agentName?: string | null
  source?: 'api' | 'upload'
}

const AGENT_ID_RE = /^agent_[A-Za-z0-9]+$/

/** Pull the live config. This is the "no more importing" path. */
export async function pullAgentAction(agentId: string): Promise<AgentActionResult> {
  const id = agentId.trim()
  if (!AGENT_ID_RE.test(id)) {
    return {
      ok: false,
      detail: `"${id}" is not an agent id. They look like agent_57f4e0346389a82e7b699a4fbf — copy it from the dashboard URL.`,
    }
  }

  if (!process.env['RETELL_API_KEY']) {
    return { ok: false, detail: 'RETELL_API_KEY is not set, so the Retell API cannot be called.' }
  }

  if (!liveCallsEnabled()) {
    // Honest about what is being shown. Silently serving the fixture here would let
    // someone believe they had read their live agent when they had not.
    const providers = createVoiceProviders()
    try {
      const snap = await pullAgent(db(), { agentId: id, providers })
      return {
        ok: true,
        source: 'api',
        agentName: snap.agent.agentName,
        checks: snap.checks,
        detail:
          'LIVE_CALLS_ENABLED is not "true", so this is the OFFLINE FIXTURE, not your live ' +
          'agent. Set it to true in .env to read Retell for real.',
      }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  try {
    const snap = await pullAgent(db(), { agentId: id, providers: createVoiceProviders() })
    revalidatePath('/agent')
    return {
      ok: true,
      source: 'api',
      agentName: snap.agent.agentName,
      checks: snap.checks,
      detail:
        `Pulled "${snap.agent.agentName ?? id}" — ${snap.agent.responseEngineType}` +
        (snap.flow ? `, ${snap.flow.nodeCount} nodes` : '') +
        `, version ${snap.agent.version ?? '?'}.`,
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

/** Accept a pasted or uploaded agent JSON. */
export async function uploadAgentJsonAction(raw: string): Promise<AgentActionResult> {
  if (raw.trim() === '') return { ok: false, detail: 'Nothing to import — paste or choose a file.' }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return { ok: false, detail: `That is not valid JSON: ${(e as Error).message}` }
  }

  try {
    const snap = await ingestAgentJson(db(), { json })
    revalidatePath('/agent')
    return {
      ok: true,
      source: 'upload',
      agentName: snap.agent.agentName,
      checks: snap.checks,
      detail:
        `Imported "${snap.agent.agentName ?? snap.agent.agentId}" from JSON. ` +
        'Remember this is a snapshot of a FILE, not a reading of Retell — if the agent has ' +
        'changed since the export, these checks describe the export.',
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

/**
 * Write the two integration fields this repo owns.
 *
 * Never the conversation. `save_lead` is excluded on purpose: a custom function has
 * to be attached to specific flow nodes to ever fire, and picking those nodes is a
 * decision about the script.
 */
export async function applyIntegrationAction(agentId: string): Promise<AgentActionResult> {
  const id = agentId.trim()
  if (!AGENT_ID_RE.test(id)) return { ok: false, detail: 'Pull an agent first.' }

  if (!liveCallsEnabled()) {
    return {
      ok: false,
      detail:
        'LIVE_CALLS_ENABLED is not "true", so nothing was sent to Retell. This action changes ' +
        'a live agent, so it deliberately refuses in fixture mode rather than pretending.',
    }
  }

  try {
    const { applied, snapshot } = await applyIntegration(db(), {
      agentId: id,
      providers: createVoiceProviders(),
      // ANALYSIS_FIELDS is `as const` so the descriptions cannot be edited by
      // accident; copied to a mutable array only at the boundary.
      analysisFields: [...ANALYSIS_FIELDS],
    })
    revalidatePath('/agent')
    return {
      ok: true,
      source: 'api',
      agentName: snapshot.agent.agentName,
      checks: snapshot.checks,
      detail:
        `Applied ${applied.join(' and ')}, then re-read the agent to confirm. ` +
        'The save_lead function is still yours to add — see the remedy below.',
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}
