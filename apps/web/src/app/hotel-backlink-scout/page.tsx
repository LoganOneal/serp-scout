import Link from 'next/link'
import {
  HOTEL_BL_CONTENT_TYPES,
  HOTEL_BL_ENTITY_SCOPES,
  HOTEL_BL_OPPORTUNITY_STATUSES,
  HOTEL_BL_RELATIONSHIP_TYPES,
  type HotelBlContentType,
  type HotelBlEntityScope,
  type HotelBlRelationshipType,
} from '@rnr/core'
import {
  db,
  getHotelBlDashboard,
  type HotelBlDashboardView,
  type HotelBlOpportunityFilters,
} from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import {
  importHotelBlInventoryAction,
  retryHotelBlRunAction,
  startHotelBlRunAction,
  updateHotelBlOpportunityAction,
} from './actions'

export const dynamic = 'force-dynamic'

const VIEWS: Array<{ id: HotelBlDashboardView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'hotels', label: 'Hotels' },
  { id: 'domains', label: 'Domains' },
  { id: 'content', label: 'Content Opportunities' },
  { id: 'runs', label: 'Runs' },
]
const VIEW_IDS = new Set(VIEWS.map((view) => view.id))

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function numberFilter(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : undefined
}

function parseFilters(params: SearchParams): HotelBlOpportunityFilters {
  const relationship = one(params['relationship'])
  const contentType = one(params['contentType'])
  const sort = one(params['sort'])
  const direction = one(params['direction'])
  const entityScope = one(params['entityScope'])
  return {
    minimumPriority: numberFilter(one(params['minimumPriority'])),
    minimumFeasibility: numberFilter(one(params['minimumFeasibility'])),
    minimumLinkValue: numberFilter(one(params['minimumLinkValue'])),
    independentOnly: one(params['independentOnly']) === '1',
    chainOnly: one(params['chainOnly']) === '1',
    hasPressPage: one(params['hasPressPage']) === '1',
    hasFollowedPressLinks: one(params['hasFollowedPressLinks']) === '1',
    hasPrContact: one(params['hasPrContact']) === '1',
    relationshipType: HOTEL_BL_RELATIONSHIP_TYPES.includes(relationship as HotelBlRelationshipType)
      ? (relationship as HotelBlRelationshipType)
      : undefined,
    entityScope: HOTEL_BL_ENTITY_SCOPES.includes(entityScope as HotelBlEntityScope)
      ? (entityScope as HotelBlEntityScope)
      : undefined,
    state: one(params['state']) || undefined,
    city: one(params['city']) || undefined,
    contentType: HOTEL_BL_CONTENT_TYPES.includes(contentType as HotelBlContentType)
      ? (contentType as HotelBlContentType)
      : undefined,
    crawlStatus: one(params['crawlStatus']) || undefined,
    sort: ['priority', 'feasibility', 'link_value', 'effort', 'hotel', 'state'].includes(sort ?? '')
      ? (sort as HotelBlOpportunityFilters['sort'])
      : undefined,
    direction: direction === 'asc' || direction === 'desc' ? direction : undefined,
  }
}

function label(value: string | null | undefined): string {
  return value ? value.replaceAll('_', ' ') : NULL_DISPLAY
}

function score(value: number | null | undefined): string {
  return value === null || value === undefined ? NULL_DISPLAY : value.toFixed(1)
}

function date(value: Date | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(value)
}

function dateTime(value: Date | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value)
}

function tone(status: string): string {
  if (['complete', 'approved', 'ready_for_outreach', 'link_acquired'].includes(status)) return 'go'
  if (['failed', 'not_viable', 'rejected'].includes(status)) return 'stop'
  if (['running', 'validating_urls', 'waiting_for_semrush', 'content_needed', 'needs_review'].includes(status)) return 'warn'
  return 'neutral'
}

