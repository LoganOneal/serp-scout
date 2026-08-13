import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, getDeepDiveRun, listOpportunityGrid, listRunKeywords, queryOr } from '@rnr/data'
import {
  keywordPathFor,
  opportunitySignals,
  runNextAction,
  SIGNAL_LABEL,
  type OpportunitySignal,
} from '@rnr/core'
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

  /**
   * What this run is telling you to do, and how much of it is actionable.
   *
   * Counted from the rows already loaded rather than from the run's hitCount:
   * hitCount is Reddit threads, which is one of four plays. A run with no
   * Reddit at all can still be carrying a page of build and domain
   * opportunities, and the header should not call that empty.
   */
  const next = runNextAction({
    status: run.status,
    jobCount: run.jobCount,
    jobsDone: run.jobsDone,
    jobsFailed: run.jobsFailed,
    jobsSkipped: run.jobsSkipped,
    hitCount: run.hitCount,
    error: run.error,
  })

  const signalCounts = new Map<OpportunitySignal, number>()
  for (const r of rows) {
    for (const sig of opportunitySignals({
      redditVisits: r.redditVisits,
      redditHitCount: r.redditHitCount,
      volume: r.volume,
      verdictAcquired: r.verdictAcquired,
      slotsOpen: r.slotsOpen,
      emdAvailable: r.emdAvailable ?? null,
    })) {
      signalCounts.set(sig, (signalCounts.get(sig) ?? 0) + 1)
    }
  }
  const signalTotal = [...signalCounts.values()].reduce((a, b) => a + b, 0)

  return (
    <div className="opp-workspace">
      <div className="run-page-head">
        <div className="page-breadcrumb">
          <Link href="/scout">Research</Link> <span className="app-topbar-sep">/</span> Market sweep
          runs <span className="app-topbar-sep">/</span> #{run.id}
        </div>
        <div className="run-page-title-row">
          <h1 className="page-title" style={{ margin: 0 }}>
            {run.label ?? `Sweep #${run.id}`}
          </h1>
          <div className="page-header-actions">
            <a
              href={`/api/scout/runs/${run.id}/reddit-opportunities`}
              className="btn"
              download
            >
              Export Reddit CSV
            </a>
            <Link href="/scout" className="btn">
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

        <div className={`run-next run-next-${next.tone}`}>
          <div className="run-next-main">
            <strong className="run-next-headline">{next.headline}</strong>
            <p className="run-next-detail">{next.detail}</p>
          </div>
          {/**
           * Counted over measured rows, with the denominator shown. The grid
           * renders more chips than this number, because a niche's group header
           * repeats the strongest signal of the rows beneath it -- without
           * "of N rows" the two look like they disagree.
           */}
          {signalTotal > 0 && (
            <div className="run-next-signals" title="Measured rows carrying at least one play">
              <span className="run-next-signals-total">
                <strong>{signalTotal}</strong> of {rows.length} rows
              </span>
              <span className="run-next-signals-list">
                {[...signalCounts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([sig, n]) => (
                    <span key={sig} className={`opp-sig opp-sig-${sig}`}>
                      {SIGNAL_LABEL[sig]} {n}
                    </span>
                  ))}
              </span>
            </div>
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
          <Link href="/scout" className="btn primary">
            ← Back to Research
          </Link>
        }
      />
    </div>
  )
}
