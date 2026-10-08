import Link from 'next/link'
import {
  HHT_OPP_DISCOVERY_DEFAULTS,
  HHT_OPP_DISCOVERY_STRATEGY_ORDER,
  HHT_OPP_TYPE_LABELS,
  expandQueryTemplates,
  type HhtOppEligibility,
  type HhtOppSeoRisk,
  type HhtOppStatus,
  type HhtOppStrategy,
  type HhtOppType,
} from '@rnr/core'
import {
  FILTER_ENUMS,
  db,
  hhtOppStats,
  listDiscoveryRuns,
  listGuestKeywords,
  listHhtOppOpportunities,
  listStaleHhtOppOpportunities,
  parseDiscoveryRunNotes,
  queryOr,
  strategyYield,
  type GuestKeywordRow,
  type HhtOppDashboardView,
  type HhtOppFilters,
} from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import {
  discoverHhtOppMentionsAction,
  enrichHhtOppQualifiedAction,
  enrichHhtOppSelectedAction,
  expandHhtOppGraphAction,
  expandHhtOppKeywordIdeasAction,
  mineHhtOppCompetitorsAction,
  mineHhtOppDirectoriesAction,
  refreshStaleHhtOppAction,
  researchHhtOppSeedsAction,
  scanHhtOppBrokenLinksAction,
  startHhtOppDiscoveryAction,
} from './actions'

export const dynamic = 'force-dynamic'

