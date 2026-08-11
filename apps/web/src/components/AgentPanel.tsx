'use client'

import { useRef, useState, useTransition } from 'react'
import type { AgentCheck } from '@rnr/core'

/**
 * Connect and audit the Retell agent.
 *
 * Two ways in, deliberately:
 *   Pull   -- reads the live agent over the API. The answer to "do I have to import
 *             it every time I change something": no.
 *   Import -- accepts an exported JSON, for pinning a version or working before
 *             credentials exist. Labelled as a snapshot of a FILE, because a stale
 *             export looks exactly like a current one.
 */

export interface AgentSummary {
  agentId: string
  agentName: string | null
  responseEngineType: string | null
  conversationFlowId: string | null
  version: number | null
  isPublished: boolean | null
  voiceId: string | null
  nodeCount: number | null
  toolNames: string[] | null
  webhookUrl: string | null
  pulledAt: string
  source: string
}

export interface ActionResult {
  ok: boolean
  detail: string
  checks?: AgentCheck[]
  agentName?: string | null
  source?: 'api' | 'upload'
}

export function AgentPanel({
  defaultAgentId,
  stored,
  storedChecks,
  liveEnabled,
  apiKeyConfigured,
  baseUrl,
  onPull,
  onUpload,
  onApply,
}: {
  defaultAgentId: string
  stored: AgentSummary | null
  storedChecks: AgentCheck[] | null
  liveEnabled: boolean
  apiKeyConfigured: boolean
  baseUrl: string | null
  onPull: (agentId: string) => Promise<ActionResult>
  onUpload: (raw: string) => Promise<ActionResult>
  onApply: (agentId: string) => Promise<ActionResult>
}) {
  const [agentId, setAgentId] = useState(defaultAgentId)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [raw, setRaw] = useState('')
  const [pending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  // Prefer the freshest audit: whatever the last action returned, else the stored one.
  const checks = result?.checks ?? storedChecks ?? null

  const run = (fn: () => Promise<ActionResult>) => {
    setResult(null)
    startTransition(async () => setResult(await fn()))
  }

  const onFile = (file: File | undefined) => {
    if (!file) return
    void file.text().then((text) => {
      setRaw(text)
      run(() => onUpload(text))
    })
  }

  const failing = checks?.filter((c) => c.status === 'fail') ?? []
  const autoFixable = failing.filter((c) => c.autoFixable)
  const receivesNothing = failing.some((c) => c.id === 'webhook_url')

  return (
    <>
      {/* --- Connect ---------------------------------------------------- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Connect to Retell</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Pull reads the agent over the API, so the dashboard stays the place you edit and this
          just reads the result. <strong>No re-importing after every change.</strong>
        </p>

        <div className="flex" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="dim" style={{ fontSize: 12 }}>
              Agent ID
            </span>
            <input
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agent_..."
              className="mono"
              autoComplete="off"
            />
          </label>
          <button
            className="primary"
            disabled={pending || !apiKeyConfigured}
            onClick={() => run(() => onPull(agentId))}
          >
            {pending ? 'Working…' : 'Pull from Retell'}
          </button>
        </div>

        {!apiKeyConfigured && (
          <div className="disabled-reason">RETELL_API_KEY is not set in .env.</div>
        )}
        {apiKeyConfigured && !liveEnabled && (
          <div className="disabled-reason">
            <code>LIVE_CALLS_ENABLED</code> is not the string <code>true</code>, so a pull returns
            the <strong>offline fixture</strong> rather than your live agent. That is stated on the
            result rather than hidden, because otherwise you would believe you had read Retell.
          </div>
        )}
      </div>

      {/* --- Import JSON ------------------------------------------------ */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Import agent JSON</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Accepts a bare agent export, or <code>{'{ "agent": {…}, "flow": {…} }'}</code>. Useful
          for pinning a known-good version. It is a snapshot of a <strong>file</strong>, not a
          reading of Retell — if the agent changed since the export, these checks describe the
          export.
        </p>

        <div className="flex" style={{ marginBottom: 8 }}>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>

        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={5}
          placeholder='{ "agent_id": "agent_...", ... }'
          className="mono"
          style={{ width: '100%', fontSize: 11.5 }}
        />
        <div className="flex" style={{ marginTop: 8 }}>
          <button disabled={pending || raw.trim() === ''} onClick={() => run(() => onUpload(raw))}>
            {pending ? 'Working…' : 'Import JSON'}
          </button>
          <button
            type="button"
            disabled={pending || raw === ''}
            onClick={() => {
              setRaw('')
              if (fileRef.current) fileRef.current.value = ''
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {result && (
        <div className={result.ok ? 'okbox' : 'stopbox'} style={{ marginBottom: 18 }}>
          {result.detail}
        </div>
      )}

      {/* --- What Retell holds ------------------------------------------ */}
      {stored && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>What Retell holds</h3>
          <div className="kv">
            <span>Agent</span>
            <span>
              {stored.agentName ?? '—'}{' '}
              <span className="mono faint" style={{ fontSize: 11 }}>
                {stored.agentId}
              </span>
            </span>
            <span>Engine</span>
            <span>
              <span className="mono">{stored.responseEngineType ?? '—'}</span>
              {stored.responseEngineType === 'conversation-flow' && (
                <span className="faint">
                  {' '}
                  — a visual flow, so there is no single prompt to overwrite
                </span>
              )}
            </span>
            {stored.nodeCount !== null && (
              <>
                <span>Flow</span>
                <span>
                  {stored.nodeCount} nodes{' '}
                  <span className="mono faint" style={{ fontSize: 11 }}>
                    {stored.conversationFlowId}
                  </span>
                </span>
              </>
            )}
            <span>Custom functions</span>
            <span>
              {stored.toolNames === null || stored.toolNames.length === 0 ? (
                <span className="badge stop">none</span>
              ) : (
                <span className="mono">{stored.toolNames.join(', ')}</span>
              )}
            </span>
            <span>Voice</span>
            <span className="mono">{stored.voiceId ?? '—'}</span>
            <span>Version</span>
            <span>
              {stored.version ?? '—'}{' '}
              {stored.isPublished === false && <span className="badge warn">not published</span>}
              {stored.isPublished === true && <span className="badge go">published</span>}
            </span>
            <span>Webhook URL</span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              {stored.webhookUrl ?? <span className="badge stop">not set</span>}
            </span>
            <span>Last read</span>
            <span>
              <span className="mono">{stored.pulledAt.slice(0, 16).replace('T', ' ')}</span>{' '}
              <span className={`badge ${stored.source === 'api' ? 'neutral' : 'warn'}`}>
                {stored.source === 'api' ? 'from API' : 'from uploaded file'}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* --- Audit ------------------------------------------------------ */}
      {checks && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Integration checks</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            These check <strong>only the wiring this repo owns</strong> — where webhooks go, the{' '}
            <code>save_lead</code> function, analysis fields. Nothing here is an opinion about your
            script: the conversation belongs to whoever built it in Retell.
          </p>

          {receivesNothing && (
            <div className="stopbox" style={{ marginBottom: 12 }}>
              <strong>As configured, this CRM would record nothing at all.</strong> With no agent
              webhook URL, calls happen and no row ever appears — which looks exactly like nobody
              having called.
            </div>
          )}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Now</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td>
                      <span className={`badge ${toneFor(c.status)}`}>{c.status}</span>
                    </td>
                    <td style={{ fontSize: 12, maxWidth: 380 }}>{c.detail}</td>
                    <td style={{ fontSize: 12, maxWidth: 340 }}>
                      {c.remedy ?? <span className="null">—</span>}
                      {c.remedy && !c.autoFixable && c.status === 'fail' && (
                        <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
                          manual — not safe to automate
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {autoFixable.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <button
                className="primary"
                disabled={pending || !liveEnabled}
                onClick={() => run(() => onApply(stored?.agentId ?? agentId))}
              >
                {pending ? 'Applying…' : `Apply ${autoFixable.length} automatic fix(es)`}
              </button>
              <p className="faint" style={{ fontSize: 11.5, marginTop: 6, marginBottom: 0 }}>
                Writes <code>webhook_url</code>
                {baseUrl && (
                  <>
                    {' '}
                    (<span className="mono">{baseUrl}/api/retell/events</span>)
                  </>
                )}{' '}
                and <code>post_call_analysis_data</code>, then re-reads the agent to confirm it
                landed. <strong>It never touches your conversation flow</strong> — the API client
                rejects any other field.
              </p>
              {!liveEnabled && (
                <div className="disabled-reason">
                  Refused in fixture mode: this changes a live agent, so it will not pretend.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function toneFor(status: string): string {
  if (status === 'pass') return 'go'
  if (status === 'warn') return 'warn'
  if (status === 'fail') return 'stop'
  return 'unknown'
}
