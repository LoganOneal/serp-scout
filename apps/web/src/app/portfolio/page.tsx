import Link from 'next/link'
import { MIN_N_FOR_ORDERING, type Verdict } from '@rnr/core'
import { buildCalibrationReport, db, listMarkets, listShortlistedUntargeted, queryOr } from '@rnr/data'
import { MarketRowActions } from '@/components/MarketRowActions'
import { PipelineRowActions } from '@/components/PipelineRowActions'
import { NULL_DISPLAY, money, num, percent, verdictStyle } from '@/lib/format'

export const dynamic = 'force-dynamic'

/**
 * Markets — the single list that replaced /sites and /shortlist.
 *
 * ==================== ONE PLACE, BECAUSE THE COMPARISON LIVES HERE ====================
 * The frozen prediction was on /shortlist and the realised result was on /sites, so the one
 * comparison this whole system exists to make was never on screen at the same time. Modelled
 * rent now sits beside realised revenue, on the same row.
 *
 * Every zero is still a measured zero: an unconnected cell renders em dashes, and a close rate
 * below the minimum sample is an em dash rather than 0%.
 * ===================================================================================
 */
/**
 * Which slice of the portfolio is on screen.
 *
 * ==================== THESE WERE THREE PAGES ====================
 * /pipeline rendered the shortlisted table below from the same query and the
 * same row actions this page already used. /tracking re-ran listMarkets -- the
 * identical query -- showed a subset of the columns, and offered one link and
 * no actions. Neither was a different view of the business; both were this
 * page with a predicate applied.
 *
 * So they are a predicate now. One query, one table, three filters.
 * ================================================================
 */
type PortfolioView = 'all' | 'attention' | 'shortlisted'