const VIEWS: Array<{ id: HhtOppDashboardView; label: string }> = [
  { id: 'opportunities', label: 'Blogs' },
  { id: 'strategies', label: 'Searches' },
  { id: 'queries', label: 'Query templates' },
]

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function numberFilter(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseFilters(params: SearchParams): HhtOppFilters {
  const type = one(params['type'])
  const eligibility = one(params['eligibility'])
  const seoRisk = one(params['seoRisk'])
  const strategy = one(params['strategy'])
  const status = one(params['status'])
  const paid = one(params['paid'])
  const sort = one(params['sort'])
  const direction = one(params['direction'])
  const contacted = one(params['contacted'])
  return {
    type: FILTER_ENUMS.types.includes(type as HhtOppType) ? (type as HhtOppType) : undefined,
    eligibility: FILTER_ENUMS.eligibility.includes(eligibility as HhtOppEligibility)
      ? (eligibility as HhtOppEligibility)
      : undefined,
    seoRisk: FILTER_ENUMS.risks.includes(seoRisk as HhtOppSeoRisk) ? (seoRisk as HhtOppSeoRisk) : undefined,
    strategy: FILTER_ENUMS.strategies.includes(strategy as HhtOppStrategy) ? (strategy as HhtOppStrategy) : undefined,
    status: FILTER_ENUMS.statuses.includes(status as HhtOppStatus) ? (status as HhtOppStatus) : undefined,
    paid: paid === 'free' || paid === 'paid' ? paid : 'all',
    maxPrice: numberFilter(one(params['maxPrice'])),
    minAuthority: numberFilter(one(params['minAuthority'])),
    minTraffic: numberFilter(one(params['minTraffic'])),
    minReferringDomains: numberFilter(one(params['minReferring'])),
    minScore: numberFilter(one(params['minScore'])),
    contextual: one(params['contextual']) === '1',
    dofollow: one(params['dofollow']) === '1',
    forum: one(params['forum']) === '1',
    contacted: contacted === 'yes' || contacted === 'no' ? contacted : undefined,
    sort: ['score', 'authority', 'traffic', 'referring', 'outbound', 'price', 'checked'].includes(sort ?? '')
      ? (sort as HhtOppFilters['sort'])
      : 'checked',
    direction: direction === 'asc' || direction === 'desc' ? direction : 'desc',
  }
}

function label(value: string | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return HHT_OPP_TYPE_LABELS[value as HhtOppType] ?? value.replaceAll('_', ' ')
}

function date(value: Date | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(value)
}

function tone(status: string): string {
  if (['PASS', 'ENRICHED', 'DRAFT_READY', 'PLACED', 'APPROVED'].includes(status)) return 'go'
  if (['FAIL', 'REJECTED', 'ARCHIVED'].includes(status)) return 'stop'
  if (['REVIEW', 'RESEARCHING', 'QUOTED', 'NEGOTIATING'].includes(status)) return 'warn'
  return 'neutral'
}

export default async function HhtOppPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const view = (one(params['view']) as HhtOppDashboardView | undefined) ?? 'opportunities'
  const filters = parseFilters(params)
  const message = one(params['message'])
  const messageTone = one(params['tone']) === 'error' ? 'stopbox' : 'okbox'

  const [stats, rows, keywords, strategies, runs, stale] = await Promise.all([
    queryOr('hhtOppStats', () => hhtOppStats(db()), {
      domains: 0,
      opportunities: 0,
      pass: 0,
      review: 0,
      fail: 0,
      drafts: 0,
    }),
    queryOr('listHhtOppOpportunities', () => listHhtOppOpportunities(db(), filters), []),
    queryOr('listGuestKeywords', () => listGuestKeywords(db()), []),
    queryOr('strategyYield', () => strategyYield(db()), []),
    queryOr('listDiscoveryRuns', () => listDiscoveryRuns(db()), []),
    queryOr('listStaleHhtOppOpportunities', () => listStaleHhtOppOpportunities(db()), []),
  ])

  const selectedDomainIds = [...new Set(rows.filter((row) => row.eligibility === 'PASS' || row.status === 'REVIEW').map((row) => row.domainId))]

  return (
    <div className="opp-workspace hht-bl-workspace hht-opp-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <h1 className="page-title">Opportunity Engine</h1>
          <p className="page-desc">
            Finds travel blogs that might be worth pitching, and pulls new keyword ideas from the Google Ads Keyword Ideas endpoint.
          </p>
        </div>
      </header>

      <HhtSectionTabs active="opportunity-engine" />

      <nav className="hht-bl-tabs" aria-label="Opportunity Engine views">
        {VIEWS.map((item) => (
          <Link
            key={item.id}
            href={item.id === 'opportunities' ? '/hht-opp' : `/hht-opp?view=${item.id}`}
            className={`hht-bl-tab${item.id === view ? ' active' : ''}`}
            aria-current={item.id === view ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {message ? (
        <div className={messageTone} role={messageTone === 'stopbox' ? 'alert' : 'status'}>
          {message}
        </div>
      ) : null}

      <main className="hht-bl-view">
        <section className="hht-bl-summary hotel-bl-summary" aria-label="Opportunity summary">
          <Metric label="Domains" value={stats.domains} />
          <Metric label="Opportunities" value={stats.opportunities} />
          <Metric label="Keywords" value={keywords.length} />
        </section>

        {view === 'opportunities' ? (
          <>
            <section className="hotel-bl-import-card hht-opp-seed-card" aria-labelledby="hht-opp-seed-heading">
              <div>
                <h2 id="hht-opp-seed-heading">Research seed URLs</h2>
                <p>
                  Paste publisher pages — write-for-us, advertise, media kit, resource lists. The crawler classifies the opportunity, extracts requirements and public prices, and never invents a figure.
                </p>
              </div>
              <form action={researchHhtOppSeedsAction} className="hht-opp-seed-form">
                <label>
                  <span>URLs (one per line, max 5)</span>
                  <textarea name="urls" rows={4} placeholder="https://example.com/write-for-us" required />
                </label>
                <button className="primary" type="submit">
                  Research URLs
                </button>
              </form>
            </section>

            <DiscoveryForm />

            <KeywordIdeas keywords={keywords} />

            <div className="hht-opp-toolbar">
              <form action={enrichHhtOppSelectedAction}>
                <input type="hidden" name="domainIds" value={selectedDomainIds.join(',')} />
                <button type="submit">Enrich selected</button>
              </form>
              <form action={enrichHhtOppQualifiedAction}>
                <button type="submit">Enrich all qualified</button>
              </form>
              <form action={refreshStaleHhtOppAction}>
                <button type="submit">Refresh stale ({stale.length})</button>
              </form>
              <p>Semrush Authority Score (not Moz DA) and inbound/outbound ratio enrich automatically once a guest-post or paid-placement page is verified. Repeat calls are skipped for 30 days.</p>
            </div>

            <Filters filters={filters} />

            {rows.length === 0 ? (
              <div className="hht-bl-empty">No opportunities yet. Seed a publisher URL to begin.</div>
            ) : (
              <div className="hht-bl-table-wrap">
                <table className="hht-bl-table hht-opp-table">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th>Opportunity type</th>
                      <th>Status</th>
                      <th className="num">Authority</th>
                      <th className="num">Organic traffic</th>
                      <th className="num">Referring domains</th>
                      <th className="num">Inbound</th>
                      <th className="num">In/out</th>
                      <th className="num">Avg outbound</th>
                      <th>Link type</th>
                      <th>Price</th>
                      <th>Requirements</th>
                      <th>Last checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <Link href={`/hht-opp/${row.id}`} className="hht-bl-domain">
                            {row.site}
                          </Link>
                          {row.opportunityType === 'forum_ugc' ? (
                            <div>
                              <span className="badge">Forum</span>
                            </div>
                          ) : null}
                          <div className="hht-bl-subcell">{row.displayName}</div>
                        </td>
                        <td>
                          {label(row.opportunityType)}
                          {row.inventedTypeName ? <div className="hht-bl-subcell">{row.inventedTypeName}</div> : null}
                        </td>
                        <td>
                          <span className={`badge ${tone(row.status)}`}>{row.status}</span>
                        </td>
                        <td className="num">{num(row.authorityScore)}</td>
                        <td className="num">{num(row.organicTraffic)}</td>
                        <td className="num">{num(row.referringDomains)}</td>
                        <td className="num" title="Semrush inbound links for the root domain.">
                          {num(row.inboundLinks)}
                        </td>
                        <td
                          className="num"
                          title="Semrush inbound links ÷ average external links on sampled pages. Empty if either side is missing."
                        >
                          {row.inboundOutboundRatio == null ? NULL_DISPLAY : row.inboundOutboundRatio.toFixed(1)}
                        </td>
                        <td className="num" title="Average external links on sampled pages, not a sitewide total.">
                          {row.avgOutboundLinks == null ? NULL_DISPLAY : row.avgOutboundLinks.toFixed(1)}
                        </td>
                        <td>{row.linkType.replaceAll('_', ' ')}</td>
                        <td>
                          {row.priceLabel}
                          {row.priceStatus === 'QUOTE_REQUIRED' ? <div className="hht-bl-subcell">No public price</div> : null}
                        </td>
                        <td className="hht-bl-long-cell">
                          {row.requirementsSummary.length === 0
                            ? NULL_DISPLAY
                            : row.requirementsSummary.slice(0, 4).map((line) => (
                                <div key={line}>{line}</div>
                              ))}
                        </td>
                        <td>{date(row.lastCheckedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        {view === 'strategies' ? <Strategies rows={strategies} runs={runs} stale={stale.length} /> : null}
        {view === 'queries' ? <QueryTemplates /> : null}
      </main>
    </div>
  )
}

function Metric({ label: metricLabel, value }: { label: string; value: number }) {
  return (
    <div className="hht-bl-summary-item">
      <span>{metricLabel}</span>
      <strong>{num(value)}</strong>
    </div>
  )
}

function Filters({ filters }: { filters: HhtOppFilters }) {
  return (
    <form method="get" className="hotel-bl-filters hht-opp-filters" aria-label="Opportunity filters">
      <label>
        <span>Type</span>
        <select name="type" defaultValue={filters.type ?? ''}>
          <option value="">All</option>
          {FILTER_ENUMS.types.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Free / paid</span>
        <select name="paid" defaultValue={filters.paid ?? 'all'}>
          <option value="all">All</option>
          <option value="free">Free / unknown</option>
          <option value="paid">Paid or quote</option>
        </select>
      </label>
      <label>
        <span>Max price</span>
        <input type="number" name="maxPrice" min="0" defaultValue={filters.maxPrice} />
      </label>
      <label>
        <span>Min Authority Score</span>
        <input type="number" name="minAuthority" min="0" defaultValue={filters.minAuthority} />
      </label>
      <label>
        <span>Min traffic</span>
        <input type="number" name="minTraffic" min="0" defaultValue={filters.minTraffic} />
      </label>
      <label>
        <span>Min referring domains</span>
        <input type="number" name="minReferring" min="0" defaultValue={filters.minReferringDomains} />
      </label>
      <label>
        <span>Strategy</span>
        <select name="strategy" defaultValue={filters.strategy ?? ''}>
          <option value="">All</option>
          {FILTER_ENUMS.strategies.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Contacted</span>
        <select name="contacted" defaultValue={filters.contacted ?? ''}>
          <option value="">All</option>
          <option value="no">Not contacted</option>
          <option value="yes">Contacted</option>
        </select>
      </label>
      <label>
        <span>Sort</span>
        <select name="sort" defaultValue={filters.sort === 'score' ? 'checked' : filters.sort ?? 'checked'}>
          <option value="authority">Authority Score</option>
          <option value="traffic">Organic traffic</option>
          <option value="referring">Referring domains</option>
          <option value="outbound">Avg outbound</option>
          <option value="price">Price</option>
          <option value="checked">Last checked</option>
        </select>
      </label>
      <label>
        <span>Direction</span>
        <select name="direction" defaultValue={filters.direction ?? 'desc'}>
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </label>
      <label className="hotel-bl-check">
        <input type="checkbox" name="contextual" value="1" defaultChecked={filters.contextual} />
        <span>Contextual link</span>
      </label>
      <label className="hotel-bl-check">
        <input type="checkbox" name="dofollow" value="1" defaultChecked={filters.dofollow} />
        <span>Dofollow (includes UGC)</span>
      </label>
      <label className="hotel-bl-check">
        <input type="checkbox" name="forum" value="1" defaultChecked={filters.forum} />
        <span>Forums only</span>
      </label>
      <div className="hotel-bl-filter-actions">
        <button className="primary" type="submit">
          Apply filters
        </button>
        <Link href="/hht-opp">Clear</Link>
      </div>
    </form>
  )
}

function KeywordIdeas({ keywords }: { keywords: GuestKeywordRow[] }) {
  return (
    <section className="hotel-bl-import-card hht-opp-seed-card" aria-labelledby="hht-opp-ideas-heading">
      <div>
        <h2 id="hht-opp-ideas-heading">Google Ads keyword ideas</h2>
        <p>
          One call to KeywordPlanIdeaService.GenerateKeywordIdeas. New travel phrases are stored here so the next search can look for blogs.
        </p>
      </div>
      <form action={expandHhtOppKeywordIdeasAction}>
        <button className="primary" type="submit">
          Find keyword ideas
        </button>
      </form>
      {keywords.length === 0 ? (
        <p className="muted">No keywords stored yet. Finding ideas seeds the travel guest-post phrases, then asks Google Ads for more.</p>
      ) : (
        <div className="hht-bl-table-wrap">
          <table className="hht-bl-table">
            <thead>
              <tr>
                <th>Keyword</th>
                <th>Source</th>
                <th>Status</th>
                <th className="num">New blogs</th>
              </tr>
            </thead>
            <tbody>
              {keywords.map((row) => (
                <tr key={row.id}>
                  <td>{row.keyword}</td>
                  <td>{row.sourceType.replaceAll('_', ' ')}</td>
                  <td>{row.status.replaceAll('_', ' ')}</td>
                  <td className="num">{num(row.newDomains)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DiscoveryForm() {
  return (
    <section className="hotel-bl-import-card hht-opp-seed-card" aria-labelledby="hht-opp-discover-heading">
      <div>
        <h2 id="hht-opp-discover-heading">Search discovery</h2>
        <p>
          Runs a small query batch, dedupes by root domain, skips OTAs and platforms, then researches only new publishers. Live Semrush batches prefer travel/hotel forums, then guest-post phrases. Forum rows are classified from crawled HTML: dofollow is measured from comment/thread rel attributes, never inferred from “comments welcome.” Does not scrape Google. Nothing is sent.
        </p>
      </div>
      <form action={startHhtOppDiscoveryAction} className="hht-opp-discover-form">
        <label>
          <span>Queries (max {HHT_OPP_DISCOVERY_DEFAULTS.maxQueryLimit})</span>
          <input
            type="number"
            name="queryLimit"
            min={1}
            max={HHT_OPP_DISCOVERY_DEFAULTS.maxQueryLimit}
            defaultValue={HHT_OPP_DISCOVERY_DEFAULTS.queryLimit}
          />
        </label>
        <label>
          <span>New domains (max {HHT_OPP_DISCOVERY_DEFAULTS.maxDomainLimit})</span>
          <input
            type="number"
            name="domainLimit"
            min={1}
            max={HHT_OPP_DISCOVERY_DEFAULTS.maxDomainLimit}
            defaultValue={HHT_OPP_DISCOVERY_DEFAULTS.domainLimit}
          />
        </label>
        <label>
          <span>Strategy</span>
          <select name="strategy" defaultValue="">
            <option value="">Mixed batch</option>
            {HHT_OPP_DISCOVERY_STRATEGY_ORDER.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="hotel-bl-check">
          <input type="checkbox" name="useFixture" value="1" />
          <span>Offline fixture catalog (no spend)</span>
        </label>
        <button className="primary" type="submit">
          Start discovery
        </button>
      </form>
    </section>
  )
}

function Strategies({
  rows,
  runs,
  stale,
}: {
  rows: Array<{ strategy: string; queries: number; domainsFound: number; newDomains: number; qualified: number; pass: number; yieldPct: number }>
  runs: Array<{
    id: number
    name: string
    status: string
    notes: string | null
    startedAt: Date | null
    finishedAt: Date | null
  }>
  stale: number
}) {
  return (
    <>
      <DiscoveryForm />
      <PhaseActions stale={stale} />
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Recent discovery runs</h2>
            <p>Optimize for PASS yield, not raw domain count. Fixture runs are labeled and do not spend.</p>
          </div>
        </div>
        {runs.length === 0 ? (
          <div className="hht-bl-empty">No search runs yet. Start a small discovery batch above.</div>
        ) : (
          <div className="hht-bl-table-wrap">
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th className="num">Queries</th>
                  <th className="num">New domains</th>
                  <th className="num">Created</th>
                  <th className="num">PASS</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const notes = parseDiscoveryRunNotes(run.notes)
                  return (
                    <tr key={run.id}>
                      <td>
                        #{run.id} {run.name}
                        {notes.error ? <div className="hht-bl-subcell">{notes.error.slice(0, 180)}</div> : null}
                      </td>
                      <td>
                        <span className={`badge ${tone(run.status === 'completed' ? 'PASS' : run.status === 'failed' ? 'FAIL' : 'REVIEW')}`}>
                          {run.status}
                        </span>
                      </td>
                      <td>{notes.provider ?? (notes.live ? 'live' : 'fixture')}</td>
                      <td className="num">{num(notes.queries)}</td>
                      <td className="num">{num(notes.newDomains)}</td>
                      <td className="num">{num(notes.created)}</td>
                      <td className="num">{num(notes.pass)}</td>
                      <td>{date(run.startedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Discovery strategy yield</h2>
            <p>PASS / domains found. Search-driven strategies populate after the first discovery run.</p>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="hht-bl-empty">No strategy data yet. Manual seeds and search runs appear here.</div>
        ) : (
          <div className="hht-bl-table-wrap">
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th className="num">Queries</th>
                  <th className="num">Domains found</th>
                  <th className="num">New domains</th>
                  <th className="num">Qualified</th>
                  <th className="num">PASS</th>
                  <th className="num">Yield</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.strategy}>
                    <td>{row.strategy.replaceAll('_', ' ')}</td>
                    <td className="num">{num(row.queries)}</td>
                    <td className="num">{num(row.domainsFound)}</td>
                    <td className="num">{num(row.newDomains)}</td>
                    <td className="num">{num(row.qualified)}</td>
                    <td className="num">{num(row.pass)}</td>
                    <td className="num">{row.yieldPct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

function QueryTemplates() {
  const templates = expandQueryTemplates()
  return (
    <section className="hht-bl-section">
      <div className="hht-bl-section-head">
        <div>
          <h2>Seed query templates</h2>
          <p>
            {templates.length} parameterized queries. A discovery run fires a small mixed batch (default {HHT_OPP_DISCOVERY_DEFAULTS.queryLimit}), not this entire list.
          </p>
        </div>
      </div>
      <div className="hht-bl-table-wrap">
        <table className="hht-bl-table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Family</th>
              <th>Query</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((row) => (
              <tr key={`${row.strategy}:${row.query}`}>
                <td>{row.strategy.replaceAll('_', ' ')}</td>
                <td>{row.family}</td>
                <td className="mono">{row.query}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PhaseActions({ stale }: { stale: number }) {
  return (
    <section className="hotel-bl-import-card hht-opp-seed-card" aria-labelledby="hht-opp-phase-heading">
      <div>
        <h2 id="hht-opp-phase-heading">Later-phase discovery</h2>
        <p>
          Competitor overlap uses Semrush referring domains (clicked = spend). Mentions, authors, and directories use the same search provider as discovery. Broken-link rows are created only when a travel URL is actually dead and HHT is a plausible substitute. Nothing is sent.
        </p>
      </div>
      <div className="hht-opp-phase-actions">
        <form action={mineHhtOppCompetitorsAction}>
          <label>
            <span>Optional referring-domain seeds (skip Semrush)</span>
            <textarea name="seeds" rows={2} placeholder="publisher.example" />
          </label>
          <button type="submit">Mine competitor backlinks</button>
        </form>
        <form action={discoverHhtOppMentionsAction}>
          <button type="submit">Scan unlinked mentions</button>
        </form>
        <form action={scanHhtOppBrokenLinksAction}>
          <button type="submit">Scan broken links</button>
        </form>
        <form action={mineHhtOppDirectoriesAction}>
          <button type="submit">Mine directories</button>
        </form>
        <form action={expandHhtOppGraphAction}>
          <button type="submit">Expand backlink graph</button>
        </form>
        <form action={refreshStaleHhtOppAction}>
          <button type="submit">Refresh stale ({stale})</button>
        </form>
      </div>
    </section>
  )
}
