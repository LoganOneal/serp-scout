import type { ClusterBoardRow } from '@rnr/data'
import { NULL_DISPLAY, num } from '@/lib/format'

/**
 * Clusters — the unit of work, because a cluster is one page.
 *
 * ==================== THE COLUMN ORDER IS THE ARGUMENT ====================
 * `vol (max)` is the demand column and the sort key. `sum` sits beside it,
 * dimmed and labelled an upper bound, and nothing sorts on it.
 *
 * That is not a stylistic preference. Summing a cluster's members double-counts
 * near-identical phrasings — Google reports one volume for a group of queries and
 * the export lists each surface form. Measured on this very import the inflation
 * was 4.5x for Las Vegas, 7.3x for Houston and 11.2x for Chicago, and because it
 * is UNEVEN it REORDERS the cities rather than merely inflating them. A board
 * sorted on sum puts Chicago above Las Vegas on a difference that is entirely how
 * many phrasings Semrush happened to export.
 *
 * Showing both, with max first, is what makes the range visible instead of
 * asking the reader to trust a point estimate nobody can defend.
 * =========================================================================
 */
export function ClusterBoard({ rows }: { rows: ClusterBoardRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        No clusters yet. <code className="mono">clusters.mts import &lt;domain&gt; --dir=…</code>
      </div>
    )
  }

  return (
    <div className="sm-table-wrap">
      <table className="sm-table">
        <thead>
          <tr>
            <th>Cluster</th>
            <th>Kind</th>
            <th>Verdict</th>
            <th className="sm-mono" title="Highest single member. A lower bound, and the sort key.">
              vol (max)
            </th>
            <th
              className="sm-mono"
              title="Sum of members. An UPPER bound — near-identical phrasings share one pool of demand, so this over-counts. Never sorted on."
            >
              sum ↑
            </th>
            <th className="sm-mono" title="Semrush KD: easiest member / median. Not scoreDifficulty.">
              kd
            </th>
            <th>Supply</th>
            <th className="sm-mono">kws</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="sm-kw-cell">
                <span className="sm-kw-text">{c.slug}</span>
                {c.primaryKeywordNorm && (
                  <div className="sm-sub">{c.primaryKeywordNorm}</div>
                )}
              </td>
              <td>
                <span className={`badge cluster-kind-${c.kind}`}>{c.kind.replace(/_/g, ' ')}</span>
              </td>
              <td>
                <span className={`sm-verdict sm-verdict-${(c.verdict ?? 'unknown').toLowerCase()}`}>
                  {c.verdict ?? 'UNKNOWN'}
                </span>
              </td>
              <td className="sm-mono">
                {c.volumeMax === null ? <span className="null">{NULL_DISPLAY}</span> : num(c.volumeMax)}
              </td>
              <td className="sm-mono dim" title="Upper bound. Inflated by near-duplicate phrasings.">
                {c.volumeSum === null ? NULL_DISPLAY : num(c.volumeSum)}
              </td>
              <td className="sm-mono">
                {c.kdMin === null ? (
                  <span className="null">{NULL_DISPLAY}</span>
                ) : (
                  <>
                    {c.kdMin}
                    <span className="dim"> / {c.kdMedian ?? NULL_DISPLAY}</span>
                  </>
                )}
              </td>
              <td>
                <SupplyCell row={c} />
              </td>
              <td className="sm-mono">{c.memberCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Three different things live in this cell and they must not look alike:
 *
 *   n/a      this kind of cluster has no locality, so supply is a category error
 *   unknown  a locality cluster whose market never resolved, or has no coverage
 *   need N   measured, and short of the credibility threshold
 *
 * `n/a` reading as a gap would send somebody hunting for inventory for
 * `chain_hilton`, which is not a place.
 */
function SupplyCell({ row }: { row: ClusterBoardRow }) {
  if (row.kind !== 'locality') {
    return (
      <span className="dim" title="Not a locality — supply does not apply to this kind of page.">
        n/a
      </span>
    )
  }
  if (row.availableItems === null) {
    return (
      <span
        className="null"
        title="This cluster's market never resolved, or has no coverage row. UNKNOWN, never zero — it gates nothing."
      >
        unknown
      </span>
    )
  }
  if (row.staysNeeded > 0) {
    return (
      <span className="warn-text" title="Short of the credibility threshold. This is what would change the verdict.">
        {row.availableItems} · need {row.staysNeeded}
      </span>
    )
  }
  return <span>{row.availableItems} ok</span>
}
