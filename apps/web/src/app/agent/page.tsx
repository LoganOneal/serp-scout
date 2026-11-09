import {
  auditStored,
  createVoiceProviders,
  db,
  getStoredAgent,
  listStoredAgents,
  liveCallsEnabled,
  loadFleet,
  publicBaseUrl,
} from '@rnr/data'
import { AgentPanel, type AgentSummary } from '@/components/AgentPanel'
import { AgentFleet } from '@/components/AgentFleet'
import { applyIntegrationAction, pullAgentAction, uploadAgentJsonAction } from '@/app/agent/actions'

export const dynamic = 'force-dynamic'

/**
 * The voice agent connection page.
 *
 * One agent serves every site — per-site context comes from the inbound webhook
 * resolving the dialled number — so this is global rather than nested under a site.
 */
export default async function AgentPage() {
  const database = db()
  const envAgentId = process.env['RETELL_AGENT_ID'] ?? ''

  const agents = await listStoredAgents(database).catch(() => [])
  // Prefer the configured agent; otherwise the most recently read one.
  const row =
    (envAgentId ? await getStoredAgent(database, envAgentId).catch(() => null) : null) ??
    agents[0] ??
    null

  const stored: AgentSummary | null =
    row === null
      ? null
      : {
          agentId: row.agentId,
          agentName: row.agentName,
          responseEngineType: row.responseEngineType,
          conversationFlowId: row.conversationFlowId,
          version: row.version,
          isPublished: row.isPublished,
          voiceId: row.voiceId,
          nodeCount: row.nodeCount,
          toolNames: row.toolNames,
          webhookUrl: row.webhookUrl,
          pulledAt: row.pulledAt.toISOString(),
          source: row.source,
        }

  const storedChecks = row === null ? null : auditStored(row)
  const base = publicBaseUrl()

  /**
   * Never fatal to the page.
   *
   * The fleet needs two live Retell reads. A bad key or an outage must not take down the
   * pull/upload panel, which is how you diagnose a bad key.
   */
  const fleet = await loadFleet(database, createVoiceProviders()).catch(() => null)

  return (
    <div className="wrap">
      <h2>Voice agents</h2>
      <p className="sub">
        Per-site context — business name, hours, service area, dispatch fee — is injected at
        ring time by the inbound webhook resolving the dialled number, so agents never hold a
        market&rsquo;s details. What they do hold is the <strong>script</strong>, and that is
        per trade: a plumbing call cannot be served by a furnace script no matter how good the
        variables are. So there is one agent per trade, and this page is where you see all of
        them at once.
      </p>

      {fleet && <AgentFleet fleet={fleet} />}

      <div className="warnbox">
        <strong>Retell owns the conversation. This repo owns the wiring.</strong> Your agent is a
        visual Conversation Flow — nodes, instructions and branching built in the dashboard. Nothing
        here will overwrite it: the API client hard-rejects any field outside{' '}
        <code>webhook_url</code> and <code>post_call_analysis_data</code>, because a PATCH that
        touched a flow would replace hand-built dialogue with a guess and there is no undo.
      </div>

      <AgentPanel
        defaultAgentId={envAgentId || (stored?.agentId ?? '')}
        stored={stored}
        storedChecks={storedChecks}
        liveEnabled={liveCallsEnabled()}
        apiKeyConfigured={Boolean(process.env['RETELL_API_KEY'])}
        baseUrl={base}
        onPull={pullAgentAction}
        onUpload={uploadAgentJsonAction}
        onApply={applyIntegrationAction}
      />

      {/* --- The one thing that cannot be automated --------------------- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Adding save_lead yourself</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          This is the one fix left manual, and the reason is real: a custom function only fires
          from the nodes it is attached to. Guessing which of your nodes should call it would
          either do nothing or corrupt the flow, so it is your call — but it is also the difference
          between capturing a lead mid-call and losing it when the caller hangs up.
        </p>
        <div className="kv">
          <span>Name</span>
          <span className="mono">save_lead</span>
          <span>URL</span>
          <span className="mono" style={{ fontSize: 11.5 }}>
            {base ? `${base}/api/retell/tool/save-lead` : 'set PUBLIC_BASE_URL first'}
          </span>
          <span>Speak during execution</span>
          <span>
            <strong>off</strong>{' '}
            <span className="faint">
              — an agent narrating &ldquo;let me save that&rdquo; is a tell, and costs a turn
            </span>
          </span>
          <span>Speak after execution</span>
          <span>
            <strong>off</strong>
          </span>
          <span>Attach to</span>
          <span>
            the nodes where details land — Collect Contact Info, Collect Address and Authorization,
            Problem Description — so a hang-up mid-intake still leaves what was gathered
          </span>
          <span>Parameters</span>
          <span>
            run <span className="mono">pnpm voice:agent-config</span> for the JSON schema
          </span>
        </div>
      </div>

      {agents.length > 1 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Other agents read</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Engine</th>
                  <th className="num">Nodes</th>
                  <th>Webhook</th>
                  <th>Last read</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agentId}>
                    <td>
                      {a.agentName ?? '—'}
                      <div className="mono faint" style={{ fontSize: 11 }}>
                        {a.agentId}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {a.responseEngineType ?? '—'}
                    </td>
                    <td className="num">{a.nodeCount ?? '—'}</td>
                    <td>
                      {a.webhookUrl === null ? (
                        <span className="badge stop">none</span>
                      ) : (
                        <span className="badge go">set</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {a.pulledAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
