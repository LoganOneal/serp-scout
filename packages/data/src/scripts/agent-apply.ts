/**
 * Write the integration fields this repo owns onto the live Retell agent.
 *
 *   pnpm voice:agent-apply
 *
 * ==================== ONLY TWO FIELDS ====================
 * `webhook_url` and `post_call_analysis_data`. Nothing else. The conversation --
 * nodes, instructions, edges, voice, model -- belongs to whoever built it in the
 * Retell UI, and a PATCH touching a Conversation Flow would replace hand-built
 * branching dialogue with a guess. The client enforces that allowlist too.
 *
 * The `save_lead` function is NOT applied here: a custom function only fires from
 * the nodes it is attached to, and choosing those nodes is a decision about the
 * conversation. `pnpm voice:agent-pull` prints what to create.
 * ========================================================
 *
 * Re-reads the agent afterwards rather than trusting the PATCH, so a green result
 * means Retell confirmed it -- not that we sent it.
 */
import 'dotenv/config'
import { closeDb, db } from '../db.js'
import { createVoiceProviders } from '../providers/voice.js'
import { liveCallsEnabled } from '../providers/index.js'
import { applyIntegration, publicBaseUrl } from '../voice/agents.js'
import { ANALYSIS_FIELDS } from '../voice/analysis-fields.js'

async function main(): Promise<void> {
  const agentId = process.argv.slice(2).find((a) => a.startsWith('agent_')) ?? process.env['RETELL_AGENT_ID']
  if (!agentId) {
    console.error('No agent id. Pass one, or set RETELL_AGENT_ID in .env.')
    process.exit(1)
  }

  if (!liveCallsEnabled()) {
    console.error(
      'LIVE_CALLS_ENABLED is not "true". This writes to a LIVE agent, so it refuses rather\n' +
        'than pretending to have applied anything.',
    )
    process.exit(1)
  }

  const base = publicBaseUrl()
  if (base === null) {
    console.error('PUBLIC_BASE_URL is not set, so there is no webhook URL to apply.')
    process.exit(1)
  }
  if (/localhost|127\.0\.0\.1/.test(base)) {
    // Refused rather than written: Retell cannot reach localhost, so this would set a
    // URL that silently never fires and read as configured.
    console.error(
      `PUBLIC_BASE_URL is ${base}, which Retell cannot reach. Point it at a tunnel or a\n` +
        'deployed host first -- writing it would look configured and never fire.',
    )
    process.exit(1)
  }

  console.log(`Applying to ${agentId}`)
  console.log(`  webhook_url              ${base}/api/retell/events`)
  console.log(`  post_call_analysis_data  ${ANALYSIS_FIELDS.length} fields`)

  const { applied, snapshot } = await applyIntegration(db(), {
    agentId,
    providers: createVoiceProviders(),
    analysisFields: [...ANALYSIS_FIELDS],
  })

  console.log(`\nApplied: ${applied.join(', ')}. Re-read from Retell to confirm:\n`)
  for (const c of snapshot.checks) {
    const mark =
      c.status === 'pass' ? 'ok  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'warn' : '?   '
    console.log(`  ${mark} ${c.label}`)
    console.log(`       ${c.detail}`)
    if (c.remedy) console.log(`       -> ${c.remedy}`)
  }

  const failing = snapshot.checks.filter((c) => c.status === 'fail')
  console.log(
    failing.length === 0
      ? '\nWiring complete.'
      : `\n${failing.length} issue(s) left. save_lead is expected here -- it has to be added in the flow.`,
  )

  await closeDb()
}

main().catch(async (e) => {
  console.error(`\nFailed: ${(e as Error).message}`)
  await closeDb()
  process.exit(1)
})
