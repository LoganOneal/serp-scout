/**
 * Point the agent's custom-function URLs at PUBLIC_BASE_URL.
 *
 *   pnpm voice:retarget-tools            # show what would change
 *   pnpm voice:retarget-tools --confirm  # apply
 *
 * ==================== THE GAP THIS CLOSES ====================
 * `pnpm voice:agent-apply` moves `webhook_url`, which is an AGENT field. The `save_lead`
 * URL is not: it lives on the conversation flow's tools, so moving hosts used to leave it
 * pointing at the old tunnel.
 *
 * That failure is invisible from every screen. The agent still answers, still collects a
 * name and a problem, still says someone will call back -- and the POST goes to a dead
 * host, so no lead row exists and no text is sent. The call looks successful in Retell and
 * the CRM shows nothing.
 *
 * Only the `url` string changes, and only on tools that already point at this repo's own
 * endpoints. Everything else on the tool -- name, description, parameters, speak settings --
 * is left byte-identical, and the flow's nodes are never sent at all.
 */
import 'dotenv/config'
import { RetellClient } from '../providers/retell/client.js'
import { publicBaseUrl } from '../voice/agents.js'
import { liveCallsEnabled } from '../providers/index.js'

const CONFIRM = process.argv.includes('--confirm')

/** Paths this repo serves. A tool pointing at one of these is ours to retarget. */
const OWNED_PATHS = ['/api/retell/tool/save-lead', '/api/retell/events']

function main(): Promise<void> {
  return run()
}

async function run(): Promise<void> {
  const apiKey = process.env['RETELL_API_KEY']
  const agentId = process.env['RETELL_AGENT_ID']
  if (!apiKey || !agentId) {
    console.error('RETELL_API_KEY and RETELL_AGENT_ID must both be set.')
    process.exit(1)
  }

  const base = publicBaseUrl()
  if (base === null) {
    console.error('PUBLIC_BASE_URL is not set, so there is no URL to point at.')
    process.exit(1)
  }
  if (/localhost|127\.0\.0\.1/.test(base)) {
    // Refused rather than written: Retell cannot reach localhost, so this would set a URL
    // that never fires and read as configured.
    console.error(`PUBLIC_BASE_URL is ${base}, which Retell cannot reach. Refusing.`)
    process.exit(1)
  }
  if (CONFIRM && !liveCallsEnabled()) {
    console.error('LIVE_CALLS_ENABLED is not "true". This writes to a LIVE agent, so it refuses.')
    process.exit(1)
  }

  const client = new RetellClient(apiKey)
  const agent = (await client.getAgent(agentId)) as Record<string, unknown>
  const engine = agent['response_engine'] as Record<string, unknown> | undefined
  const flowId = engine?.['conversation_flow_id']

  if (engine?.['type'] !== 'conversation-flow' || typeof flowId !== 'string') {
    console.error(
      `Agent ${agentId} is not a conversation-flow agent (type ${String(engine?.['type'])}), ` +
        'so it has no flow tools to retarget.',
    )
    process.exit(1)
  }

  const flow = (await client.getConversationFlow(flowId)) as Record<string, unknown>
  const tools = flow['tools']
  if (!Array.isArray(tools) || tools.length === 0) {
    console.error(`Flow ${flowId} has no tools. Nothing to retarget.`)
    process.exit(1)
  }

  console.log(`agent ${agentId}`)
  console.log(`flow  ${flowId} (version ${String(flow['version'])})`)
  console.log(`base  ${base}\n`)

  let changes = 0
  const next = tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool
    const t = tool as Record<string, unknown>
    const url = t['url']
    const name = String(t['name'] ?? '(unnamed)')
    if (typeof url !== 'string') {
      console.log(`  ${name}: no url field, left alone`)
      return tool
    }

    const owned = OWNED_PATHS.find((p) => url.endsWith(p))
    if (owned === undefined) {
      // A third-party webhook must not be rewritten to point at this app.
      console.log(`  ${name}: ${url}\n      NOT one of this repo's endpoints -- left alone`)
      return tool
    }

    const target = `${base}${owned}`
    if (url === target) {
      console.log(`  ${name}: already ${target}`)
      return tool
    }
    console.log(`  ${name}:\n      ${url}\n   -> ${target}`)
    changes += 1
    return { ...t, url: target }
  })

  if (changes === 0) {
    console.log('\nNothing to change.')
    return
  }

  if (!CONFIRM) {
    console.log(`\n${changes} URL(s) would change. Re-run with --confirm.`)
    return
  }

  await client.updateConversationFlowTools(flowId, next)

  /**
   * Re-read rather than trust the PATCH.
   *
   * A green line here means Retell confirmed the value, not that a request was accepted --
   * the same discipline as agent-apply. This also proves the nodes survived: if a partial
   * update had wiped them, the re-read would come back without them.
   */
  const after = (await client.getConversationFlow(flowId)) as Record<string, unknown>
  const afterTools = (after['tools'] ?? []) as Array<Record<string, unknown>>
  const afterNodes = (after['nodes'] ?? []) as unknown[]
  const beforeNodes = (flow['nodes'] ?? []) as unknown[]

  console.log('\nConfirmed by re-reading:')
  for (const t of afterTools) {
    if (typeof t['url'] === 'string') console.log(`  ${String(t['name'])}  ${t['url']}`)
  }
  console.log(
    `  nodes: ${beforeNodes.length} before, ${afterNodes.length} after` +
      (beforeNodes.length === afterNodes.length ? ' (unchanged)' : '  <-- MISMATCH, investigate'),
  )

  if (after['is_published'] === false) {
    console.log(
      '\nNOTE: this flow version is not published. Publish it in the Retell dashboard, or\n' +
        'inbound calls may be served by an older version that still has the old URLs.',
    )
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