function dashboardError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/hotel_bl_|relation .+ does not exist/i.test(message)) {
    return 'Database setup is incomplete. Apply Hotel Backlink Scout migrations through 0031_hotel_bl_url_validation.sql, then reload.'
  }
  return 'The workspace could not load. Check the database connection and server logs.'
}

function Metric({ label: metricLabel, value }: { label: string; value: number | string }) {
  return (
    <div className="hht-bl-summary-item">
      <span>{metricLabel}</span>
      <strong>{typeof value === 'number' ? num(value) : value}</strong>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="hht-bl-empty">{children}</div>
}

function TableFrame({ children }: { children: React.ReactNode }) {
  return <div className="hht-bl-table-wrap hotel-bl-table-wrap">{children}</div>
}

function ScoreCell({ value, title }: { value: number; title?: string }) {
  return (
    <td className={value >= 70 ? 'num hht-bl-score-strong' : 'num'} title={title}>
      {score(value)}
    </td>
  )
}

export default async function HotelBacklinkScoutPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const requested = one(params['view']) as HotelBlDashboardView | undefined
  const view = requested && VIEW_IDS.has(requested) ? requested : 'overview'
  const filters = parseFilters(params)
  const result = await getHotelBlDashboard(db(), view, filters).then(
    (dashboard) => ({ dashboard, error: null }),
    (error: unknown) => ({ dashboard: null, error: dashboardError(error) }),
  )
  const message = one(params['message'])
  const messageTone = one(params['tone']) === 'error' ? 'stopbox' : 'gobox'

  if (!result.dashboard) {
    return (
      <div className="hht-bl-page">
        <header className="page-header">
          <h1 className="page-title">Hotel Backlink Scout</h1>
          <p className="page-desc">Hotel inventory → linking entities → evidence-backed opportunities</p>
        </header>
        <HhtSectionTabs active="hotel-backlink-scout" />
        <div className="stopbox" role="alert"><strong>Workspace unavailable.</strong> {result.error}</div>
      </div>
    )
  }

  const dashboard = result.dashboard
  const tabCounts: Partial<Record<HotelBlDashboardView, number>> = dashboard.counts
    ? {
        opportunities: dashboard.counts.highFeasibility,
        hotels: dashboard.counts.hotels,
        domains: dashboard.counts.domains,
      }
    : {}

  return (
    <div className="opp-workspace hht-bl-workspace hotel-bl-workspace">
      <header className="run-page-head hht-bl-head">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Hotel Backlink Scout</h1>
            <p className="page-desc">
              {dashboard.run
                ? `Run #${dashboard.run.id} · ${dashboard.run.sourceFilename ?? 'uploaded inventory'} · Updated ${dateTime(dashboard.run.updatedAt)}`
                : 'Import the HotelHotTubs hotel inventory to begin.'}
            </p>
          </div>
          {dashboard.run ? (
            <div className="hht-bl-run-state">
              <span className={`badge ${tone(dashboard.run.status)}`}>{label(dashboard.run.status)}</span>
              <span className="hht-bl-current-stage">{label(dashboard.run.currentStage)}</span>
            </div>
          ) : null}
        </div>
      </header>

      <HhtSectionTabs active="hotel-backlink-scout" />

      <nav className="hht-bl-tabs" aria-label="Hotel Backlink Scout views">
        {VIEWS.map((item) => (
          <Link
            key={item.id}
            href={item.id === 'overview' ? '/hotel-backlink-scout' : `/hotel-backlink-scout?view=${item.id}`}
            className={`hht-bl-tab${item.id === view ? ' active' : ''}`}
            aria-current={item.id === view ? 'page' : undefined}
          >
            {item.label}
            {tabCounts[item.id] === undefined ? null : <span className="hht-bl-tab-count">{num(tabCounts[item.id]!)}</span>}
          </Link>
        ))}
      </nav>

      {message ? <div className={messageTone} role={messageTone === 'stopbox' ? 'alert' : 'status'}>{message}</div> : null}

      <main className="hht-bl-view">
        {view === 'overview' ? <Overview dashboard={dashboard} /> : null}
        {view === 'opportunities' ? <Opportunities dashboard={dashboard} filters={filters} /> : null}
        {view === 'hotels' ? <Hotels dashboard={dashboard} /> : null}
        {view === 'domains' ? <Domains dashboard={dashboard} /> : null}
        {view === 'content' ? <ContentOpportunities dashboard={dashboard} /> : null}
        {view === 'runs' ? <Runs dashboard={dashboard} /> : null}
      </main>
    </div>
  )
}

