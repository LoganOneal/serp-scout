import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, getDeepDiveRun, listOpportunityGrid, listRunKeywords, queryOr } from '@rnr/data'
import { keywordPathFor } from '@rnr/core'
import { OpportunityGridPanel } from '@/components/research/OpportunityGridPanel'

export const dynamic = 'force-dynamic'

/**
 * One sweep run's results.
 *
 * ==================== WHY THIS IS ITS OWN PAGE ====================
 * The Market sweep tab used to render every measured cell from every run in a
 * single grid. That answers "what do I know overall", which is not the question
 * an operator has after starting a run -- they want to see what THIS run bought,
 * including the desktop/mobile pair, and including cells a later run has since
 * re-measured. A flat list cannot show either, because it collapses to the
 * newest row per cell and drops the device dimension.
 * ================================================================
 */
export default async function DeepDiveRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId: raw } = await params
  const runId = Number(raw)
  if (!Number.isInteger(runId) || runId <= 0) notFound()

  const database = db()
  const run = await queryOr('getDeepDiveRun', () => getDeepDiveRun(database, runId), null)
  if (!run) notFound()

  const rows = await queryOr(
    'listOpportunityGrid(run)',
    () => listOpportunityGrid(database, { runId, limit: 2000 }),
    [],
  )

  /**
   * Every keyword this run measured, with the path to its SERP page. Computed
   * here rather than in the grid because the short-vs-market-qualified choice
   * needs the whole run in view.
   */
  const keywordIndex = await queryOr('listRunKeywords', () => listRunKeywords(database, runId), [])
  const candidates = keywordIndex.map((k) => ({
    keyword: k.keyword,
    market: k.market,
    stateAbbr: k.stateAbbr,
  }))
  const pathByKeyword = new Map(
    keywordIndex.map((k) => [`${k.keyword.toLowerCase()}|${k.market ?? ''}`, k.path]),
  )

  const active = run.status === 'running' || run.status === 'pending'
  const spend = run.spendMicros == null ? null : Number(run.spendMicros) / 1_000_000

  return (
    <div className="opp-workspace">
      <div className="run-page-head">
        <div className="page-breadcrumb">
          <Link href="/research">Research</Link> <span className="app-topbar-sep">/</span> Market sweep
          runs <span className="app-topbar-sep">/</span> #{run.id}
        </div>
        <div className="run-page-title-row">
          <h1 className="page-title" style={{ margin: 0 }}>
            {run.label ?? `Sweep #${run.id}`}
          </h1>
          <div className="page-header-actions">
            <Link href="/research" className="btn">
              ← All runs
            </Link>
          </div>
        </div>
        <div className="sm-magic-meta">
          <span>
            Run: <strong>#{run.id}</strong>
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Status: <strong>{run.status}</strong>
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Jobs: <strong>{run.jobsDone}</strong> of {run.jobCount}
            {run.jobsFailed > 0 ? ` · ${run.jobsFailed} failed` : ''}
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Devices: <strong>{run.devices ?? 'desktop'}</strong>
          </span>
          {spend != null && (
            <>
              <span className="sm-magic-meta-sep">·</span>
              <span>
                Cost: <strong>${spend.toFixed(4)}</strong>
              </span>
            </>
          )}
          {run.usedFixtures && (
            <>
              <span className="sm-magic-meta-sep">·</span>
              <span className="badge warn">fixtures</span>
            </>
          )}
        </div>
      </div>

      <OpportunityGridPanel
        runId={runId}
        rows={rows.map((r) => ({
          ...r,
          serpPath:
            pathByKeyword.get(`${r.exactQuery.toLowerCase()}|${r.market}`) ??
            keywordPathFor(
              { keyword: r.exactQuery, market: r.market, stateAbbr: r.stateAbbr },
              candidates,
            ),
        }))}
        title="Results"
        jobsActive={active}
        fullHeight
        emptyAction={
          <Link href="/research" className="btn primary">
            ← Back to Research
          </Link>
        }
      />
    </div>
  )
}
