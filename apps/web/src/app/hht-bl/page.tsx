import Link from 'next/link'
import {
  db,
  getHhtBlDashboard,
  type HhtBlDashboardView,
} from '@rnr/data'
import { NULL_DISPLAY, num } from '@/lib/format'

export const dynamic = 'force-dynamic'

const VIEWS: Array<{ id: HhtBlDashboardView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sites', label: 'Sites' },
  { id: 'backlinks', label: 'Backlinks' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'acquired', label: 'Acquired' },
]

const VIEW_IDS = new Set<HhtBlDashboardView>(VIEWS.map((view) => view.id))

function displayLabel(value: string): string {
  return value.replaceAll('_', ' ')
}

function score(value: number | null | undefined): string {
  return value === null || value === undefined ? NULL_DISPLAY : value.toFixed(1)
}

function date(value: Date | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(value)
}

function dateTime(value: Date | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function statusTone(status: string): string {
  if (['COMPLETE', 'complete', 'SCORED', 'SHORTLISTED', 'SELECTED'].includes(status)) {
    return 'go'
  }
  if (['WAITING_FOR_CREDENTIALS', 'waiting', 'FAILED', 'failed'].includes(status)) {
    return status === 'FAILED' || status === 'failed' ? 'stop' : 'warn'
  }
  if (['RUNNING', 'running', 'ANALYZED', 'CRAWLED'].includes(status)) return 'warn'
  return 'neutral'
}

function followLabel(value: boolean | null): { label: string; tone: string } {
  if (value === true) return { label: 'follow', tone: 'go' }
  if (value === false) return { label: 'nofollow', tone: 'neutral' }
  return { label: 'unknown', tone: 'unknown' }
}

function ExternalDomain({ domain }: { domain: string }) {
  return (
    <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="hht-bl-domain">
      {domain}
    </a>
  )
}

function ExternalUrl({ href, label }: { href: string; label?: string | null }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="hht-bl-url" title={href}>
      {label?.trim() || href}
    </a>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="hht-bl-empty">{children}</div>
}

function TableFrame({ children }: { children: React.ReactNode }) {
  return <div className="hht-bl-table-wrap">{children}</div>
}

export default async function HhtBlPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const requested = (await searchParams).view as HhtBlDashboardView | undefined
  const view = requested && VIEW_IDS.has(requested) ? requested : 'overview'
  const result = await getHhtBlDashboard(db(), 'hotelhottubs.com', view).then(
    (dashboard) => ({ dashboard, error: null }),
    (error: unknown) => ({
      dashboard: null,
      error: error instanceof Error ? error.message : 'The backlink workspace could not load.',
    }),
  )

  if (!result.dashboard) {
    return (
      <div className="hht-bl-page">
        <div className="page-header">
          <h1 className="page-title">HHT BL analysis</h1>
          <p className="page-desc">HotelHotTubs backlink research workspace</p>
        </div>
        <div className="stopbox" role="alert">
          <strong>Workspace unavailable.</strong> {result.error}
        </div>
      </div>
    )
  }

  const dashboard = result.dashboard
  if (!dashboard.run) {
    return (
      <div className="hht-bl-page">
        <div className="page-header">
          <h1 className="page-title">HHT BL analysis</h1>
          <p className="page-desc">{dashboard.site.domain}</p>
        </div>
        <Empty>No research run exists yet.</Empty>
      </div>
    )
  }

  const { run, counts } = dashboard
  const tabCount: Record<HhtBlDashboardView, number | null> = {
    overview: null,
    sites: counts.candidates,
    backlinks: counts.backlinks,
    opportunities: counts.opportunities,
    strategies: counts.clusters,
    acquired: counts.acquired,
  }
  const waitingJob = dashboard.jobs.find((job) => job.status === 'WAITING_FOR_CREDENTIALS')

  return (
    <div className="opp-workspace hht-bl-workspace">
      <header className="run-page-head hht-bl-head">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">HHT BL analysis</h1>
            <p className="page-desc">
              {dashboard.site.domain} · Run #{run.id} · {run.profile} · Updated{' '}
              {dateTime(run.updatedAt)}
            </p>
          </div>
          <div className="hht-bl-run-state">
            <span className={`badge ${statusTone(run.status)}`}>{displayLabel(run.status)}</span>
            <span className="hht-bl-current-stage">{displayLabel(run.currentStage)}</span>
          </div>
        </div>
      </header>

      <nav className="hht-bl-tabs" aria-label="HHT backlink workspace views">
        {VIEWS.map((item) => {
          const active = item.id === view
          const count = tabCount[item.id]
          return (
            <Link
              key={item.id}
              href={item.id === 'overview' ? '/hht-bl' : `/hht-bl?view=${item.id}`}
              className={`hht-bl-tab${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
              {count === null ? null : <span className="hht-bl-tab-count">{num(count)}</span>}
            </Link>
          )
        })}
      </nav>

      {run.status === 'WAITING_FOR_CREDENTIALS' ? (
        <div className="hht-bl-credential-alert" role="alert">
          <strong>Semrush credits or credentials need attention.</strong>
          <span>{run.waitingReason?.split('\n')[0] || 'The current MCP account cannot continue.'}</span>
          <span>
            Swap the Semrush MCP account in Codex, verify it with a one-row query, then run{' '}
            <code>
              pnpm hht:bl resume --job-id={waitingJob?.id ?? 'JOB_ID'}
            </code>
            . The saved offset will be preserved.
          </span>
        </div>
      ) : null}

      <main className="hht-bl-view">
        {view === 'overview' ? <Overview dashboard={dashboard} /> : null}
        {view === 'sites' ? <Sites dashboard={dashboard} /> : null}
        {view === 'backlinks' ? <Backlinks dashboard={dashboard} /> : null}
        {view === 'opportunities' ? <Opportunities dashboard={dashboard} /> : null}
        {view === 'strategies' ? <Strategies dashboard={dashboard} /> : null}
        {view === 'acquired' ? <Acquired dashboard={dashboard} /> : null}
      </main>
    </div>
  )
}

type Dashboard = NonNullable<
  Awaited<ReturnType<typeof getHhtBlDashboard>> extends infer Result
    ? Result extends { run: object }
      ? Result
      : never
    : never
>

function Overview({ dashboard }: { dashboard: Dashboard }) {
  const { counts, cost, events, jobs, run, stages } = dashboard
  const measuredUnits = cost?.knownUnits
  const creditValue =
    cost && cost.unknownCalls === 0 && measuredUnits !== null && measuredUnits !== undefined
      ? num(Math.round(measuredUnits))
      : 'Unknown'

  return (
    <>
      <section className="hht-bl-summary" aria-label="Run summary">
        <SummaryMetric label="Candidates" value={counts.candidates} />
        <SummaryMetric label="Research sites" value={counts.researchSites} />
        <SummaryMetric label="Backlinks" value={counts.backlinks} />
        <SummaryMetric label="Opportunities" value={counts.opportunities} />
        <SummaryMetric label="Semrush calls" value={cost?.calls ?? 0} />
        <SummaryMetric label="Credit units" value={creditValue} unknown={creditValue === 'Unknown'} />
      </section>

      <section className="hht-bl-section" aria-labelledby="hht-stage-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-stage-heading">Pipeline progress</h2>
            <p>Current stage: {displayLabel(run.currentStage)}</p>
          </div>
          <span className="hht-bl-section-meta">{stages.length} stages</span>
        </div>
        <ol className="hht-bl-stage-list">
          {stages.map((stage, index) => (
            <li
              key={stage.stage}
              className={stage.stage === run.currentStage ? 'is-current' : undefined}
            >
              <span className="hht-bl-stage-index">{index + 1}</span>
              <span className="hht-bl-stage-name">{displayLabel(stage.stage)}</span>
              <span className={`badge ${statusTone(stage.status)}`}>{stage.status}</span>
              <span className="hht-bl-stage-records">
                {stage.jobs === 0 ? 'No jobs' : `${num(stage.jobs)} jobs · ${num(stage.records)} rows`}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="hht-bl-section" aria-labelledby="hht-jobs-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-jobs-heading">Provider jobs</h2>
            <p>Offsets and account checkpoints</p>
          </div>
          <span className="hht-bl-section-meta">{num(jobs.length)} shown</span>
        </div>
        {jobs.length === 0 ? (
          <Empty>No provider jobs queued.</Empty>
        ) : (
          <TableFrame>
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Stage</th>
                  <th>Report</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th className="num">Offset</th>
                  <th className="num">Rows</th>
                  <th>Account</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="num">#{job.id}</td>
                    <td>{displayLabel(job.stage)}</td>
                    <td className="mono">{job.reportType}</td>
                    <td className="hht-bl-cell-wrap">{job.target ?? NULL_DISPLAY}</td>
                    <td>
                      <span className={`badge ${statusTone(job.status)}`}>
                        {displayLabel(job.status)}
                      </span>
                    </td>
                    <td className="num">{num(job.offset)}</td>
                    <td className="num">{num(job.recordsCompleted)}</td>
                    <td className="mono">{job.accountIdentifier ?? NULL_DISPLAY}</td>
                    <td>{dateTime(job.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>

      <section className="hht-bl-section" aria-labelledby="hht-events-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-events-heading">Run log</h2>
            <p>Collection and processing events</p>
          </div>
          <span className="hht-bl-section-meta">{num(events.length)} shown</span>
        </div>
        {events.length === 0 ? (
          <Empty>No run events recorded.</Empty>
        ) : (
          <ul className="hht-bl-event-list">
            {events.map((event) => (
              <li key={event.id}>
                <span className={`hht-bl-event-level ${event.level}`}>{event.level}</span>
                <span className="hht-bl-event-message">{event.message}</span>
                <span className="hht-bl-event-stage">{displayLabel(event.stage)}</span>
                <time dateTime={event.createdAt.toISOString()}>{dateTime(event.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function SummaryMetric({
  label,
  value,
  unknown = false,
}: {
  label: string
  value: number | string
  unknown?: boolean
}) {
  return (
    <div className={unknown ? 'hht-bl-summary-item is-unknown' : 'hht-bl-summary-item'}>
      <span>{label}</span>
      <strong>{typeof value === 'number' ? num(value) : value}</strong>
    </div>
  )
}

function Sites({ dashboard }: { dashboard: Dashboard }) {
  return (
    <>
      <section className="hht-bl-section" aria-labelledby="hht-research-sites-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-research-sites-heading">Selected research sites</h2>
            <p>Cohort-balanced competitor set</p>
          </div>
          <span className="hht-bl-section-meta">{num(dashboard.researchSites.length)} shown</span>
        </div>
        {dashboard.researchSites.length === 0 ? (
          <Empty>No research sites selected.</Empty>
        ) : (
          <TableFrame>
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th className="num">Rank</th>
                  <th>Domain</th>
                  <th>Cohort</th>
                  <th>Type</th>
                  <th className="num">Research value</th>
                  <th className="num">Authority</th>
                  <th className="num">Traffic</th>
                  <th className="num">Ref. domains</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.researchSites.map((site) => (
                  <tr key={site.id}>
                    <td className="num">{num(site.rank)}</td>
                    <td><ExternalDomain domain={site.domain} /></td>
                    <td>{site.cohort ? displayLabel(site.cohort) : NULL_DISPLAY}</td>
                    <td>{site.siteType ? displayLabel(site.siteType) : NULL_DISPLAY}</td>
                    <td className="num">{score(site.researchValueScore)}</td>
                    <td className="num">{num(site.authorityScore)}</td>
                    <td className="num">{num(site.organicTraffic)}</td>
                    <td className="num">{num(site.referringDomains)}</td>
                    <td className="hht-bl-cell-wrap">{site.selectedReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>

      <section className="hht-bl-section" aria-labelledby="hht-candidates-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-candidates-heading">Candidate sites</h2>
            <p>Discovered and enriched domains</p>
          </div>
          <span className="hht-bl-section-meta">{num(dashboard.candidateSites.length)} shown</span>
        </div>
        {dashboard.candidateSites.length === 0 ? (
          <Empty>No candidate sites discovered.</Empty>
        ) : (
          <TableFrame>
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>State</th>
                  <th>Type</th>
                  <th>Provenance</th>
                  <th className="num">SERPs</th>
                  <th className="num">Top 10</th>
                  <th className="num">Visibility</th>
                  <th className="num">Authority</th>
                  <th className="num">Traffic</th>
                  <th className="num">Ref. domains</th>
                  <th className="num">Transferability</th>
                  <th className="num">Research value</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.candidateSites.map((site) => (
                  <tr key={site.id}>
                    <td><ExternalDomain domain={site.domain} /></td>
                    <td><span className={`badge ${statusTone(site.state)}`}>{displayLabel(site.state)}</span></td>
                    <td>{site.siteType ? displayLabel(site.siteType) : NULL_DISPLAY}</td>
                    <td className="hht-bl-cell-wrap">{site.provenance.map(displayLabel).join(', ') || NULL_DISPLAY}</td>
                    <td className="num">{num(site.serpAppearances)}</td>
                    <td className="num">{num(site.top10Appearances)}</td>
                    <td className="num">{score(site.weightedVisibility)}</td>
                    <td className="num">{num(site.authorityScore)}</td>
                    <td className="num">{num(site.organicTraffic)}</td>
                    <td className="num">{num(site.referringDomains)}</td>
                    <td className="num">{num(site.transferability)}</td>
                    <td className="num" title={site.researchValueMissing?.join(', ')}>
                      {score(site.researchValueScore)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>
    </>
  )
}

function Backlinks({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="hht-bl-section" aria-labelledby="hht-backlinks-heading">
      <div className="hht-bl-section-head">
        <div>
          <h2 id="hht-backlinks-heading">Normalized backlinks</h2>
          <p>Exact source and target records</p>
        </div>
        <span className="hht-bl-section-meta">{num(dashboard.backlinks.length)} shown</span>
      </div>
      {dashboard.backlinks.length === 0 ? (
        <Empty>No backlink rows collected.</Empty>
      ) : (
        <TableFrame>
          <table className="hht-bl-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Referring domain</th>
                <th>Competitor</th>
                <th>Anchor</th>
                <th>Link</th>
                <th>State</th>
                <th>Mechanism</th>
                <th className="num">Authority</th>
                <th className="num">Opportunity</th>
                <th>First seen</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.backlinks.map((backlink) => {
                const follow = followLabel(backlink.follow)
                return (
                  <tr key={backlink.id}>
                    <td className="hht-bl-source-cell">
                      <ExternalUrl href={backlink.sourceUrl} label={backlink.sourceTitle} />
                    </td>
                    <td><ExternalDomain domain={backlink.referringDomain} /></td>
                    <td>{backlink.competitorDomain}</td>
                    <td className="hht-bl-cell-wrap">{backlink.anchor ?? NULL_DISPLAY}</td>
                    <td><span className={`badge ${follow.tone}`}>{follow.label}</span></td>
                    <td><span className={`badge ${statusTone(backlink.state)}`}>{displayLabel(backlink.state)}</span></td>
                    <td>{backlink.mechanism ? displayLabel(backlink.mechanism) : NULL_DISPLAY}</td>
                    <td className="num">{num(backlink.authorityScore)}</td>
                    <td className="num">{score(backlink.overallScore)}</td>
                    <td>{date(backlink.firstSeenAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableFrame>
      )}
    </section>
  )
}

function Opportunities({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="hht-bl-section" aria-labelledby="hht-opportunities-heading">
      <div className="hht-bl-section-head">
        <div>
          <h2 id="hht-opportunities-heading">Ranked opportunities</h2>
          <p>Auditable value, gettability, transferability, and effort scores</p>
        </div>
        <span className="hht-bl-section-meta">{num(dashboard.opportunities.length)} shown</span>
      </div>
      {dashboard.opportunities.length === 0 ? (
        <Empty>No opportunities scored.</Empty>
      ) : (
        <TableFrame>
          <table className="hht-bl-table">
            <thead>
              <tr>
                <th className="num">Rank</th>
                <th>Referring domain</th>
                <th>Mechanism</th>
                <th className="num">Overall</th>
                <th className="num">Link value</th>
                <th className="num">Gettability</th>
                <th className="num">Transfer</th>
                <th className="num">Effort</th>
                <th className="num">Expected value</th>
                <th>Asset</th>
                <th>Recommended action</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.opportunities.map((opportunity) => (
                <tr key={opportunity.id}>
                  <td className="num">{num(opportunity.rank)}</td>
                  <td>
                    <ExternalDomain domain={opportunity.referringDomain} />
                    <div className="hht-bl-subcell">via {opportunity.competitorDomain}</div>
                  </td>
                  <td>{displayLabel(opportunity.mechanism)}</td>
                  <td className="num hht-bl-score-strong">{score(opportunity.overallScore)}</td>
                  <td className="num">{num(opportunity.linkValue)}</td>
                  <td className="num">{num(opportunity.gettability)}</td>
                  <td className="num">{num(opportunity.transferability)}</td>
                  <td className="num">{num(opportunity.effort)}</td>
                  <td className="num">{score(opportunity.expectedValue)}</td>
                  <td>{opportunity.requiresNewAsset ? opportunity.requiredAssetType ?? 'Required' : 'Existing'}</td>
                  <td className="hht-bl-long-cell">{opportunity.recommendedAction}</td>
                  <td className="hht-bl-long-cell">{opportunity.evidence[0] ?? NULL_DISPLAY}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
    </section>
  )
}

function Strategies({ dashboard }: { dashboard: Dashboard }) {
  return (
    <>
      <section className="hht-bl-section" aria-labelledby="hht-strategy-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-strategy-heading">Strategy clusters</h2>
            <p>Observed acquisition mechanisms</p>
          </div>
          <span className="hht-bl-section-meta">{num(dashboard.clusters.length)} shown</span>
        </div>
        {dashboard.clusters.length === 0 ? (
          <Empty>No strategy clusters built.</Empty>
        ) : (
          <TableFrame>
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Mechanism</th>
                  <th className="num">Prospects</th>
                  <th className="num">Sites observed</th>
                  <th className="num">Median authority</th>
                  <th className="num">Link value</th>
                  <th className="num">Gettability</th>
                  <th className="num">Effort</th>
                  <th className="num">Campaign value</th>
                  <th>Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.clusters.map((cluster) => (
                  <tr key={cluster.id}>
                    <td>{displayLabel(cluster.mechanism)}</td>
                    <td className="num">{num(cluster.prospectCount)}</td>
                    <td className="num">{num(cluster.researchSitesObserved)}</td>
                    <td className="num">{score(cluster.medianAuthority)}</td>
                    <td className="num">{score(cluster.averageLinkValue)}</td>
                    <td className="num">{score(cluster.averageGettability)}</td>
                    <td className="num">{score(cluster.averageEffort)}</td>
                    <td className="num hht-bl-score-strong">{score(cluster.estimatedCampaignValue)}</td>
                    <td className="hht-bl-long-cell">{cluster.recommendedCampaign}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>

      <section className="hht-bl-section" aria-labelledby="hht-campaign-heading">
        <div className="hht-bl-section-head">
          <div>
            <h2 id="hht-campaign-heading">Campaign candidates</h2>
            <p>Evidence-backed acquisition motions</p>
          </div>
          <span className="hht-bl-section-meta">{num(dashboard.campaigns.length)} shown</span>
        </div>
        {dashboard.campaigns.length === 0 ? (
          <Empty>No campaign candidates built.</Empty>
        ) : (
          <TableFrame>
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th className="num">Prospects</th>
                  <th className="num">Existing asset</th>
                  <th className="num">New asset</th>
                  <th>Recommendation</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>{campaign.name}</td>
                    <td><span className={`badge ${statusTone(campaign.status)}`}>{displayLabel(campaign.status)}</span></td>
                    <td className="num">{num(campaign.potentialProspects)}</td>
                    <td className="num">{num(campaign.existingAssetSufficient)}</td>
                    <td className="num">{num(campaign.newAssetRequired)}</td>
                    <td className="hht-bl-long-cell">{campaign.recommendation}</td>
                    <td className="hht-bl-long-cell">{campaign.evidence[0] ?? NULL_DISPLAY}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>
    </>
  )
}

function Acquired({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="hht-bl-section" aria-labelledby="hht-acquired-heading">
      <div className="hht-bl-section-head">
        <div>
          <h2 id="hht-acquired-heading">Acquired backlinks</h2>
          <p>Verified links recorded against this research run</p>
        </div>
        <span className="hht-bl-section-meta">{num(dashboard.acquiredLinks.length)} shown</span>
      </div>
      {dashboard.acquiredLinks.length === 0 ? (
        <Empty>No acquired links recorded.</Empty>
      ) : (
        <TableFrame>
          <table className="hht-bl-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Target</th>
                <th>Link</th>
                <th>Mechanism</th>
                <th>Recorded via</th>
                <th>Acquired</th>
                <th>Verified</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.acquiredLinks.map((link) => {
                const follow = followLabel(link.follow)
                return (
                  <tr key={link.id}>
                    <td className="hht-bl-source-cell"><ExternalUrl href={link.sourceUrl} /></td>
                    <td className="hht-bl-source-cell"><ExternalUrl href={link.targetUrl} /></td>
                    <td><span className={`badge ${follow.tone}`}>{follow.label}</span></td>
                    <td>{link.acquisitionMechanism ? displayLabel(link.acquisitionMechanism) : NULL_DISPLAY}</td>
                    <td>{displayLabel(link.recordedVia)}</td>
                    <td>{date(link.acquiredAt)}</td>
                    <td>{date(link.verifiedAt)}</td>
                    <td className="hht-bl-long-cell">{link.verificationEvidence ?? NULL_DISPLAY}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableFrame>
      )}
    </section>
  )
}
