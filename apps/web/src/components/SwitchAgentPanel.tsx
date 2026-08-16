'use client'

import { useEffect, useState, useTransition } from 'react'
import type { AgentCheck } from '@rnr/core'

/**
 * Point this site's number at a different Retell agent.
 *
 * The control is a dropdown and a confirm, but the substance is the PREFLIGHT between
 * them: switching a live line to an agent with no webhook produces calls that happen
 * and a CRM that stays empty, and switching to one with no save_lead produces an agent
 * that answers perfectly and captures nothing. Neither is visible from any screen
 * afterwards, so both are shown here, before, with what they would cost.
 */

export interface LiveAgentOption {
  agentId: string
  agentName: string | null
  responseEngineType: string
  version: number | null
  publishedVersion: number | null
  isPublished: boolean | null
}

interface Blocker {
  id: string
  detail: string
  consequence: string
}

interface Preflight {
  targetAgentId: string
  targetAgentName: string | null
  currentAgentId: string | null
  phoneNumber: string | null
  numberIsImported: boolean
  checks: AgentCheck[]
  blockers: Blocker[]
}

export function SwitchAgentPanel({
  siteId,
  currentAgentId,
  previousAgentId,
  onList,
  onPreflight,
  onSwitch,
  onSwitchBack,
}: {
  siteId: number
  currentAgentId: string | null
  previousAgentId: string | null
  onList: () => Promise<{ ok: boolean; detail?: string; agents: LiveAgentOption[] }>
  onPreflight: (
    siteId: number,
    agentId: string,
  ) => Promise<{ ok: boolean; detail?: string; preflight?: unknown }>
  onSwitch: (fd: FormData) => Promise<{ ok: boolean; detail: string }>
  onSwitchBack: (siteId: number) => Promise<{ ok: boolean; detail: string }>
}) {
  const [agents, setAgents] = useState<LiveAgentOption[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [pre, setPre] = useState<Preflight | null>(null)
  const [preError, setPreError] = useState<string | null>(null)
  const [override, setOverride] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [pending, startTransition] = useTransition()

  // Load the account's agents once, on mount. Read-only, so there is no reason to
  // make someone press a button to find out what they have.
  useEffect(() => {
    let live = true
    void onList().then((r) => {
      if (!live) return
      setAgents(r.agents)
      setListError(r.ok ? (r.detail ?? null) : (r.detail ?? 'Could not read your agents.'))
    })
    return () => {
      live = false
    }
  }, [onList])

  const choose = (agentId: string) => {
    setTarget(agentId)
    setPre(null)
    setPreError(null)
    setResult(null)
    setOverride(false)
    if (agentId === '') return
    startTransition(async () => {
      const r = await onPreflight(siteId, agentId)
      if (r.ok) setPre(r.preflight as Preflight)
      else setPreError(r.detail ?? 'Preflight failed.')
    })
  }

  const submit = (fd: FormData) => {
    setResult(null)
    fd.set('siteId', String(siteId))
    fd.set('targetAgentId', target)
    startTransition(async () => setResult(await onSwitch(fd)))
  }

  const hardBlockers = pre?.blockers.filter((b) => b.id !== 'unpublished') ?? []
  const advisories = pre?.blockers.filter((b) => b.id === 'unpublished') ?? []
  const selectable = (agents ?? []).filter((a) => a.agentId !== currentAgentId)

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Switch agent</h3>

      <div className="kv" style={{ marginBottom: 14 }}>
        <span>Answering now</span>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {currentAgentId ?? <span className="faint">none bound</span>}
        </span>
      </div>

      {listError && <div className="disabled-reason">{listError}</div>}

      <label style={{ display: 'block' }}>
        <span>Switch to</span>
        <select value={target} onChange={(e) => choose(e.target.value)} disabled={pending}>
          <option value="">
            {agents === null ? 'Reading your Retell account…' : 'Pick an agent…'}
          </option>
          {selectable.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.agentName ?? a.agentId} — {a.responseEngineType} v{a.version ?? '?'}
              {a.publishedVersion === null ? ' (never published)' : ` (published v${a.publishedVersion})`}
            </option>
          ))}
        </select>
        <em>
          Built in the Retell dashboard. This never edits the conversation — it only changes
          which agent the number reaches.
        </em>
      </label>

      {preError && <div className="disabled-reason">{preError}</div>}

      {pre && (
        <div style={{ marginTop: 14 }}>
          <div className="kv">
            <span>Number</span>
            <span className="mono">
              {pre.phoneNumber ?? <span className="faint">none on this site</span>}
              {pre.phoneNumber !== null && !pre.numberIsImported && (
                <span className="badge warn" style={{ marginLeft: 8 }}>
                  not imported
                </span>
              )}
            </span>
            <span>Checks</span>
            <span>
              {pre.checks.map((c) => (
                <span
                  key={c.id}
                  className={`badge ${c.status === 'pass' ? 'go' : c.status === 'fail' ? 'stop' : 'warn'}`}
                  style={{ marginRight: 6 }}
                  title={c.detail}
                >
                  {c.label}
                </span>
              ))}
            </span>
          </div>

          {hardBlockers.length > 0 && (
            <div className="warnbox" style={{ marginTop: 12 }}>
              <strong>This agent is not ready to answer a live line.</strong>
              <ul style={{ marginBottom: 0 }}>
                {hardBlockers.map((b) => (
                  <li key={b.id}>
                    {b.detail} <span className="faint">{b.consequence}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {advisories.map((b) => (
            <div key={b.id} className="disabled-reason" style={{ marginTop: 12 }}>
              {b.detail} {b.consequence}
            </div>
          ))}

          <form action={submit} style={{ marginTop: 12 }}>
            {hardBlockers.length > 0 && (
              <label className="flex" style={{ alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <input
                  type="checkbox"
                  name="override"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                <span>
                  Switch anyway. I accept {hardBlockers.map((b) => b.id).join(' and ')} on a number
                  customers can dial.
                </span>
              </label>
            )}
            <button
              className="primary"
              type="submit"
              disabled={pending || (hardBlockers.length > 0 && !override)}
            >
              {pending ? 'Switching…' : `Switch to ${pre.targetAgentName ?? pre.targetAgentId}`}
            </button>
          </form>
        </div>
      )}

      {result && (
        <div className={result.ok ? 'okbox' : 'disabled-reason'} style={{ marginTop: 12 }}>
          {result.detail}
        </div>
      )}

      {/* Rollback stays available for as long as a previous agent is recorded. The old
          agent is not deleted by a switch, so going back is a PATCH, not a rebuild. */}
      {previousAgentId !== null && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <span className="faint" style={{ fontSize: 13 }}>
            Previously <span className="mono">{previousAgentId}</span>. It is still live in Retell —
            a switch never deletes it.
          </span>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() =>
                startTransition(async () => setResult(await onSwitchBack(siteId)))
              }
            >
              Switch back
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
