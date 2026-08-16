'use client'

import { useEffect, useState, useTransition } from 'react'
import type { LiveAgentOption } from '@/components/SwitchAgentPanel'

/**
 * Voice setup, as a sequence you can leave and come back to.
 *
 * The step statuses arrive already computed from stored state -- there is no cursor
 * here and nothing is remembered between visits. A step that was completed and then
 * undone goes back to incomplete by itself, which a remembered position could not do.
 */

export interface WizardStepView {
  id: string
  title: string
  status: 'done' | 'current' | 'blocked' | 'todo' | 'skipped'
  detail: string
  action: string | null
}

export interface WizardView {
  siteId: number
  agentId: string | null
  agentName: string | null
  responseEngineType: string | null
  steps: WizardStepView[]
  currentStepId: string | null
  complete: boolean
}

interface Inspection {
  phoneNumber: string
  agentId: string | null
  friendlyName: string | null
  voiceUrl: string | null
  trunkSid: string | null
  wouldBreakExistingRouting: boolean
  alreadyOnTrunk: boolean
  disasterRecoveryUrl: string | null
  originationUris: string[]
  inboundWebhookUrl: string | null
  blockers: Array<{ id: string; detail: string }>
}

type Result = { ok: boolean; detail: string } | null

const MARK: Record<WizardStepView['status'], string> = {
  done: '✓',
  current: '▸',
  blocked: '!',
  todo: '·',
  skipped: '—',
}

