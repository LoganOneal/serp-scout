/**
 * Read the live Retell agent and audit the integration wiring.
 *
 *   pnpm voice:agent-pull
 *   pnpm voice:agent-pull agent_57f4e0346389a82e7b699a4fbf
 *   pnpm voice:agent-pull --json > agent.json
 *
 * This is the answer to "must I re-import after every change": no. The dashboard
 * stays the place you edit; this reads the result on demand and stores a snapshot so
 * drift is visible rather than discovered by a customer.
 */
import 'dotenv/config'
import { closeDb, db } from '../db.js'
import { createVoiceProviders } from '../providers/voice.js'
import { liveCallsEnabled } from '../providers/index.js'
import { publicBaseUrl, pullAgent } from '../voice/agents.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const agentId = args.find((a) => a.startsWith('agent_')) ?? process.env['RETELL_AGENT_ID']
  const asJson = args.includes('--json')

  if (!agentId) {
    console.error(
      'No agent id. Pass one, or set RETELL_AGENT_ID in .env.\n' +
        '  pnpm voice:agent-pull agent_57f4e0346389a82e7b699a4fbf',
    )
    process.exit(1)
  }

  if (!liveCallsEnabled()) {
    // Stated loudly rather than silently serving the fixture. Believing you have read
    // your live agent when you have not is worse than an error.
    console.error(
      'LIVE_CALLS_ENABLED is not "true", so this reads the OFFLINE FIXTURE, not Retell.\n' +
        'Set it in .env to read your real agent.\n',
    )
  }

  const snap = await pullAgent(db(), { agentId, providers: createVoiceProviders() })

  if (asJson) {
    console.log(JSON.stringify({ agent: snap.agent, flow: snap.flow, checks: snap.checks }, null, 2))
    await closeDb()
    return
  }

  const a = snap.agent
  console.log(`\n${a.agentName ?? a.agentId}`)
  console.log(`  id       ${a.agentId}`)
  console.log(`  engine   ${a.responseEngineType}${a.conversationFlowId ? ` (${a.conversationFlowId})` : ''}`)
  console.log(`  version  ${a.version ?? '?'}${a.isPublished === false ? ' -- NOT PUBLISHED' : ''}`)
  console.log(`  voice    ${a.voiceId ?? '-'}`)
  if (snap.flow) {
    console.log(`  flow     ${snap.flow.nodeCount} nodes, model ${snap.flow.modelChoice ?? '?'}`)
    console.log(`  tools    ${snap.flow.toolNames.join(', ') || '(none)'}`)
  }
  console.log(`  webhook  ${a.webhookUrl ?? '(not set)'}`)
  console.log(`  base url ${publicBaseUrl() ?? '(PUBLIC_BASE_URL unset)'}`)

  console.log('\nIntegration checks')
  for (const c of snap.checks) {
    const mark = c.status === 'pass' ? 'ok  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'warn' : '?   '
    console.log(`  ${mark} ${c.label}`)
    console.log(`       ${c.detail}`)
    if (c.remedy) console.log(`       -> ${c.remedy}`)
  }

  const failing = snap.checks.filter((c) => c.status === 'fail')
  console.log(
    failing.length === 0
      ? '\nWiring is complete.'
      : `\n${failing.length} blocking issue(s). Fix them at /agent, or in the Retell dashboard.`,
  )

  await closeDb()
}

main().catch(async (e) => {
  console.error(`\nFailed: ${(e as Error).message}`)
  await closeDb()
  process.exit(1)
})
