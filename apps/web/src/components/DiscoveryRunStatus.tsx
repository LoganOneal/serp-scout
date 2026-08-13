'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { formatMicrosUsd, runNextAction } from '@rnr/core'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'

export interface DiscoveryRunView {
  id: number
  status: string
  jobCount: number
  jobsDone: number
  jobsFailed: number
  jobsSkipped?: number
  hitCount: number
  label: string | null
  devices?: string
  scope?: {
    nicheCount: number
    geoCount: number
    /** Deliberately capped by the server; the card is a summary, not a dump. */
    niches: string[]
    markets: string[]
  }
  error: string | null
  createdAt: string
  usedFixtures?: boolean
  /** Actual ledger spend (micros, as string for JSON). Organic SERP jobs. */
  spendMicros?: string | null
  /** Pre-run estimate (micros, as string). */
  estimatedCostMicros?: string | null
}

function parseMicros(raw: string | null | undefined): bigint {
  if (raw == null || raw === '') return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

function isInFlight(status: string): boolean {
  return status === 'pending' || status === 'running' || status === 'claimed'
}

function statusTone(status: string, failed: number, done: number, total: number): string {
  if (status === 'failed') return 'stop'
  if (isInFlight(status)) return 'warn'
  if (status === 'done' && failed > 0 && done === 0) return 'stop'
  if (status === 'done' && failed > 0) return 'warn'
  if (status === 'done') return 'go'
  return 'unknown'
}

function statusLabel(status: string, failed: number, done: number, total: number): string {
  if (isInFlight(status)) {
    if (status === 'pending') return 'Queued'
    if (status === 'claimed') return 'Starting…'
    return 'Running'
  }
  if (status === 'failed') return 'Failed'
  if (status === 'done' && failed > 0 && done === 0) return 'All jobs failed'
  if (status === 'done' && failed > 0) return 'Finished with errors'
  if (status === 'done') return 'Complete'
  return status
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso.slice(0, 16)
  }
}

function runPurpose(run: DiscoveryRunView): string {
  const scope = run.scope
  if (!scope || (scope.nicheCount === 0 && scope.geoCount === 0)) {
    return run.label ?? 'Research run'
  }

  const niche = scope.niches[0]
  const market = scope.markets[0]
  if (scope.nicheCount === 1 && scope.geoCount === 1 && niche && market) {
    return `${niche} × ${market}`
  }
  if (scope.nicheCount === 1) {
    return `${niche ?? '1 niche'} × ${scope.geoCount} markets`
  }
  if (scope.geoCount === 1) {
    return `${scope.nicheCount} niches × ${market ?? '1 market'}`
  }
  return `${scope.nicheCount} niches × ${scope.geoCount} markets`
}