export function SetupWizard({
  view,
  trackingNumber,
  toolUrl,
  onList,
  onAdopt,
  onApplyIntegration,
  onRecheck,
  onInspectProvisioning,
  onApplyProvisioning,
}: {
  view: WizardView
  trackingNumber: string | null
  toolUrl: string
  onList: () => Promise<{ ok: boolean; detail?: string; agents: LiveAgentOption[] }>
  onAdopt: (fd: FormData) => Promise<{ ok: boolean; detail: string }>
  onApplyIntegration: (siteId: number) => Promise<{ ok: boolean; detail: string }>
  onRecheck: (siteId: number) => Promise<{ ok: boolean; detail: string }>
  onInspectProvisioning: (
    siteId: number,
    number: string,
  ) => Promise<{ ok: boolean; detail?: string; inspection?: unknown }>
  onApplyProvisioning: (fd: FormData) => Promise<{ ok: boolean; detail: string }>
}) {
  const [agents, setAgents] = useState<LiveAgentOption[] | null>(null)
  const [listNote, setListNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<Result>(null)
  const [inspection, setInspection] = useState<Inspection | null>(null)

  const needsAgent = view.agentId === null

  useEffect(() => {
    if (!needsAgent) return
    let live = true
    void onList().then((r) => {
      if (!live) return
      setAgents(r.agents)
      setListNote(r.detail ?? null)
    })
    return () => {
      live = false
    }
  }, [needsAgent, onList])

  const run = (fn: () => Promise<{ ok: boolean; detail: string }>) => {
    setResult(null)
    startTransition(async () => setResult(await fn()))
  }

  // Wrapped rather than passed straight to <form action>: a form action must return
  // void, and the result is what the operator needs to see.
  const adopt = (fd: FormData) => {
    fd.set('siteId', String(view.siteId))
    run(() => onAdopt(fd))
  }

  const inspect = () => {
    if (trackingNumber === null) return
    setResult(null)
    startTransition(async () => {
      const r = await onInspectProvisioning(view.siteId, trackingNumber)
      if (r.ok) setInspection(r.inspection as Inspection)
      else setResult({ ok: false, detail: r.detail ?? 'Could not inspect.' })
    })
  }

  const step = (id: string) => view.steps.find((s) => s.id === id)!

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        Voice setup {view.complete && <span className="badge go">complete</span>}
      </h3>

      <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 4px' }}>
        {view.steps.map((s) => (
          <li
            key={s.id}
            style={{
              padding: '9px 0',
              borderTop: '1px solid var(--border)',
              opacity: s.status === 'todo' ? 0.55 : 1,
            }}
          >
            <div className="flex" style={{ alignItems: 'baseline', gap: 10 }}>
              <span
                className="mono"
                style={{
                  width: 14,
                  color:
                    s.status === 'done'
                      ? 'var(--go)'
                      : s.status === 'current'
                        ? 'var(--text)'
                        : 'var(--text-faint)',
                }}
              >
                {MARK[s.status]}
              </span>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: 13.5 }}>{s.title}</strong>
                <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {s.detail}
                </div>
                {s.status === 'current' && s.action !== null && (
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>{s.action}</div>
                )}

                {/* --- The control for whichever step is current ---------- */}
                {s.status === 'current' && s.id === 'pick' && (
                  <form action={adopt} style={{ marginTop: 8 }}>
                    {listNote && <div className="disabled-reason">{listNote}</div>}
                    <select name="agentId" disabled={pending} defaultValue="">
                      <option value="">
                        {agents === null ? 'Reading your Retell account…' : 'Pick an agent…'}
                      </option>
                      {(agents ?? []).map((a) => (
                        <option key={a.agentId} value={a.agentId}>
                          {a.agentName ?? a.agentId} — {a.responseEngineType} v{a.version ?? '?'}
                        </option>
                      ))}
                    </select>
                    <label className="flex" style={{ alignItems: 'center', gap: 8, margin: '8px 0' }}>
                      <input type="checkbox" name="override" />
                      <span className="faint" style={{ fontSize: 12.5 }}>
                        Bind even if its webhook does not point here yet
                      </span>
                    </label>
                    <button className="primary" type="submit" disabled={pending}>
                      {pending ? 'Binding…' : 'Bind this agent'}
                    </button>
                  </form>
                )}

                {s.status === 'current' && (s.id === 'audit' || s.id === 'save_lead') && (
                  <div style={{ marginTop: 8 }}>
                    {s.id === 'save_lead' && (
                      <div className="kv" style={{ marginBottom: 10 }}>
                        <span>Name</span>
                        <span className="mono">save_lead</span>
                        <span>URL</span>
                        <span className="mono" style={{ fontSize: 11.5 }}>
                          {toolUrl}
                        </span>
                        <span>Speak during / after</span>
                        <span>
                          <strong>both off</strong>{' '}
                          <span className="faint">— it fires inside the caller&rsquo;s turn</span>
                        </span>
                        <span>Parameters</span>
                        <span>
                          <code>pnpm voice:agent-config</code> prints the JSON schema
                        </span>
                      </div>
                    )}
                    <button
                      className="btn"
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => onRecheck(view.siteId))}
                    >
                      {pending ? 'Reading…' : 'Re-check from Retell'}
                    </button>
                  </div>
                )}

                {s.status === 'current' && s.id === 'fix' && (
                  <button
                    className="primary"
                    type="button"
                    style={{ marginTop: 8 }}
                    disabled={pending}
                    onClick={() => run(() => onApplyIntegration(view.siteId))}
                  >
                    {pending ? 'Applying…' : 'Apply webhook + analysis fields'}
                  </button>
                )}

                {s.status === 'current' && s.id === 'number' && trackingNumber !== null && (
                  <div style={{ marginTop: 8 }}>
                    {inspection === null ? (
                      <button className="btn" type="button" disabled={pending} onClick={inspect}>
                        {pending ? 'Checking…' : `Check what would change for ${trackingNumber}`}
                      </button>
                    ) : (
                      <ProvisionPreview
                        inspection={inspection}
                        siteId={view.siteId}
                        pending={pending}
                        onApply={(fd) => run(() => onApplyProvisioning(fd))}
                      />
                    )}
                  </div>
                )}

                {s.status === 'current' && s.id === 'prove' && (
                  <div style={{ marginTop: 8 }} className="mono">
                    {trackingNumber ?? '—'}
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {result && (
        <div className={result.ok ? 'okbox' : 'disabled-reason'} style={{ marginTop: 10 }}>
          {result.detail}
        </div>
      )}

      {view.complete && (
        <div className="okbox" style={{ marginTop: 10 }}>
          Setup is complete and a real call has landed. Everything past this point — script,
          voice, wording — is tuned in the Retell dashboard; {step('bind').detail}
        </div>
      )}
    </div>
  )
}

/**
 * The dry run, rendered.
 *
 * Shows what the number does TODAY before offering the button that stops it doing that.
 * This is the CLI's `--confirm` gate; the whole point is that you read the current
 * configuration first.
 */
function ProvisionPreview({
  inspection,
  siteId,
  pending,
  onApply,
}: {
  inspection: Inspection
  siteId: number
  pending: boolean
  onApply: (fd: FormData) => void
}) {
  return (
    <div>
      <div className="kv">
        <span>Friendly name</span>
        <span>{inspection.friendlyName ?? '—'}</span>
        <span>Voice URL today</span>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {inspection.voiceUrl ?? '— none —'}
        </span>
        <span>On a trunk</span>
        <span>{inspection.alreadyOnTrunk ? 'yes, this one' : (inspection.trunkSid ?? 'no')}</span>
        <span>Disaster recovery</span>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {inspection.disasterRecoveryUrl ?? '— NOT SET —'}
        </span>
        <span>Origination</span>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {inspection.originationUris.join(', ') || '— none —'}
        </span>
        <span>Will answer with</span>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {inspection.agentId ?? '—'}
        </span>
      </div>

      {inspection.wouldBreakExistingRouting && (
        <div className="warnbox" style={{ marginTop: 10 }}>
          <strong>This number answers via Programmable Voice today.</strong> Attaching it to
          the trunk stops that. If it forwards to a cell, that cell is probably the right
          on-call number for this site.
        </div>
      )}

      {inspection.blockers.length > 0 ? (
        <div className="warnbox" style={{ marginTop: 10 }}>
          <strong>Refusing to provision.</strong>
          <ul style={{ marginBottom: 0 }}>
            {inspection.blockers.map((b) => (
              <li key={b.id}>{b.detail}</li>
            ))}
          </ul>
        </div>
      ) : (
        <form action={onApply} style={{ marginTop: 10 }}>
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="phoneNumber" value={inspection.phoneNumber} />
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Provisioning…' : `Attach and import ${inspection.phoneNumber}`}
          </button>
        </form>
      )}
    </div>
  )
}