type Dashboard = Awaited<ReturnType<typeof getHotelBlDashboard>>

function Overview({ dashboard }: { dashboard: Dashboard }) {
  const counts = dashboard.counts
  return (
    <>
      <section className="hotel-bl-import-card" aria-labelledby="hotel-bl-import-heading">
        <div>
          <h2 id="hotel-bl-import-heading">Import hotel inventory</h2>
          <p>Upload the full source CSV. Raw columns are preserved; duplicate hotels and shared domains are normalized before any crawl is queued.</p>
        </div>
        <form action={importHotelBlInventoryAction} className="hotel-bl-import-form">
          <label>
            <span>Run name <small>(optional)</small></span>
            <input name="runName" type="text" placeholder="August hotel inventory" />
          </label>
          <label>
            <span>Hotel CSV</span>
            <input name="inventory" type="file" accept=".csv,text/csv" required />
          </label>
          <button className="primary" type="submit">Import inventory</button>
        </form>
      </section>

      {!counts ? (
        <Empty>No inventory run exists yet.</Empty>
      ) : (
        <>
          <section className="hht-bl-summary hotel-bl-summary" aria-label="Cohort summary">
            <Metric label="Hotels" value={counts.hotels} />
            <Metric label="Unique domains" value={counts.domains} />
            <Metric label="Hotel domains" value={counts.hotelDomains} />
            <Metric label="Locality domains" value={counts.localityDomains} />
            <Metric label="Other domains" value={counts.otherDomains} />
            <Metric label="URLs validated" value={counts.validatedUrls} />
            <Metric label="URL discrepancies" value={counts.discrepantUrls} />
            <Metric label="Analyzed domains" value={counts.analyzedDomains} />
            <Metric label="Pending domains" value={counts.pendingDomains} />
            <Metric label="High feasibility" value={counts.highFeasibility} />
            <Metric label="High priority" value={counts.highPriority} />
            <Metric label="Hotels with press pages" value={counts.pressPages} />
            <Metric label="Followed media links" value={counts.followedMediaDomains} />
            <Metric label="PR contacts" value={counts.prContacts} />
            <Metric label="Management companies" value={counts.managementCompanies} />
            <Metric label="Owners" value={counts.owners} />
            <Metric label="New referring domains" value={counts.newReferringDomains} />
            <Metric label="Links acquired" value={counts.acquired} />
          </section>

          <section className="hotel-bl-breakdowns" aria-label="Cohort breakdowns">
            <Breakdown title="Entity role" rows={dashboard.breakdowns.roles} />
            <Breakdown title="Site control" rows={dashboard.breakdowns.controls} />
            <Breakdown title="Feasibility band" rows={dashboard.breakdowns.feasibility} />
            <Breakdown title="Top states" rows={dashboard.breakdowns.states} />
            <Breakdown title="Recommended treatment" rows={dashboard.breakdowns.treatments} />
          </section>

          <section className="hht-bl-section" aria-labelledby="hotel-bl-progress-heading">
            <div className="hht-bl-section-head">
              <div>
                <h2 id="hotel-bl-progress-heading">Current run</h2>
                <p>Every domain failure is isolated and retryable.</p>
              </div>
              <Link href="/hotel-backlink-scout?view=runs" className="button-link">Open run history</Link>
            </div>
            <dl className="hotel-bl-run-facts">
              <div><dt>Status</dt><dd>{label(dashboard.run?.status)}</dd></div>
              <div><dt>Stage</dt><dd>{label(dashboard.run?.currentStage)}</dd></div>
              <div><dt>Started</dt><dd>{dateTime(dashboard.run?.startedAt)}</dd></div>
              <div><dt>Source</dt><dd>{dashboard.run?.sourceFilename ?? NULL_DISPLAY}</dd></div>
            </dl>
          </section>
        </>
      )}
    </>
  )
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ label: string | null; count: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.count))
  return (
    <section className="hotel-bl-breakdown">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="muted">No data yet.</p> : (
        <ul>
          {rows.map((row) => (
            <li key={row.label ?? 'unknown'}>
              <span>{label(row.label)}</span>
              <span className="hotel-bl-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} /></span>
              <strong>{num(row.count)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Opportunities({ dashboard, filters }: { dashboard: Dashboard; filters: HotelBlOpportunityFilters }) {
  const exportParams = new URLSearchParams({ view: 'opportunities' })
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== false) exportParams.set(key, value === true ? '1' : String(value))
  return (
    <section className="hht-bl-section" aria-labelledby="hotel-bl-opportunities-heading">
      <div className="hht-bl-section-head">
        <div>
          <h2 id="hotel-bl-opportunities-heading">Ranked backlink opportunities</h2>
          <p>One row per hotel × linking entity, with independent feasibility and SEO value.</p>
        </div>
        <a className="button-link" href={`/api/hotel-backlink-scout/export?${exportParams}`}>Export filtered CSV</a>
      </div>
      <OpportunityFilters filters={filters} states={dashboard.filterOptions.states} cities={dashboard.filterOptions.cities} />
      {dashboard.opportunities.length === 0 ? <Empty>No opportunities match these filters.</Empty> : (
        <TableFrame>
          <table className="hht-bl-table hotel-bl-opportunities-table">
            <thead><tr>
              <th className="num">Priority</th><th>Hotel</th><th>Location</th><th>Brand</th><th>Target entity</th><th>Entity role</th><th>Relationship</th><th>URL validation</th><th>Target domain</th><th>Site control</th><th className="num">Feasibility</th><th className="num">Link value</th><th className="num">Content fit</th><th className="num">Effort</th><th>Press page</th><th className="num">Press links</th><th className="num">Followed</th><th>Latest activity</th><th>PR/contact</th><th>Recommended content</th><th>Recommended pitch</th><th>Status</th>
            </tr></thead>
            <tbody>{dashboard.opportunities.map((row) => (
              <tr key={row.id} className="hotel-bl-data-row">
                <ScoreCell value={row.priorityScore} title={row.reasoningSummary ?? undefined} />
                <td><Link href={`/hotel-backlink-scout/hotels/${row.hotelId}`}>{row.hotelName}</Link>{row.needsReview ? <span className="badge warn">review</span> : null}</td>
                <td>{[row.city, row.state].filter(Boolean).join(', ') || NULL_DISPLAY}</td>
                <td>{row.brandName ?? NULL_DISPLAY}</td>
                <td>{row.targetEntity ?? NULL_DISPLAY}</td>
                <td><span className={`badge ${row.entityScope === 'hotel' ? 'go' : row.entityScope === 'locality' ? 'warn' : 'neutral'}`}>{label(row.entityScope)}</span><br /><small>{label(row.entityType)}</small></td>
                <td>{label(row.relationshipType)}</td>
                <td title={row.urlValidationReason ?? undefined}>{label(row.urlValidationStatus)}{row.urlValidationConfidence === null ? null : ` · ${Math.round(row.urlValidationConfidence * 100)}%`}</td>
                <td><Link href={`/hotel-backlink-scout/domains/${row.domainId}`} className="mono">{row.domain}</Link></td>
                <td>{label(row.siteControlType)}</td>
                <ScoreCell value={row.feasibilityScore} title={JSON.stringify(row.feasibilityComponents)} />
                <ScoreCell value={row.linkValueScore} title={JSON.stringify(row.linkValueComponents)} />
                <ScoreCell value={row.contentFitScore} title={JSON.stringify(row.contentFitComponents)} />
                <td className="num">{score(row.effortScore)}</td>
                <td>{row.hasPressPage ? <span className="badge go">yes</span> : <span className="badge neutral">no</span>}</td>
                <td className="num">{num(row.externalPressLinkCount)}</td>
                <td className="num">{num(row.dofollowExternalPressLinkCount)}</td>
                <td>{date(row.latestPressDate)}</td>
                <td>{row.hasPrContact ? <span className="badge go">available</span> : NULL_DISPLAY}</td>
                <td>
                  <form action={updateHotelBlOpportunityAction} className="hotel-bl-inline-form">
                    <input type="hidden" name="opportunityId" value={row.id} />
                    <select name="treatment" defaultValue={row.manualRecommendedContentType ?? row.recommendedContentType ?? ''} aria-label={`Content treatment for ${row.hotelName}`}>
                      {HOTEL_BL_CONTENT_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}
                    </select>
                    <button type="submit">Save</button>
                  </form>
                </td>
                <td className="hht-bl-long-cell">{row.recommendedPitchAngle ?? NULL_DISPLAY}</td>
                <td>
                  <form action={updateHotelBlOpportunityAction} className="hotel-bl-inline-form">
                    <input type="hidden" name="opportunityId" value={row.id} />
                    <select name="status" defaultValue={row.status} aria-label={`Status for ${row.hotelName}`}>
                      {HOTEL_BL_OPPORTUNITY_STATUSES.map((status) => <option key={status} value={status}>{label(status)}</option>)}
                    </select>
                    <button type="submit">Save</button>
                  </form>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </TableFrame>
      )}
    </section>
  )
}

function OpportunityFilters({ filters, states, cities }: { filters: HotelBlOpportunityFilters; states: string[]; cities: string[] }) {
  return (
    <form method="get" className="hotel-bl-filters" aria-label="Opportunity filters">
      <input type="hidden" name="view" value="opportunities" />
      <label><span>Min priority</span><input type="number" name="minimumPriority" min="0" max="100" defaultValue={filters.minimumPriority} /></label>
      <label><span>Min feasibility</span><input type="number" name="minimumFeasibility" min="0" max="100" defaultValue={filters.minimumFeasibility} /></label>
      <label><span>Min link value</span><input type="number" name="minimumLinkValue" min="0" max="100" defaultValue={filters.minimumLinkValue} /></label>
      <label><span>Relationship</span><select name="relationship" defaultValue={filters.relationshipType ?? ''}><option value="">All</option>{HOTEL_BL_RELATIONSHIP_TYPES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label><span>Entity role</span><select name="entityScope" defaultValue={filters.entityScope ?? ''}><option value="">All</option>{HOTEL_BL_ENTITY_SCOPES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label><span>State</span><select name="state" defaultValue={filters.state ?? ''}><option value="">All</option>{states.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><span>City</span><select name="city" defaultValue={filters.city ?? ''}><option value="">All</option>{cities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><span>Content</span><select name="contentType" defaultValue={filters.contentType ?? ''}><option value="">All</option>{HOTEL_BL_CONTENT_TYPES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label><span>Crawl status</span><select name="crawlStatus" defaultValue={filters.crawlStatus ?? ''}><option value="">All</option>{['pending', 'running', 'complete', 'failed'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><span>Sort</span><select name="sort" defaultValue={filters.sort ?? 'priority'}>{['priority', 'feasibility', 'link_value', 'effort', 'hotel', 'state'].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label><span>Direction</span><select name="direction" defaultValue={filters.direction ?? 'desc'}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
      <label className="hotel-bl-check"><input type="checkbox" name="independentOnly" value="1" defaultChecked={filters.independentOnly} /><span>Independent only</span></label>
      <label className="hotel-bl-check"><input type="checkbox" name="chainOnly" value="1" defaultChecked={filters.chainOnly} /><span>Chain/brand</span></label>
      <label className="hotel-bl-check"><input type="checkbox" name="hasPressPage" value="1" defaultChecked={filters.hasPressPage} /><span>Has press page</span></label>
      <label className="hotel-bl-check"><input type="checkbox" name="hasFollowedPressLinks" value="1" defaultChecked={filters.hasFollowedPressLinks} /><span>Followed press links</span></label>
      <label className="hotel-bl-check"><input type="checkbox" name="hasPrContact" value="1" defaultChecked={filters.hasPrContact} /><span>Has PR contact</span></label>
      <div className="hotel-bl-filter-actions"><button className="primary" type="submit">Apply filters</button><Link href="/hotel-backlink-scout?view=opportunities">Clear</Link></div>
    </form>
  )
}

function Hotels({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="hht-bl-section" aria-labelledby="hotel-bl-hotels-heading">
      <div className="hht-bl-section-head"><div><h2 id="hotel-bl-hotels-heading">Hotels</h2><p>Every imported candidate URL is checked against its HotelHotTubs listing identity.</p></div><div><span className="hht-bl-section-meta">{num(dashboard.hotels.length)} shown</span> <a className="button-link" href="/api/hotel-backlink-scout/validation-export">Export all validations</a></div></div>
      {dashboard.hotels.length === 0 ? <Empty>No hotels imported.</Empty> : <TableFrame><table className="hht-bl-table"><thead><tr><th>Hotel</th><th>City</th><th>State</th><th>Candidate role</th><th>URL validation</th><th>Listing matched</th><th>Candidate URL</th><th>Canonical hotel domain</th><th className="num">Opportunities</th><th className="num">Top priority</th><th>Review</th></tr></thead><tbody>{dashboard.hotels.map((hotel) => <tr key={hotel.id} className="hotel-bl-data-row"><td><Link href={`/hotel-backlink-scout/hotels/${hotel.id}`}>{hotel.hotelName}</Link></td><td>{hotel.city ?? NULL_DISPLAY}</td><td>{hotel.state ?? NULL_DISPLAY}</td><td><span className={`badge ${hotel.sourceEntityScope === 'hotel' ? 'go' : hotel.sourceEntityScope === 'locality' ? 'warn' : 'neutral'}`}>{label(hotel.sourceEntityScope)}</span><br /><small>{label(hotel.sourceEntityType)}</small></td><td title={hotel.urlValidationReason ?? undefined}>{label(hotel.urlValidationStatus)}{hotel.urlValidationConfidence === null ? null : ` · ${Math.round(hotel.urlValidationConfidence * 100)}%`}</td><td>{hotel.listingMatched === null ? NULL_DISPLAY : hotel.listingMatched ? 'yes' : 'no'}</td><td className="mono hht-bl-cell-wrap">{hotel.sourceUrl ? <a href={hotel.candidateFinalUrl ?? hotel.sourceUrl} target="_blank" rel="noreferrer">{hotel.candidateFinalUrl ?? hotel.sourceUrl}</a> : NULL_DISPLAY}</td><td className="mono">{hotel.canonicalPropertyDomain ?? NULL_DISPLAY}</td><td className="num">{num(hotel.opportunities)}</td><td className="num hht-bl-score-strong">{score(hotel.maxPriority)}</td><td>{hotel.needsReview ? <span className="badge warn">needs review</span> : NULL_DISPLAY}</td></tr>)}</tbody></table></TableFrame>}
    </section>
  )
}

function Domains({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="hht-bl-section" aria-labelledby="hotel-bl-domains-heading">
      <div className="hht-bl-section-head"><div><h2 id="hotel-bl-domains-heading">Domains</h2><p>Canonical crawl targets shared across the inventory.</p></div><span className="hht-bl-section-meta">{num(dashboard.domains.length)} shown</span></div>
      {dashboard.domains.length === 0 ? <Empty>No domains discovered.</Empty> : <TableFrame><table className="hht-bl-table"><thead><tr><th>Domain</th><th>Entity</th><th>Role</th><th>Type</th><th className="num">Hotels</th><th>Site control</th><th>Crawl</th><th>Press</th><th className="num">External press</th><th className="num">Followed</th><th className="num">Follow ratio</th><th>Latest press</th><th>PR email</th><th className="num">Authority</th><th className="num">Traffic</th><th className="num">Ref. domains</th></tr></thead><tbody>{dashboard.domains.map((domain) => <tr key={domain.id} className="hotel-bl-data-row"><td><Link href={`/hotel-backlink-scout/domains/${domain.id}`} className="mono">{domain.domain}</Link></td><td>{domain.entityName ?? NULL_DISPLAY}</td><td><span className={`badge ${domain.entityScope === 'hotel' ? 'go' : domain.entityScope === 'locality' ? 'warn' : 'neutral'}`}>{label(domain.entityScope)}</span></td><td>{label(domain.entityType)}</td><td className="num">{num(domain.hotelCount)}</td><td>{label(domain.manualSiteControlType ?? domain.siteControlType)}</td><td><span className={`badge ${tone(domain.crawlStatus)}`}>{label(domain.crawlStatus)}</span></td><td>{domain.hasPressPage ? 'yes' : 'no'}</td><td className="num">{num(domain.externalPressLinkCount)}</td><td className="num">{num(domain.dofollowExternalPressLinkCount)}</td><td className="num">{domain.pressLinkRatio === null ? NULL_DISPLAY : `${Math.round(domain.pressLinkRatio * 100)}%`}</td><td>{date(domain.latestPressDate)}</td><td>{domain.hasPrEmail ? 'yes' : 'no'}</td><td className="num">{num(domain.authorityScore)}</td><td className="num">{num(domain.organicTraffic)}</td><td className="num">{num(domain.referringDomains)}</td></tr>)}</tbody></table></TableFrame>}
    </section>
  )
}

function ContentOpportunities({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="hht-bl-section" aria-labelledby="hotel-bl-content-heading">
      <div className="hht-bl-section-head"><div><h2 id="hotel-bl-content-heading">Content opportunities</h2><p>Editorial assets ranked by realistic aggregate backlink value.</p></div><span className="hht-bl-section-meta">{num(dashboard.contentOpportunities.length)} shown</span></div>
      {dashboard.contentOpportunities.length === 0 ? <Empty>Clusters appear after at least two hotels share a city or state.</Empty> : <TableFrame><table className="hht-bl-table"><thead><tr><th className="num">ROI</th><th>Topic</th><th>Type</th><th>Geography</th><th className="num">Hotels</th><th className="num">High feasibility</th><th className="num">Strong press</th><th className="num">Aggregate value</th><th className="num">New ref. domains</th><th className="num">Effort</th><th>Suggested slug</th><th>Status</th></tr></thead><tbody>{dashboard.contentOpportunities.map((item) => <tr key={item.id}><td className="num hht-bl-score-strong">{score(item.contentRoiScore)}</td><td>{item.topic}</td><td>{label(item.contentType)}</td><td>{item.geography ?? NULL_DISPLAY}</td><td className="num">{num(item.hotelCount)}</td><td className="num">{num(item.highFeasibilityHotelCount)}</td><td className="num">{num(item.strongPressBehaviorCount)}</td><td className="num">{score(item.aggregateOpportunityValue)}</td><td className="num">{num(item.newReferringDomains)}</td><td className="num">{score(item.estimatedEffort)}</td><td className="mono">/{item.suggestedSlug}</td><td><span className={`badge ${tone(item.status)}`}>{label(item.status)}</span></td></tr>)}</tbody></table></TableFrame>}
    </section>
  )
}

function Runs({ dashboard }: { dashboard: Dashboard }) {
  const run = dashboard.run
  const failed = dashboard.jobs.filter((job) => job.status === 'failed').length
  return (
    <>
      {run ? <section className="hotel-bl-run-controls" aria-label="Run controls"><form action={startHotelBlRunAction}><input type="hidden" name="runId" value={run.id} /><button className="primary" type="submit">{run.status === 'ready' ? 'Start analysis run' : 'Resume local stages'}</button></form>{failed > 0 ? <form action={retryHotelBlRunAction}><input type="hidden" name="runId" value={run.id} /><button type="submit">Retry {failed} failed domain{failed === 1 ? '' : 's'}</button></form> : null}<p>Crawling runs in Trigger.dev when configured. Semrush jobs remain explicit checkpoints so paid calls are never issued by a browser request.</p></section> : null}
      <section className="hht-bl-section" aria-labelledby="hotel-bl-runs-heading"><div className="hht-bl-section-head"><div><h2 id="hotel-bl-runs-heading">Run history</h2><p>Imports, durable stage state, failures, retries, and paid-provider usage.</p></div></div>{dashboard.runs.length === 0 ? <Empty>No runs yet.</Empty> : <TableFrame><table className="hht-bl-table"><thead><tr><th>Run</th><th>Name</th><th>Source</th><th>Status</th><th>Stage</th><th>API usage</th><th>Created</th><th>Updated</th><th>Error</th></tr></thead><tbody>{dashboard.runs.map((item) => <tr key={item.id}><td className="num">#{item.id}</td><td>{item.name}</td><td>{item.sourceFilename ?? NULL_DISPLAY}</td><td><span className={`badge ${tone(item.status)}`}>{label(item.status)}</span></td><td>{label(item.currentStage)}</td><td className="mono hht-bl-cell-wrap">{Object.keys(item.externalApiUsage).length > 0 ? JSON.stringify(item.externalApiUsage) : NULL_DISPLAY}</td><td>{dateTime(item.createdAt)}</td><td>{dateTime(item.updatedAt)}</td><td className="hht-bl-cell-wrap">{item.error ?? NULL_DISPLAY}</td></tr>)}</tbody></table></TableFrame>}</section>
      <section className="hht-bl-section" aria-labelledby="hotel-bl-jobs-heading"><div className="hht-bl-section-head"><div><h2 id="hotel-bl-jobs-heading">Stage jobs</h2><p>Per-domain checkpoints; Semrush enrichment is intentionally manual/provider-gated.</p></div><span className="hht-bl-section-meta">{num(dashboard.jobs.length)} shown</span></div>{dashboard.jobs.length === 0 ? <Empty>No jobs queued.</Empty> : <TableFrame><table className="hht-bl-table"><thead><tr><th>Job</th><th>Stage</th><th>Status</th><th className="num">Attempts</th><th className="num">Records</th><th>Updated</th><th>Error</th></tr></thead><tbody>{dashboard.jobs.map((job) => <tr key={job.id}><td className="num">#{job.id}</td><td>{label(job.stage)}</td><td><span className={`badge ${tone(job.status)}`}>{label(job.status)}</span></td><td className="num">{num(job.attempts)}</td><td className="num">{num(job.recordsProcessed)}</td><td>{dateTime(job.updatedAt)}</td><td className="hht-bl-cell-wrap">{job.error ?? NULL_DISPLAY}</td></tr>)}</tbody></table></TableFrame>}</section>
      <section className="hht-bl-section" aria-labelledby="hotel-bl-events-heading"><div className="hht-bl-section-head"><div><h2 id="hotel-bl-events-heading">Run log</h2><p>Domain failures never stop the cohort.</p></div></div>{dashboard.events.length === 0 ? <Empty>No events recorded.</Empty> : <ul className="hht-bl-event-list">{dashboard.events.map((event) => <li key={event.id}><span className={`hht-bl-event-level ${event.level}`}>{event.level}</span><span className="hht-bl-event-message">{event.message}</span><span className="hht-bl-event-stage">{label(event.stage)}</span><time dateTime={event.createdAt.toISOString()}>{dateTime(event.createdAt)}</time></li>)}</ul>}</section>
    </>
  )
}
