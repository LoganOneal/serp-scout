import Link from 'next/link'
import { db, listMarkets, queryOr } from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import { NULL_DISPLAY } from '@/lib/format'

export const dynamic = 'force-dynamic'

/**
 * Cross-market tracking inbox — regressions and health.
 * Deeper per-cell work remains on /markets/{loc}/{niche}#reddit / SERP panel.
 */
export default async function TrackingPage() {
  const markets = await queryOr('listMarkets', () => listMarkets(db()), [])
  const withReg = markets.filter((m) => m.regressions > 0)
  const active = markets

  return (
    <div>
      <PageHeader
        title="Tracking"
        description="Portfolio view of SERP and Reddit monitoring. Open a market to promote threads or fix regressions."
      />

      <div className="funnel-strip" style={{ marginBottom: 22 }}>
        <div className="funnel-tile">
          <div className="funnel-value">{active.length}</div>
          <div className="funnel-label">Active markets</div>
        </div>
        <div className={`funnel-tile${withReg.length ? ' tone-danger' : ''}`}>
          <div className="funnel-value">{withReg.length}</div>
          <div className="funnel-label">With regressions</div>
        </div>
        <div className="funnel-tile tone-danger">
          <div className="funnel-value">
            {markets.reduce((n, m) => n + m.regressions, 0)}
          </div>
          <div className="funnel-label">Open regressions</div>
        </div>
      </div>

      {withReg.length > 0 && (
        <>
          <div className="section-label">Needs attention</div>
          <div className="table-scroll" style={{ marginBottom: 24 }}>
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="num">Regressions</th>
                  <th>Domain</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {withReg.map((m) => (
                  <tr key={`${m.localitySlug}-${m.nicheSlug}`}>
                    <td>
                      {m.localityName}, {m.stateCode} · {m.nicheLabel}
                    </td>
                    <td className="num">
                      <span className="badge stop">{m.regressions}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {m.domain ?? NULL_DISPLAY}
                    </td>
                    <td>
                      <Link
                        href={`/markets/${m.localitySlug}/${m.nicheSlug}`}
                        className="btn tiny primary"
                      >
                        Fix
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-label">All monitored markets</div>
      {active.length === 0 ? (
        <div className="card empty" style={{ padding: 24 }}>
          No targeted markets yet. Move something from <Link href="/pipeline">Pipeline</Link> to
          Markets, then promote SERP targets.
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Status</th>
                <th className="num">Regressions</th>
                <th>Domain</th>
              </tr>
            </thead>
            <tbody>
              {active.map((m) => (
                <tr key={`${m.localitySlug}-${m.nicheSlug}`}>
                  <td>
                    <Link href={`/markets/${m.localitySlug}/${m.nicheSlug}`}>
                      {m.localityName}, {m.stateCode} · {m.nicheLabel}
                    </Link>
                  </td>
                  <td>
                    <span className="badge neutral">{m.status ?? '—'}</span>
                  </td>
                  <td className="num">
                    {m.regressions > 0 ? (
                      <span className="badge stop">{m.regressions}</span>
                    ) : (
                      <span className="faint">0</span>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {m.domain ?? NULL_DISPLAY}
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
