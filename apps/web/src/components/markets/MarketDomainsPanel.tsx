'use client'

import Link from 'next/link'
import { useActionState, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { startEnrichForMarket, type StartEnrichState } from '@/app/scout/domains/actions'
import {
  DEFAULT_PAID_OPTIONS,
  EnrichOptionsModal,
  type PaidOptionsValue,
} from '@/components/domains/EnrichOptionsModal'

export interface MarketDomainRun {
  id: number
  status: string
  uniqueDomains: number
  candidateCount: number
  bestScore: number | null
  costMicros: string
  createdAt: string
  error: string | null
}

function SubmitButton({ disabled, onOpen }: { disabled: boolean; onOpen: () => void }) {
  const { pending } = useFormStatus()
  return (
    <button type="button" className="btn primary" disabled={pending || disabled} onClick={onOpen}>
      {pending ? 'Starting…' : 'Run domain search…'}
    </button>
  )
}

/**
 * Domain search for THIS niche in THIS market.
 *
 * The standalone /domains page asks which market you mean; here the answer is
 * already on the page, so the panel is a single button rather than a form. The
 * niche and location code are fixed to the cell and submitted as hidden fields.
 */
export function MarketDomainsPanel(props: {
  niche: string
  locality: string
  locationCode: number | null
  locationName: string | null
  runs: MarketDomainRun[]
}) {
  const [state, action] = useActionState<StartEnrichState | null, FormData>(
    startEnrichForMarket,
    null,
  )
  const [modalOpen, setModalOpen] = useState(false)
  const [paid, setPaid] = useState<PaidOptionsValue>(DEFAULT_PAID_OPTIONS)
  const formRef = useRef<HTMLFormElement>(null)

  const fmtUsd = (micros: string) => `$${(Number(micros) / 1_000_000).toFixed(4)}`

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Domain search</h2>
        <span className="sm-sub">
          Expired, parked and abandoned domains behind the businesses ranking here.
        </span>
      </div>

      {props.locationCode == null ? (
        /* Not an error the operator caused, and not something a retry fixes —
           so it explains the cause instead of just disabling the button. */
        <div className="empty" style={{ padding: 16, marginTop: 12 }}>
          This market has no DataForSEO location code, so a domain search cannot be geo-targeted
          here. Codes come from a research geo import; import <strong>{props.locality}</strong> on
          the Research → Geos tab and this panel will work.
        </div>
      ) : (
        <form ref={formRef} action={action} style={{ marginTop: 12 }}>
          <input type="hidden" name="niche" value={props.niche} />
          <input type="hidden" name="locality" value={props.locality} />
          <input type="hidden" name="locationCode" value={props.locationCode} />
          <input type="hidden" name="maxResults" value={200} />
          <input type="hidden" name="returnTo" value="market" />
          <input type="hidden" name="checkSpam" value={paid.checkSpam ? '1' : '0'} />
          <input type="hidden" name="checkRankings" value={paid.checkRankings ? '1' : '0'} />
          <input type="hidden" name="maxRankingLookups" value={paid.maxRankingLookups} />
          <input type="hidden" name="renderUnknown" value={paid.renderUnknown ? '1' : '0'} />

          <div className="flex" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <SubmitButton disabled={false} onOpen={() => setModalOpen(true)} />
            <span className="badge ok">from $0.002</span>
            <span className="sm-sub">
              Searching <strong>{props.niche}</strong> in{' '}
              <strong>{props.locationName ?? props.locality}</strong>. Includes every domain this
              market&rsquo;s earlier sweeps already found, at no extra cost.
            </span>
          </div>

          {state && (
            <div className={`enrich-start-result ${state.ok ? 'ok' : 'err'}`}>{state.message}</div>
          )}

          <EnrichOptionsModal
            open={modalOpen}
            niche={props.niche}
            locality={props.locationName ?? props.locality}
            onClose={() => setModalOpen(false)}
            onConfirm={(v) => {
              setPaid(v)
              setModalOpen(false)
              requestAnimationFrame(() => formRef.current?.requestSubmit())
            }}
          />
        </form>
      )}

      {props.runs.length > 0 && (
        <div className="table-scroll sm-table-wrap" style={{ marginTop: 14 }}>
          <table className="sm-table">
            <thead>
              <tr>
                <th className="num">Run</th>
                <th>Status</th>
                <th className="num">Domains</th>
                <th className="num">Candidates</th>
                <th className="num">Best</th>
                <th className="num">Cost</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {props.runs.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    <Link className="sm-link" href={`/scout/domains/${r.id}`}>
                      #{r.id}
                    </Link>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        r.status === 'complete' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn'
                      }`}
                      title={r.error ?? undefined}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="num">{r.uniqueDomains || '—'}</td>
                  <td className="num">
                    <strong>{r.candidateCount || '—'}</strong>
                  </td>
                  <td className="num">{r.bestScore == null ? '—' : r.bestScore.toFixed(1)}</td>
                  <td className="num">{fmtUsd(r.costMicros)}</td>
                  <td className="sm-sub">
                    {new Date(r.createdAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