const VIEWS: Array<{ id: PortfolioView; label: string; hint: string }> = [
  { id: 'all', label: 'All markets', hint: 'Every market you have committed to' },
  { id: 'attention', label: 'Needs attention', hint: 'Markets with an open SERP or Reddit regression' },
  { id: 'shortlisted', label: 'Shortlisted', hint: 'Saved cells not yet targeted' },
]

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const database = db()
  const requested = (await searchParams).view
  const view: PortfolioView =
    requested === 'attention' || requested === 'shortlisted' ? requested : 'all'

  /**
   * ==================== SEQUENTIAL, AND EACH WITH A DEADLINE ====================
   * These three used to run in `Promise.all`. Concurrent queries against the transaction
   * pooler are what took production down: with several in flight the render produced zero
   * bytes and was killed at 300 seconds, with nothing in the logs to say why.
   *
   * Sequential costs almost nothing here -- measured at 140ms + 37ms + 19ms against the
   * live database, versus ~140ms concurrent -- and every query now has its own deadline,
   * after which the page renders what it has and shows the rest as NOT MEASURED. A market
   * list that loads with em dashes is honest; a spinner that never resolves is not.
   * ============================================================================
   */
  const markets = await queryOr('listMarkets', () => listMarkets(database), [])
  const untargeted = await queryOr(
    'listShortlistedUntargeted',
    () => listShortlistedUntargeted(database),
    [],
  )
  const calibration = await queryOr(
    'buildCalibrationReport',
    () => buildCalibrationReport(database),
    null,
  )

  const regressions = markets.reduce((n, m) => n + m.regressions, 0)
  const needsAttention = markets.filter((m) => m.regressions > 0)
  const shownMarkets = view === 'attention' ? needsAttention : markets
  const showMarketTable = view !== 'shortlisted'
  const showShortlist = view !== 'attention'

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Portfolio</h1>
        <p className="page-desc">
          Markets you have committed to. Open one to operate it, or use the row actions to change
          its status or drop it. Shortlisted cells you have saved but not yet targeted are under
          the third filter.
        </p>
      </div>

      <div className="portfolio-views" role="tablist" aria-label="Portfolio view">
        {VIEWS.map((v) => {
          const count =
            v.id === 'all' ? markets.length : v.id === 'attention' ? needsAttention.length : untargeted.length
          const active = v.id === view
          return (
            <Link
              key={v.id}
              href={v.id === 'all' ? '/portfolio' : `/portfolio?view=${v.id}`}
              className={`opp-tab${active ? ' active' : ''}`}
              role="tab"
              aria-selected={active}
              title={v.hint}
            >
              {v.label}
              <span className="opp-tab-badge">{count}</span>
            </Link>
          )
        })}
      </div>

      {regressions > 0 && (
        <div className="stopbox">
          <strong>
            {regressions} SERP regression{regressions === 1 ? '' : 's'} across your markets.
          </strong>{' '}
          A thread stopped ranking, or a comment lost its place. Open the market to see which.
        </div>
      )}

      {!showMarketTable ? null : shownMarkets.length === 0 ? (
        <div className="empty">
          {view === 'attention'
            ? 'Nothing needs attention. No market has an open regression.'
            : 'No markets yet. Run research, shortlist a cell, then start targeting.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Domain</th>
                <th>Status</th>
                <th className="num">Diff at save</th>
                <th>Verdict at save</th>
                <th className="num">Modelled rent</th>
                <th className="num">Calls 30d</th>
                <th className="num">Leads 30d</th>
                <th className="num">Close rate</th>
                <th className="num">Realised /mo</th>
                <th className="num">Keywords</th>
                <th className="num">Regressions</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shownMarkets.map((m) => {
                const notConnected = m.firstWebhookAt === null
                const href = `/portfolio/${m.localitySlug}/${m.nicheSlug}`
                const label = `${m.localityName}, ${m.stateCode} · ${m.nicheLabel}`
                return (
                  <tr key={m.siteId} className={m.regressions > 0 ? 'row-emergency' : undefined}>
                    <td>
                      <Link href={href}>
                        {m.localityName}, {m.stateCode}
                      </Link>
                      <div className="faint" style={{ fontSize: 11.5 }}>
                        {m.nicheLabel}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {m.domain ?? (
                        <span className="badge warn" title="Targeted, but no domain registered yet.">
                          none yet
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${statusTone(m.status)}`}>{m.status}</span>
                    </td>
                    <td className="num">
                      {m.difficultyAtSave === null ? (
                        <Dash title="Targeted without a shortlisted scan, so there is no frozen prediction to compare against." />
                      ) : (
                        m.difficultyAtSave
                      )}
                    </td>
                    <td>
                      {m.verdictAtSave === null ? (
                        <Dash />
                      ) : (
                        <span className={`badge ${verdictStyle(m.verdictAtSave as Verdict).tone}`}>
                          {verdictStyle(m.verdictAtSave as Verdict).label}
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {m.modelledRentMicros === null ? (
                        <Dash title="No modelled rent. Not zero — there is no prediction here." />
                      ) : (
                        money(m.modelledRentMicros, { decimals: 0 })
                      )}
                    </td>

                    {/* An unconnected cell has no measurements, so its counts are em dashes
                        rather than zeros — zero calls and never-connected are different facts. */}
                    <td className="num">
                      {notConnected ? <Dash title="No webhook has ever arrived for this cell." /> : num(m.calls30d)}
                    </td>
                    <td className="num">{notConnected ? <Dash /> : num(m.leads30d)}</td>
                    <td className="num">
                      {m.closeRate === null ? (
                        <Dash title="Too few recorded lead outcomes to state a rate." />
                      ) : (
                        percent(m.closeRate)
                      )}
                    </td>
                    <td className="num">
                      {m.realisedMonthlyMicros === null ? (
                        <Dash title="No lead outcomes recorded. Unknown, not $0." />
                      ) : (
                        money(m.realisedMonthlyMicros, { decimals: 0 })
                      )}
                    </td>
                    <td className="num">
                      {m.keywords === 0 ? <Dash /> : `${m.keywords}/${m.serpTargets}`}
                    </td>
                    <td className="num">
                      {m.regressions === 0 ? (
                        <span className="faint">0</span>
                      ) : (
                        <span className="badge stop">{m.regressions}</span>
                      )}
                    </td>
                    <td>
                      <MarketRowActions
                        siteId={m.siteId}
                        status={m.status}
                        href={href}
                        label={label}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showShortlist && untargeted.length > 0 && (
        <>
          <h3>Shortlisted, not yet targeted</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            Decided but not started. Open to start targeting, or remove from the pipeline.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>EMD</th>
                  <th className="num">Diff at save</th>
                  <th>Verdict at save</th>
                  <th>Saved</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {untargeted.map((u) => {
                  const href = `/portfolio/${u.localitySlug}/${u.nicheSlug}`
                  const label = `${u.localityName}, ${u.stateCode} · ${u.nicheLabel}`
                  return (
                    <tr key={u.shortlistId}>
                      <td>
                        <Link href={href}>
                          {u.localityName}, {u.stateCode}
                        </Link>
                        <div className="faint" style={{ fontSize: 11.5 }}>
                          {u.nicheLabel}
                        </div>
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {u.emdDomain}
                      </td>
                      <td className="num">
                        {u.difficultyAtSave === null ? <Dash /> : u.difficultyAtSave}
                      </td>
                      <td>
                        <span className={`badge ${verdictStyle(u.verdictAtSave as Verdict).tone}`}>
                          {verdictStyle(u.verdictAtSave as Verdict).label}
                        </span>
                      </td>
                      <td className="mono faint" style={{ fontSize: 11.5 }}>
                        {u.savedAt.toISOString().slice(0, 10)}
                      </td>
                      <td>
                        <PipelineRowActions
                          shortlistId={u.shortlistId}
                          href={href}
                          label={label}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Calibration is a PORTFOLIO view, so it belongs here rather than on a shortlist page. */}
      <h2>Calibration</h2>
      {calibration === null ? (
        <div className="empty">Calibration unavailable (database not reachable).</div>
      ) : (
        <>
          {calibration.isPrior && (
            <div className="warnbox">
              <strong>Every threshold in this model is still a prior.</strong> The bands come from
              published research, not from outcomes measured on your builds. Until the ordering
              check below can run, the ~30 day verdict is a claim about a model, not the world.
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Band</th>
                  <th className="num">Builds (n)</th>
                  <th className="num">Hits</th>
                  <th className="num">Rate</th>
                </tr>
              </thead>
              <tbody>
                {calibration.bands.map((b) => (
                  <tr key={b.verdict}>
                    <td>
                      <span className={`badge ${verdictStyle(b.verdict).tone}`}>
                        {verdictStyle(b.verdict).label}
                      </span>
                    </td>
                    <td className="num">{b.n}</td>
                    <td className="num">{b.hits}</td>
                    <td className="num">
                      {b.rate === null ? (
                        <Dash title="No builds in this band yet. Not a 0% rate." />
                      ) : (
                        <>
                          {percent(b.rate)}{' '}
                          <span className="faint" style={{ fontSize: 11 }}>
                            of {b.n}
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub">
            Ordering soundness:{' '}
            {calibration.ordering.sound === null ? (
              <>
                <span className="badge unknown">not yet answerable</span>{' '}
                <span className="dim">{calibration.ordering.note}</span>
              </>
            ) : calibration.ordering.sound ? (
              <span className="badge go">holds</span>
            ) : (
              <span className="badge stop">VIOLATED</span>
            )}{' '}
            <span className="faint">
              Needs at least {MIN_N_FOR_ORDERING} builds in two bands. A violation means the model
              cannot tell an easy SERP from a hard one — not that a constant needs nudging.
            </span>
          </p>
        </>
      )}
    </div>
  )
}

function Dash({ title }: { title?: string }) {
  return (
    <span className="null" title={title ?? 'Not measured.'}>
      {NULL_DISPLAY}
    </span>
  )
}

function statusTone(status: string): string {
  if (status === 'rented' || status === 'live') return 'go'
  if (status === 'building') return 'warn'
  if (status === 'dropped') return 'stop'
  return 'neutral'
}
