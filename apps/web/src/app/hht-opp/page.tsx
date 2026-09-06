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
  hhtOppOutcomeStats,
  hhtOppStats,
  listDiscoveryRuns,
  listHhtOppAuthors,
  listHhtOppOpportunities,
  listHhtOppRecommendations,
  listStaleHhtOppOpportunities,
  parseDiscoveryRunNotes,
  queryOr,
  strategyYield,
  type HhtOppDashboardView,
  type HhtOppFilters,
} from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import {
  discoverHhtOppMentionsAction,
  enrichHhtOppQualifiedAction,
  enrichHhtOppSelectedAction,
  expandHhtOppAuthorsAction,
  expandHhtOppGraphAction,
  generateHhtOppDraftAction,
  generateHhtOppRecommendationsAction,
  mineHhtOppCompetitorsAction,
  mineHhtOppDirectoriesAction,
  refreshStaleHhtOppAction,
  researchHhtOppSeedsAction,
  scanHhtOppBrokenLinksAction,
  setHhtOppRecommendationAction,
  startHhtOppDiscoveryAction,
} from './actions'

export const dynamic = 'force-dynamic'

const VIEWS: Array<{ id: HhtOppDashboardView; label: string }> = [
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'queries', label: 'Query templates' },
  { id: 'outcomes', label: 'Outcomes' },
  { id: 'learning', label: 'Learning' },
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
    contacted: contacted === 'yes' || contacted === 'no' ? contacted : undefined,
    sort: ['score', 'authority', 'traffic', 'referring', 'outbound', 'price', 'checked'].includes(sort ?? '')
      ? (sort as HhtOppFilters['sort'])
      : 'score',
    direction: direction === 'asc' || direction === 'desc' ? direction : 'desc',
  }
}

function label(value: string | null | undefined): string {
  if (!value) return NULL_DISPLAY
  return HHT_OPP_TYPE_LABELS[value as HhtOppType] ?? value.replaceAll('_', ' ')
}

