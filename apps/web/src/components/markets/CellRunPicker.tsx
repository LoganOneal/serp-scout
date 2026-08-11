import Link from 'next/link'

/**
 * Which run this market page is showing.
 *
 * ==================== WHY A MARKET NEEDS A RUN ====================
 * Houston x HVAC held metrics from six runs spanning five days. The page used
 * to take the newest row per keyword x device across all of them, so one
 * keyword measured on the 5th sat beside another measured on the 10th and the
 * result was labelled "the market" -- a picture that existed at no single
 * moment and changed under the operator whenever any run touched the cell.
 *
 * The cell URL is deliberately stable across the lifecycle, so the run lives in
 * a query string. "All runs" is still reachable, but it is now an explicit
 * choice with a warning rather than the silent default.
 * ==================================================================
 */

export interface CellRunOptionView {
  runId: number
  source: string
  status: string
  label: string | null
  measuredAt: string | null
  keywords: number
  storedSerps: number
}

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const SOURCE_LABEL: Record<string, string> = {
  market_cell: 'Market run',
  catalog: 'Sweep',
  legacy_csv: 'CSV',
}

export function CellRunPicker(props: {
  basePath: string
  selectedRunId: number | null
  runs: CellRunOptionView[]
}) {
  if (props.runs.length === 0) return null

  return (
    <section className="sm-panel cell-run-picker">
      <div className="sm-toolbar">
        <div className="sm-toolbar-title">
          Measured in
          <span className="sm-count">{props.runs.length} runs</span>
        </div>
        <div className="sm-toolbar-actions">
          {props.selectedRunId === null && (
            <span className="badge warn" title="Rows may come from different days">
              merged across runs
            </span>
          )}
        </div>
      </div>

      <div className="cell-run-list">
        {props.runs.map((r) => {
          const active = r.runId === props.selectedRunId
          return (
            <Link
              key={r.runId}
              href={`${props.basePath}?run=${r.runId}`}
              className={`cell-run-chip${active ? ' active' : ''}`}
              title={
                `${r.keywords} keywords · ${r.storedSerps} stored SERPs · ` +
                `${SOURCE_LABEL[r.source] ?? r.source} · ${r.status}`
              }
            >
              <span className="cell-run-id">#{r.runId}</span>
              <span className="cell-run-meta">
                {SOURCE_LABEL[r.source] ?? r.source} · {shortDate(r.measuredAt)} · {r.keywords} kw
              </span>
            </Link>
          )
        })}
        <Link
          href={`${props.basePath}?run=all`}
          className={`cell-run-chip${props.selectedRunId === null ? ' active' : ''}`}
          title="Newest measurement per keyword across every run. Rows may come from different days."
        >
          <span className="cell-run-id">All</span>
          <span className="cell-run-meta">newest per keyword</span>
        </Link>
      </div>
    </section>
  )
}
