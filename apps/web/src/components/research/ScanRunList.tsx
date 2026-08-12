import Link from 'next/link'

/**
 * Locality scans, listed for the first time.
 *
 * The scan pages themselves are good -- the difficulty decomposition on a scan
 * target is the clearest explanation of the scoring model anywhere in the
 * product. They were simply unreachable: the only entry point was the result
 * step of a wizard nested inside a collapsed disclosure inside a tab, so
 * navigating away lost the run for good.
 */

export interface ScanRunRow {
  id: number
  status: string
  locality: string
  nicheCount: number | null
  spendUsd: number
  usedFixtures: boolean
  createdAt: string
}

export function ScanRunList(props: { runs: ScanRunRow[] }) {
  if (props.runs.length === 0) return null

  return (
    <section className="sm-panel" style={{ marginBottom: 18 }}>
      <div className="sm-toolbar">
        <div className="sm-toolbar-title">
          Locality scans
          <span className="sm-count">{props.runs.length}</span>
        </div>
        <div className="sm-toolbar-actions faint" style={{ fontSize: 12 }}>
          Every seed niche scored for one place, easiest SERP first
        </div>
      </div>
      <div className="table-scroll">
        <table className="sm-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Locality</th>
              <th>Status</th>
              <th className="num">Niches</th>
              <th className="num">Cost</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {props.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/scout/scans/${r.id}`} className="opp-kw-link mono">
                    #{r.id}
                  </Link>
                  {r.usedFixtures && <span className="badge warn" style={{ marginLeft: 6 }}>fixtures</span>}
                </td>
                <td>{r.locality}</td>
                <td style={{ fontSize: 12 }}>{r.status}</td>
                <td className="num">{r.nicheCount ?? '—'}</td>
                <td className="num">${r.spendUsd.toFixed(4)}</td>
                <td style={{ fontSize: 12 }}>
                  {new Date(r.createdAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