function score(value: number | null | undefined): string {
  return value == null ? NULL_DISPLAY : value.toFixed(1)
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

  const [stats, rows, strategies, runs, outcomes, recommendations, authors, stale] = await Promise.all([
    queryOr('hhtOppStats', () => hhtOppStats(db()), {
      domains: 0,
      opportunities: 0,
      pass: 0,
      review: 0,
      fail: 0,
      drafts: 0,
    }),
    queryOr('listHhtOppOpportunities', () => listHhtOppOpportunities(db(), filters), []),
    queryOr('strategyYield', () => strategyYield(db()), []),
    queryOr('listDiscoveryRuns', () => listDiscoveryRuns(db()), []),
    queryOr('hhtOppOutcomeStats', () => hhtOppOutcomeStats(db()), { byType: [], byStrategy: [] }),
    queryOr('listHhtOppRecommendations', () => listHhtOppRecommendations(db()), []),
    queryOr('listHhtOppAuthors', () => listHhtOppAuthors(db()), []),
    queryOr('listStaleHhtOppOpportunities', () => listStaleHhtOppOpportunities(db()), []),
  ])

  const selectedDomainIds = [...new Set(rows.filter((row) => row.eligibility === 'PASS' || row.status === 'REVIEW').map((row) => row.domainId))]

  return (
    <div className="opp-workspace hht-bl-workspace hht-opp-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <h1 className="page-title">Opportunity Engine</h1>
          <p className="page-desc">
            Highest-value feasible ways for HotelHotTubs.com to earn relevant referring domains. Evidence over volume. No outreach is sent automatically.
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
          <Metric label="PASS" value={stats.pass} />
          <Metric label="REVIEW" value={stats.review} />
          <Metric label="FAIL" value={stats.fail} />
          <Metric label="Drafts" value={stats.drafts} />
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
              <p>Semrush Authority Score only — never labeled DA. Enrichment runs on PASS, or on REVIEW when you click Enrich selected.</p>
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
                      <th className="num">Overall</th>
                      <th className="num">Authority</th>
                      <th className="num">Organic traffic</th>
                      <th className="num">Referring domains</th>
                      <th className="num">Avg outbound</th>
                      <th>Link type</th>
                      <th>Price</th>
                      <th>Eligibility</th>
                      <th>Requirements</th>
                      <th>Contact</th>
                      <th>Last checked</th>
                      <th>Draft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <Link href={`/hht-opp/${row.id}`} className="hht-bl-domain">
                            {row.site}
                          </Link>
                          <div className="hht-bl-subcell">{row.displayName}</div>
                        </td>
                        <td>
                          {label(row.opportunityType)}
                          {row.inventedTypeName ? <div className="hht-bl-subcell">{row.inventedTypeName}</div> : null}
                        </td>
                        <td>
                          <span className={`badge ${tone(row.status)}`}>{row.status}</span>
                        </td>
                        <td className={row.overallScore != null && row.overallScore >= 70 ? 'num hht-bl-score-strong' : 'num'}>
                          {score(row.overallScore)}
                        </td>
                        <td className="num">{num(row.authorityScore)}</td>
                        <td className="num">{num(row.organicTraffic)}</td>
                        <td className="num">{num(row.referringDomains)}</td>
                        <td className="num" title="Average external links on sampled pages, not a sitewide total.">
                          {row.avgOutboundLinks == null ? NULL_DISPLAY : row.avgOutboundLinks.toFixed(1)}
                        </td>
                        <td>{row.linkType.replaceAll('_', ' ')}</td>
                        <td>
                          {row.priceLabel}
                          {row.priceStatus === 'QUOTE_REQUIRED' ? <div className="hht-bl-subcell">No public price</div> : null}
                        </td>
                        <td>
                          <span className={`badge ${tone(row.eligibility)}`}>{row.eligibility}</span>
                        </td>
                        <td className="hht-bl-long-cell">
                          {row.requirementsSummary.length === 0
                            ? NULL_DISPLAY
                            : row.requirementsSummary.slice(0, 4).map((line) => (
                                <div key={line}>{line}</div>
                              ))}
                        </td>
                        <td className="hht-bl-cell-wrap">{row.contact ?? NULL_DISPLAY}</td>
                        <td>{date(row.lastCheckedAt)}</td>
                        <td>
                          <form action={generateHhtOppDraftAction}>
                            <input type="hidden" name="opportunityId" value={row.id} />
                            <button className="tiny primary" type="submit">
                              {row.hasDraft ? 'Regenerate' : 'Generate draft'}
                            </button>
                          </form>
                        </td>
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
        {view === 'outcomes' ? <Outcomes stats={outcomes} /> : null}
        {view === 'learning' ? <Learning recommendations={recommendations} authors={authors} /> : null}
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
        <span>Eligibility</span>
        <select name="eligibility" defaultValue={filters.eligibility ?? ''}>
          <option value="">All</option>
          {FILTER_ENUMS.eligibility.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>SEO risk</span>
        <select name="seoRisk" defaultValue={filters.seoRisk ?? ''}>
          <option value="">All</option>
          {FILTER_ENUMS.risks.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
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
        <span>Min score</span>
        <input type="number" name="minScore" min="0" max="100" defaultValue={filters.minScore} />
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
        <select name="sort" defaultValue={filters.sort ?? 'score'}>
          <option value="score">Overall score</option>
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
        <span>Dofollow</span>
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

function DiscoveryForm() {
  return (
    <section className="hotel-bl-import-card hht-opp-seed-card" aria-labelledby="hht-opp-discover-heading">
      <div>
        <h2 id="hht-opp-discover-heading">Search discovery</h2>
        <p>
          Runs a small query batch, dedupes by root domain, skips OTAs and platforms, then researches only new publishers. Does not scrape Google. Live mode uses DataForSEO; otherwise the labeled fixture catalog runs at $0. Nothing is sent.
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
                      <td>{notes.live ? 'DataForSEO' : notes.provider ?? 'fixture'}</td>
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

function Outcomes({
  stats,
}: {
  stats: {
    byType: Array<{ key: string; sent: number; replies: number; acquired: number; avgCost: number | null; replyRate: number; acquireRate: number }>
    byStrategy: Array<{ key: string; sent: number; replies: number; acquired: number; avgCost: number | null; replyRate: number; acquireRate: number }>
  }
}) {
  const tables = [
    { title: 'By opportunity type', rows: stats.byType },
    { title: 'By discovery strategy', rows: stats.byStrategy },
  ]
  return (
    <section className="hht-bl-section">
      <div className="hht-bl-section-head">
        <div>
          <h2>Outreach outcomes</h2>
          <p>Recorded from the detail page. This app never sends mail. Null cost stays blank, never $0.</p>
        </div>
      </div>
      {tables.map((table) => (
        <div key={table.title} className="hht-bl-table-wrap">
          <h3>{table.title}</h3>
          {table.rows.length === 0 ? (
            <div className="hht-bl-empty">No outreach events yet.</div>
          ) : (
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Slice</th>
                  <th className="num">Sent</th>
                  <th className="num">Replies</th>
                  <th className="num">Reply rate</th>
                  <th className="num">Links</th>
                  <th className="num">Acquire rate</th>
                  <th className="num">Avg cost</th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.key.replaceAll('_', ' ')}</td>
                    <td className="num">{num(row.sent)}</td>
                    <td className="num">{num(row.replies)}</td>
                    <td className="num">{(row.replyRate * 100).toFixed(1)}%</td>
                    <td className="num">{num(row.acquired)}</td>
                    <td className="num">{(row.acquireRate * 100).toFixed(1)}%</td>
                    <td className="num">{row.avgCost == null ? NULL_DISPLAY : `$${row.avgCost.toFixed(0)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </section>
  )
}

function Learning({
  recommendations,
  authors,
}: {
  recommendations: Array<{ id: number; summary: string; rationale: string; status: string; evidence: Record<string, number | string> }>
  authors: Array<{ id: number; name: string; sourceUrl: string; publications: Array<{ domain: string; url: string | null }> }>
}) {
  return (
    <>
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Strategy recommendations</h2>
            <p>Human approval only. The engine never removes a strategy on its own.</p>
          </div>
          <form action={generateHhtOppRecommendationsAction}>
            <button className="primary" type="submit">
              Analyze yield
            </button>
          </form>
        </div>
        {recommendations.length === 0 ? (
          <div className="hht-bl-empty">No recommendations yet. Analyze yield after a few discovery runs or outreach events.</div>
        ) : (
          <div className="hht-bl-table-wrap">
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Recommendation</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recommendations.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.summary}</strong>
                      <div className="hht-bl-subcell">{row.rationale}</div>
                    </td>
                    <td>
                      <span className={`badge ${tone(row.status === 'approved' ? 'PASS' : row.status === 'dismissed' ? 'FAIL' : 'REVIEW')}`}>
                        {row.status}
                      </span>
                    </td>
                    <td>
                      <form action={setHhtOppRecommendationAction} className="hht-opp-rec-actions">
                        <input type="hidden" name="id" value={row.id} />
                        <button type="submit" name="status" value="approved">
                          Approve
                        </button>
                        <button type="submit" name="status" value="dismissed">
                          Dismiss
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Author graph</h2>
            <p>Writers extracted from crawled pages. Expansion searches for other publications they appear on.</p>
          </div>
          <form action={expandHhtOppAuthorsAction}>
            <button type="submit">Expand authors</button>
          </form>
        </div>
        {authors.length === 0 ? (
          <div className="hht-bl-empty">No authors extracted yet. Research a few publisher pages first.</div>
        ) : (
          <ul>
            {authors.map((author) => (
              <li key={author.id}>
                {author.name} · {author.publications.map((pub) => pub.domain).join(', ') || 'no other publications yet'}
                <div className="muted">{author.sourceUrl}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
