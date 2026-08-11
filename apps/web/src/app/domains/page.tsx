import Link from 'next/link'
import { db, listEnrichGeoOptions, listEnrichRuns, queryOr } from '@rnr/data'
import { StartEnrichForm } from '@/components/domains/StartEnrichForm'
import { deleteEnrichRun } from './actions'

export const dynamic = 'force-dynamic'

const fmtUsd = (micros: bigint): string => `$${(Number(micros) / 1_000_000).toFixed(4)}`

const fmtWhen = (d: Date | null): string =>
  d == null ? '—' : new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * ENRICH MODE home — every domain search as one full-page table.
 *
 * The run list is the landing surface rather than a form-first page: after the
 * first run, "what did I already look at" is the question, and a table answers
 * it at a glance where a wizard would hide it.
 */
export default async function DomainsPage() {
  const database = db()
  const [runs, geos] = await Promise.all([
    queryOr('listEnrichRuns', () => listEnrichRuns(database, { limit: 200 }), []),
    queryOr('listEnrichGeoOptions', () => listEnrichGeoOptions(database), []),
  ])

  const totalSpend = runs.reduce((a, r) => a + r.costMicros, 0n)

  return (
    <div className="opp-workspace">
      <div className="run-page-head">
        <div className="page-breadcrumb">Domains</div>
        <div className="run-page-title-row">
          <h1 className="page-title" style={{ margin: 0 }}>
            Domain search
          </h1>
        </div>
        <div className="sm-magic-meta">
          <span>
            Runs: <strong>{runs.length}</strong>
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Total spend: <strong>{fmtUsd(totalSpend)}</strong>
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Find expired, parked and abandoned domains behind the businesses ranking in a market.
          </span>
        </div>
      </div>

      <StartEnrichForm geos={geos} />

      {runs.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          No domain searches yet. Pick a niche and a market above to run the first one.
        </div>
      ) : (
        <div className="table-scroll sm-table-wrap">
          <table className="opp-grid-table sm-table">
            <thead>
              <tr>
                <th className="num">Run</th>
                <th>Niche</th>
                <th>Market</th>
                <th>Status</th>
                <th className="num" title="Businesses returned by Stage 1">Biz</th>
                <th className="num" title="Unique acquirable domains after Stage 2">Domains</th>
                <th className="num" title="Rows that are not a live business">Candidates</th>
                <th className="num" title="Highest ranking score in this run">Best</th>
                <th className="num" title="Listings on a platform we cannot acquire">Platform</th>
                <th className="num" title="Listings with no website at all">No site</th>
                <th className="num">Cost</th>
                <th>Started</th>
                <th className="sm-col-actions" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    <Link className="sm-link" href={`/domains/${r.id}`}>
                      #{r.id}
                    </Link>
                  </td>
                  <td>
                    <Link className="sm-link" href={`/domains/${r.id}`}>
                      {r.niche}
                    </Link>
                  </td>
                  <td>{r.locality}</td>
                  <td>
                    <span
                      className={`badge ${
                        r.status === 'complete' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn'
                      }`}
                      title={r.error ?? undefined}
                    >
                      {r.status}
                    </span>
                    {r.status === 'running' && <span className="job-spinner" aria-hidden />}
                  </td>
                  <td className="num">{r.businessesFound || '—'}</td>
                  <td className="num">{r.uniqueDomains || '—'}</td>
                  <td className="num">
                    <strong>{r.candidateCount || '—'}</strong>
                  </td>
                  <td className="num">{r.bestScore == null ? '—' : r.bestScore.toFixed(1)}</td>
                  <td className="num sm-sub">{r.skippedPlatform || '—'}</td>
                  <td className="num sm-sub">{r.skippedNoDomain || '—'}</td>
                  <td className="num">{fmtUsd(r.costMicros)}</td>
                  <td className="sm-sub">{fmtWhen(r.createdAt)}</td>
                  <td className="sm-col-actions">
                    <form action={deleteEnrichRun}>
                      <input type="hidden" name="runId" value={r.id} />
                      <button type="submit" className="btn tiny danger">
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