function RunScopeLine({
  label,
  count,
  items,
}: {
  label: string
  count: number
  items: string[]
}) {
  const remaining = Math.max(0, count - items.length)
  return (
    <div className="job-run-scope-line">
      <span className="job-run-scope-label">
        {label} <strong>{count}</strong>
      </span>
      <div className="job-run-scope-items">
        {items.map((item) => (
          <span key={item} className="job-run-scope-chip">
            {item}
          </span>
        ))}
        {remaining > 0 ? (
          <span className="job-run-scope-more">+{remaining} more</span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Clear job/run progress UI with auto-refresh while anything is in flight.
 */
export function DiscoveryRunStatus({
  runs,
  title = 'Job queue',
  emptyHint,
  autoRefresh = true,
  pollMs = 4000,
  onDeleteRun,
  runHref,
}: {
  runs: DiscoveryRunView[]
  title?: string
  emptyHint?: string
  autoRefresh?: boolean
  pollMs?: number
  /** When set, the run label links to that run's own results page. */
  runHref?: (runId: number) => string
  /** Delete a finished or stuck run so the same opportunity can be re-run. */
  onDeleteRun?: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const anyActive = runs.some((r) => isInFlight(r.status))
  useAutoRefresh(autoRefresh && anyActive, pollMs)

  const deleteRun = (run: DiscoveryRunView) => {
    if (!onDeleteRun) return
    const active = isInFlight(run.status)
    const msg = active
      ? `Cancel and delete run #${run.id}? In-flight jobs will stop; metrics for this run are removed so you can re-run.`
      : `Delete run #${run.id}? Removes its SERP results from this run so you can research the same selection again.`
    if (!window.confirm(msg)) return
    setErr(null)
    const fd = new FormData()
    fd.set('runId', String(run.id))
    startTransition(async () => {
      const res = await onDeleteRun(fd)
      if (!res.ok) setErr(res.error ?? 'Could not delete run.')
      else router.refresh()
    })
  }

  if (runs.length === 0) {
    return emptyHint ? (
      <div className="card empty" style={{ padding: 16, marginBottom: 16 }}>
        {emptyHint}
      </div>
    ) : null
  }

  return (
    <div className="job-status-block">
      {anyActive && (
        <div className="job-live-banner" role="status" aria-live="polite">
          <span className="job-spinner" aria-hidden />
          <div>
            <strong>Jobs in progress</strong>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              Updating every few seconds — no need to refresh. Locally, keep{' '}
              <code>pnpm worker</code> running; production uses cron (~1/min).
            </div>
          </div>
        </div>
      )}

      <div className="sm-toolbar">
        <div className="sm-toolbar-title">
          {title}
          {anyActive && <span className="badge warn">live</span>}
        </div>
        <div className="sm-toolbar-meta faint">
          {runs.length} run{runs.length === 1 ? '' : 's'}
          {onDeleteRun && ' · delete a run to re-research the same selection'}
        </div>
      </div>

      {err && <div className="stopbox" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="job-run-list">
        {runs.map((r) => {
          const total = Math.max(1, r.jobCount)
          const finished = r.jobsDone + r.jobsFailed + (r.jobsSkipped ?? 0)
          const pct = Math.min(100, Math.round((finished / total) * 100))
          const donePct = Math.min(100, Math.round((r.jobsDone / total) * 100))
          const failPct = Math.min(100 - donePct, Math.round((r.jobsFailed / total) * 100))
          const active = isInFlight(r.status)
          const tone = statusTone(r.status, r.jobsFailed, r.jobsDone, r.jobCount)
          const label = statusLabel(r.status, r.jobsFailed, r.jobsDone, r.jobCount)
          const remaining = Math.max(0, r.jobCount - finished)
          /**
           * The next-action strip below renders the emphasised "Open results",
           * so the header one is a second copy of the same button 60px away.
           * It stays only for the states where the strip offers something else
           * -- otherwise opening the run would have no control at all.
           */
          const next = runNextAction(r)

          return (
            <div
              key={r.id}
              className={`job-run-card${active ? ' is-active' : ''}${r.jobsFailed > 0 && !active ? ' has-fails' : ''}`}
            >
              <div className="job-run-head">
                <div className="job-run-title">
                  <span className="mono faint">#{r.id}</span>
                  {runHref ? (
                    <a className="job-run-label job-run-link" href={runHref(r.id)}>
                      {runPurpose(r)}
                    </a>
                  ) : (
                    <span className="job-run-label">{runPurpose(r)}</span>
                  )}
                  {r.devices ? <span className="badge">{r.devices.replace(',', ' + ')}</span> : null}
                  {r.usedFixtures && <span className="badge warn">fixtures</span>}
                </div>
                <div className="row-actions">
                  <span className={`badge ${tone}`}>{label}</span>
                  {runHref && next.cta !== 'open-results' && (
                    <a className="btn tiny" href={runHref(r.id)}>
                      Open results →
                    </a>
                  )}
                  {runHref && (
                    <a
                      className="btn tiny"
                      href={`/api/scout/runs/${r.id}/reddit-opportunities`}
                      download
                    >
                      Export CSV
                    </a>
                  )}
                  {onDeleteRun && (
                    <button
                      type="button"
                      className="btn tiny danger"
                      disabled={pending}
                      onClick={() => deleteRun(r)}
                      title="Delete run and its metrics so you can re-run"
                    >
                      {active ? 'Cancel & delete' : 'Delete'}
                    </button>
                  )}
                </div>
              </div>

              {r.scope ? (
                <div className="job-run-scope" aria-label="Run scope">
                  <RunScopeLine
                    label="Niches"
                    count={r.scope.nicheCount}
                    items={r.scope.niches}
                  />
                  <RunScopeLine
                    label="Markets"
                    count={r.scope.geoCount}
                    items={r.scope.markets}
                  />
                </div>
              ) : null}

              <div className="job-progress" title={`${finished} of ${r.jobCount} finished`}>
                <div className="job-progress-done" style={{ width: `${donePct}%` }} />
                <div className="job-progress-fail" style={{ width: `${failPct}%` }} />
                {active && remaining > 0 && (
                  <div className="job-progress-pulse" style={{ width: `${Math.max(4, 100 - pct)}%` }} />
                )}
              </div>

              <div className="job-run-stats">
                <span>
                  <strong>{r.jobsDone}</strong>
                  <span className="faint"> done</span>
                </span>
                {r.jobsFailed > 0 && (
                  <span className="job-stat-fail">
                    <strong>{r.jobsFailed}</strong>
                    <span className="faint"> failed</span>
                  </span>
                )}
                {(r.jobsSkipped ?? 0) > 0 && (
                  <span>
                    <strong>{r.jobsSkipped}</strong>
                    <span className="faint"> skipped</span>
                  </span>
                )}
                {active && remaining > 0 && (
                  <span>
                    <strong>{remaining}</strong>
                    <span className="faint"> left</span>
                  </span>
                )}
                <span className="faint">
                  of {r.jobCount} job{r.jobCount === 1 ? '' : 's'}
                </span>
                <span className="job-run-sep">·</span>
                <span>
                  <strong>{r.hitCount}</strong>
                  <span className="faint"> Reddit hits</span>
                </span>
                {/**
                 * Cost belongs on this line, not in a bordered pill under it
                 * with a two-line footnote beneath that. Every card carried the
                 * same explanation of what the ledger covers -- true, and worth
                 * saying once on hover rather than four times down the page.
                 */}
                {(() => {
                  const spend = parseMicros(r.spendMicros)
                  const est = parseMicros(r.estimatedCostMicros)
                  const fixtures = Boolean(r.usedFixtures)
                  const label = fixtures ? '$0 fixtures' : formatMicrosUsd(spend, { precision: 4 })
                  const estLabel =
                    !fixtures && est > 0n ? formatMicrosUsd(est, { precision: 4 }) : null
                  return (
                    <>
                      <span className="job-run-sep">·</span>
                      <span
                        title={
                          `Organic SERP jobs only — Volume and Maps API calls are not in this ledger.` +
                          (estLabel ? ` Estimated ${estLabel} before the run.` : '') +
                          (r.jobsDone > 0 && !fixtures
                            ? ` About $${(Number(spend) / 1_000_000 / Math.max(1, r.jobsDone)).toFixed(4)} per completed job.`
                            : '')
                        }
                      >
                        <strong className="mono">{label}</strong>
                        <span className="faint"> spent</span>
                      </span>
                    </>
                  )
                })()}
                <span className="job-run-sep">·</span>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {formatWhen(r.createdAt)}
                </span>
              </div>


              {/**
               * What to do about this run, rather than what happened to it.
               * The counts above are the evidence; this is the conclusion, and
               * it is the only line that changes between "open the grid" and
               * "this will never finish" -- states the card used to render
               * with the same two sentences of generic failure advice.
               */}
              {(() => {
                return (
                  <div className={`job-next job-next-${next.tone}`}>
                    <div className="job-next-head">
                      <strong>{next.headline}</strong>
                      {next.cta === 'open-results' && runHref && (
                        <a className="btn tiny primary" href={runHref(r.id)}>
                          Open results →
                        </a>
                      )}
                      {next.cta === 'delete-and-retry' && onDeleteRun && (
                        <button
                          type="button"
                          className="btn tiny danger"
                          disabled={pending}
                          onClick={() => deleteRun(r)}
                        >
                          Delete &amp; re-run
                        </button>
                      )}
                    </div>
                    <p className="job-next-detail">{next.detail}</p>
                  </div>
                )
              })()}

              {r.error && (
                <div className="job-run-error" title={r.error}>
                  {r.error.length > 180 ? r.error.slice(0, 180) + '…' : r.error}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Compact banner when something is running (for panels that only need a strip). */
export function JobsInFlightBanner({ active, detail }: { active: boolean; detail?: string }) {
  useAutoRefresh(active, 4000)
  if (!active) return null
  return (
    <div className="job-live-banner" role="status" aria-live="polite" style={{ marginBottom: 12 }}>
      <span className="job-spinner" aria-hidden />
      <div>
        <strong>Working…</strong>
        <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
          {detail ??
            'Auto-refreshing this page every few seconds. Keep the worker running locally (pnpm worker).'}
        </div>
      </div>
    </div>
  )
}
