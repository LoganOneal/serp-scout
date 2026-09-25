import Link from 'next/link'
import {
  HHT_PX_CLUSTER_LABELS,
  HHT_PX_PAGE_TYPE_LABELS,
  HHT_PX_STAGES,
  hhtPxArticleLabel,
  hhtPxBadgeGroup,
  type HhtPxCluster,
} from '@rnr/core'
import { db, getHhtPxDashboard, type HhtPxDashboardView } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import {
  aggregateHhtPxAction,
  enrichHhtPxAction,
  expandHhtPxIdeasAction,
  fetchHhtPxSerpsAction,
  fetchHhtPxVolumesAction,
  pauseHhtPxAction,
  prioritizeHhtPxAction,
  seedHhtPxLibraryAction,
} from './actions'

export const dynamic = 'force-dynamic'

const VIEWS: Array<{ id: HhtPxDashboardView; label: string }> = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'pages', label: 'Articles' },
  { id: 'domains', label: 'Domains' },
]

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function pct(value: number | null | undefined): string {
  if (value == null) return NULL_DISPLAY
  return `${Math.round(value * 100)}%`
}

function score(value: number | null | undefined): string {
  return value == null ? NULL_DISPLAY : value.toFixed(1)
}

function flatten(params: SearchParams): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, one(value)]))
}

function sortHref(view: string, params: Record<string, string | undefined>, column: string, defaultSort = 'score'): string {
  const next = new URLSearchParams()
  next.set('view', view)
  for (const [key, value] of Object.entries(params)) {
    if (!value || key === 'message' || key === 'tone' || key === 'view') continue
    next.set(key, value)
  }
  const current = params['sort'] ?? defaultSort
  const dir = params['direction'] === 'asc' ? 'asc' : 'desc'
  next.set('sort', column)
  next.set('direction', current === column && dir === 'desc' ? 'asc' : 'desc')
  return `/hht-px?${next}`
}

function SortHead({
  view,
  params,
  column,
  children,
  numeric = false,
  defaultSort = 'score',
}: {
  view: string
  params: Record<string, string | undefined>
  column: string
  children: string
  numeric?: boolean
  defaultSort?: string
}) {
  const current = params['sort'] ?? defaultSort
  const marker = current === column ? (params['direction'] === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th className={numeric ? 'num' : undefined}>
      <Link href={sortHref(view, params, column, defaultSort)}>{children}{marker}</Link>
    </th>
  )
}

export default async function HhtPxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams
  const params = flatten(raw)
  const view = (VIEWS.some((item) => item.id === params['view']) ? params['view'] : 'pipeline') as HhtPxDashboardView
  const result = await getHhtPxDashboard(db(), view, params).then(
    (dashboard) => ({ dashboard, error: null }),
    (error: unknown) => ({
      dashboard: null,
      error: error instanceof Error ? error.message : 'The SERP prospecting workspace could not load.',
    }),
  )

  if (!result.dashboard) {
    return (
      <div className="opp-workspace hht-bl-workspace">
        <header className="run-page-head hht-bl-head">
          <h1 className="page-title">HHT SERP prospects</h1>
          <p className="page-desc">Find ranking editorial pages that could logically link to Hotel Hot Tubs</p>
        </header>
        <HhtSectionTabs active="serp-prospects" />
        <div className="stopbox" role="alert">
          <strong>Workspace unavailable.</strong> {result.error}
        </div>
      </div>
    )
  }

  const dashboard = result.dashboard
  const message = params['message']
  const tone = params['tone'] === 'error' ? 'stop' : 'go'

  return (
    <div className="opp-workspace hht-bl-workspace">
      <header className="run-page-head hht-bl-head">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">HHT SERP prospects</h1>
            <p className="page-desc">
              Backlink prospecting from ranking travel articles — not keyword research for HHT rankings.
            </p>
          </div>
          {dashboard.run ? (
            <div className="hht-bl-run-state">
              <span className="badge warn">{dashboard.run.status}</span>
              <span className="hht-bl-current-stage">{dashboard.run.currentStage.replaceAll('_', ' ')}</span>
            </div>
          ) : null}
        </div>
      </header>
      <HhtSectionTabs active="serp-prospects" />
      <nav className="hht-bl-tabs" aria-label="SERP prospecting views">
        {VIEWS.map((item) => (
          <Link
            key={item.id}
            href={item.id === 'pipeline' ? '/hht-px' : `/hht-px?view=${item.id}`}
            className={`hht-bl-tab${view === item.id ? ' active' : ''}`}
            aria-current={view === item.id ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {message ? (
        <div className={`${tone === 'stop' ? 'stopbox' : 'hht-bl-credential-alert'}`} role="status">
          {message}
        </div>
      ) : null}
      <main className="hht-bl-view">
        {view === 'pipeline' ? <Pipeline dashboard={dashboard} /> : null}
        {view === 'keywords' ? <Keywords dashboard={dashboard} params={params} /> : null}
        {view === 'pages' ? <Pages dashboard={dashboard} params={params} /> : null}
        {view === 'domains' ? <Domains dashboard={dashboard} /> : null}
      </main>
    </div>
  )
}

function Pipeline({ dashboard }: { dashboard: Awaited<ReturnType<typeof getHhtPxDashboard>> }) {
  const preview = dashboard.serpPreview
  return (
    <>
      <section className="hht-bl-summary">
        <Summary label="Geographies" value={dashboard.counts.geographies} />
        <Summary label="Keywords" value={dashboard.counts.keywords} />
        <Summary label="Volumes stored" value={dashboard.counts.volumes} />
        <Summary label="SERPs cached" value={dashboard.counts.serps} />
        <Summary label="Prospect pages" value={dashboard.counts.pages} />
        <Summary label="Domains" value={dashboard.counts.domains} />
      </section>
      <ArticleHits
        rows={dashboard.pages}
        empty="No editorial articles yet. Pull Semrush SERPs, then run page dedupe."
        heading="Keyword → article hits"
        description="US destination volume for the keyword, the ranking article, and its organic position. Open Articles for the full list."
        moreHref="/hht-px?view=pages"
      />
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Resumable stages</h2>
            <p>Each stage persists independently. A failed API call does not rewind the pipeline.</p>
          </div>
        </div>
        <ol className="hht-px-stages">
          {HHT_PX_STAGES.map((stage) => (
            <li key={stage} className={dashboard.run?.currentStage === stage ? 'active' : undefined}>
              {stage.replaceAll('_', ' ')}
            </li>
          ))}
        </ol>
        <div className="hht-opp-toolbar hht-px-actions">
          <form action={seedHhtPxLibraryAction}>
            <button className="primary" type="submit">Seed geos + keywords</button>
          </form>
          <form action={fetchHhtPxVolumesAction}>
            <input type="number" name="limit" defaultValue={200} min={1} max={1000} aria-label="Volume batch size" />
            <label>
              <input type="checkbox" name="retryFailed" value="1" /> Retry failed
            </label>
            <button type="submit">Fetch US destination volume</button>
          </form>
          <form action={prioritizeHhtPxAction}>
            <button type="submit">Pick variant representatives</button>
          </form>
          <form action={pauseHhtPxAction}>
            <button type="submit">Pause</button>
          </form>
        </div>
        {preview ? (
          <div className="hht-bl-credential-alert" role="status">
            <strong>Semrush MCP SERP preview</strong>
            <span>
              {num(preview.selected)} selected · {num(preview.cached)} cached · {num(preview.newCalls)} new phrase_organic reports.
              The HTTP API key is not used. Confirm queues keywords for MCP ingest.
            </span>
          </div>
        ) : null}
        <div className="hht-opp-toolbar hht-px-actions">
          <form action={fetchHhtPxSerpsAction}>
            <input type="number" name="limit" defaultValue={10} min={1} max={100} aria-label="SERP batch size" />
            <label>
              <input type="checkbox" name="confirm" value="1" /> Queue Semrush MCP SERPs
            </label>
            <label>
              <input type="checkbox" name="retryFailed" value="1" /> Retry failed
            </label>
            <label>
              <input type="checkbox" name="refresh" value="1" /> Refresh stale cache
            </label>
            <button type="submit">Queue Semrush MCP SERPs</button>
          </form>
          <form action={aggregateHhtPxAction}>
            <button type="submit">Dedupe pages + score</button>
          </form>
          <form action={enrichHhtPxAction}>
            <input type="number" name="limit" defaultValue={15} min={1} max={100} aria-label="Enrichment batch size" />
            <button type="submit">Queue MCP domain enrichment</button>
          </form>
          <form action={expandHhtPxIdeasAction}>
            <button type="submit">Google keyword ideas</button>
          </form>
        </div>
        <p className="muted">
          Primary volume is always United States searcher geography for destination keywords. Local-searcher volume is stored separately and never substituted.
        </p>
      </section>
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Cluster yield</h2>
            <p>Expected backlink targets per Semrush call. Spend future credits on clusters that produce editorial SERPs.</p>
          </div>
        </div>
        {dashboard.yields.length === 0 ? (
          <div className="hht-bl-empty">No SERPs scored yet.</div>
        ) : (
          <div className="hht-bl-table-wrap">
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th className="num">SERPs</th>
                  <th className="num">Prospectable / SERP</th>
                  <th className="num">Quality-adjusted / SERP</th>
                  <th className="num">Editorial density</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.yields.map((row) => (
                  <tr key={row.cluster}>
                    <td>{HHT_PX_CLUSTER_LABELS[row.cluster as HhtPxCluster] ?? row.cluster}</td>
                    <td className="num">{num(row.serpCount)}</td>
                    <td className="num">{row.avgProspectsPerSerp == null ? NULL_DISPLAY : row.avgProspectsPerSerp.toFixed(2)}</td>
                    <td className="num">{row.qualityAdjustedPerSerp == null ? NULL_DISPLAY : row.qualityAdjustedPerSerp.toFixed(2)}</td>
                    <td className="num">{pct(row.avgEditorialDensity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted">
        Exports:{' '}
        <a href="/hht-px/export?kind=keywords">Keywords CSV</a>
        {' · '}
        <a href="/hht-px/export?kind=pages">Pages CSV</a>
        {' · '}
        <a href="/hht-px/export?kind=domains">Domains CSV</a>
        {' · '}
        <a href="/hht-px/export?kind=outreach">Outreach CSV</a>
      </p>
    </>
  )
}

function Keywords({
  dashboard,
  params,
}: {
  dashboard: Awaited<ReturnType<typeof getHhtPxDashboard>>
  params: Record<string, string | undefined>
}) {
  return (
    <section className="hht-bl-section">
      <form className="hht-px-filters" method="get">
        <input type="hidden" name="view" value="keywords" />
        {params['sort'] ? <input type="hidden" name="sort" value={params['sort']} /> : null}
        {params['direction'] ? <input type="hidden" name="direction" value={params['direction']} /> : null}
        <label>State <input name="state" defaultValue={params['state'] ?? ''} placeholder="TX" /></label>
        <label>City <input name="city" defaultValue={params['city'] ?? ''} /></label>
        <label>
          Geo type
          <select name="geoType" defaultValue={params['geoType'] ?? ''}>
            <option value="">Any</option>
            <option value="state">State</option>
            <option value="city">City</option>
            <option value="metro">Metro</option>
            <option value="destination_region">Region</option>
          </select>
        </label>
        <label>
          Cluster
          <select name="cluster" defaultValue={params['cluster'] ?? ''}>
            <option value="">Any</option>
            {Object.entries(HHT_PX_CLUSTER_LABELS).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <label>Min volume <input name="minVolume" type="number" defaultValue={params['minVolume'] ?? ''} /></label>
        <label>Max volume <input name="maxVolume" type="number" defaultValue={params['maxVolume'] ?? ''} /></label>
        <label>Min inventory <input name="minInventory" type="number" defaultValue={params['minInventory'] ?? ''} /></label>
        <label>Min editorial % <input name="minEditorialDensity" type="number" defaultValue={params['minEditorialDensity'] ?? ''} /></label>
        <label>Min prospectable <input name="minProspectable" type="number" defaultValue={params['minProspectable'] ?? ''} /></label>
        <label>Min score <input name="minScore" type="number" defaultValue={params['minScore'] ?? ''} /></label>
        <label>
          SERP
          <select name="serp" defaultValue={params['serp'] ?? ''}>
            <option value="">Any</option>
            <option value="checked">Checked</option>
            <option value="unchecked">Unchecked</option>
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      {dashboard.keywords.length === 0 ? (
        <div className="hht-bl-empty">No keywords match. Seed the library and pull US destination volume first.</div>
      ) : (
        <div className="hht-bl-table-wrap">
          <table className="hht-bl-table">
            <thead>
              <tr>
                <SortHead view="keywords" params={params} column="keyword">Keyword</SortHead>
                <SortHead view="keywords" params={params} column="geo">Geo</SortHead>
                <SortHead view="keywords" params={params} column="state">State</SortHead>
                <SortHead view="keywords" params={params} column="cluster">Cluster</SortHead>
                <SortHead view="keywords" params={params} column="variant">Variant group</SortHead>
                <SortHead view="keywords" params={params} column="volume" numeric>Avg volume</SortHead>
                <th className="num">Recent</th>
                <th className="num">Trend</th>
                <SortHead view="keywords" params={params} column="competition">Competition</SortHead>
                <th className="num">HHT inventory</th>
                <SortHead view="keywords" params={params} column="editorial" numeric>Editorial</SortHead>
                <SortHead view="keywords" params={params} column="prospectable" numeric>Prospectable</SortHead>
                <SortHead view="keywords" params={params} column="competitors" numeric>Competitors</SortHead>
                <SortHead view="keywords" params={params} column="domains" numeric>Prospect domains</SortHead>
                <SortHead view="keywords" params={params} column="score" numeric>Score</SortHead>
                <SortHead view="keywords" params={params} column="serp">SERP</SortHead>
              </tr>
            </thead>
            <tbody>
              {dashboard.keywords.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/hht-px/keywords/${row.id}`}>{row.keyword}</Link>
                    {row.representative ? <div className="hht-bl-subcell">Representative</div> : null}
                  </td>
                  <td>{row.geoName ?? 'National'}</td>
                  <td>{row.stateCode ?? NULL_DISPLAY}</td>
                  <td>{HHT_PX_CLUSTER_LABELS[row.cluster] ?? row.cluster}</td>
                  <td>{row.variantGroup}</td>
                  <td className="num">{num(row.volume)}</td>
                  <td className="num">{num(row.recentVolume)}</td>
                  <td className="num">{row.trend == null ? NULL_DISPLAY : `${Math.round(row.trend * 100)}%`}</td>
                  <td>{row.competition ?? NULL_DISPLAY}</td>
                  <td className="num">{num(row.inventory)}</td>
                  <td className="num">{pct(row.editorialDensity)}</td>
                  <td className="num">{pct(row.prospectableDensity)}</td>
                  <td className="num">{num(row.competitorCount)}</td>
                  <td className="num">{num(row.uniqueProspectDomains)}</td>
                  <td className="num">{score(row.score)}</td>
                  <td><span className="badge">{row.serpStatus}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Pages({
  dashboard,
  params,
}: {
  dashboard: Awaited<ReturnType<typeof getHhtPxDashboard>>
  params: Record<string, string | undefined>
}) {
  return (
    <section className="hht-bl-section">
      <form className="hht-px-filters" method="get">
        <input type="hidden" name="view" value="pages" />
        {params['sort'] ? <input type="hidden" name="sort" value={params['sort']} /> : null}
        {params['direction'] ? <input type="hidden" name="direction" value={params['direction']} /> : null}
        <label>Min score <input name="minScore" type="number" defaultValue={params['minScore'] ?? ''} /></label>
        <label>
          Pages
          <select name="prospectable" defaultValue={params['prospectable'] ?? ''}>
            <option value="">Prospectable only</option>
            <option value="0">All classified pages</option>
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      <ArticleHits
        rows={dashboard.pages}
        empty="No prospect articles yet. Pull SERPs, then run page dedupe."
        sortable
        params={params}
      />
    </section>
  )
}

function ArticleHits({
  rows,
  empty,
  heading,
  description,
  moreHref,
  sortable = false,
  params = {},
}: {
  rows: Awaited<ReturnType<typeof getHhtPxDashboard>>['pages']
  empty: string
  heading?: string
  description?: string
  moreHref?: string
  sortable?: boolean
  params?: Record<string, string | undefined>
}) {
  return (
    <section className="hht-bl-section">
      <div className="hht-bl-section-head">
        <div>
          <h2>{heading ?? 'Articles'}</h2>
          <p>{description ?? 'One row per keyword and the editorial URL that ranks for it. Volume is US destination demand for that keyword, not a synonym sum.'}</p>
        </div>
        {moreHref ? <Link href={moreHref}>View all</Link> : null}
      </div>
      {rows.length === 0 ? (
        <div className="hht-bl-empty">{empty}</div>
      ) : (
        <div className="hht-bl-table-wrap">
          <table className="hht-bl-table">
            <thead>
              <tr>
                {sortable ? (
                  <SortHead view="pages" params={params} column="keyword">Keyword</SortHead>
                ) : (
                  <th>Keyword</th>
                )}
                {sortable ? (
                  <SortHead view="pages" params={params} column="volume" numeric>Volume</SortHead>
                ) : (
                  <th className="num">Volume</th>
                )}
                {sortable ? (
                  <SortHead view="pages" params={params} column="position" numeric>Pos</SortHead>
                ) : (
                  <th className="num">Pos</th>
                )}
                <th>Article</th>
                {sortable ? (
                  <SortHead view="pages" params={params} column="domain">Domain</SortHead>
                ) : (
                  <th>Domain</th>
                )}
                {sortable ? (
                  <SortHead view="pages" params={params} column="authority" numeric>Authority</SortHead>
                ) : (
                  <th className="num">Authority</th>
                )}
                {sortable ? (
                  <SortHead view="pages" params={params} column="score" numeric>Prospect score</SortHead>
                ) : (
                  <th className="num">Prospect score</th>
                )}
                <th>Geo</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.id}:${row.keywordId}`}>
                  <td>
                    <Link href={`/hht-px/keywords/${row.keywordId}`}>{row.keyword}</Link>
                    {row.returnedKeyword && row.returnedKeyword !== row.keyword ? (
                      <div className="hht-bl-subcell">Google Ads returned “{row.returnedKeyword}”</div>
                    ) : null}
                  </td>
                  <td className="num">{num(row.volume)}</td>
                  <td className="num">{num(row.position)}</td>
                  <td className="hht-px-article">
                    <a href={row.url} target="_blank" rel="noreferrer" className="hht-bl-url">
                      {hhtPxArticleLabel(row.title, row.url)}
                    </a>
                    <div className="hht-bl-subcell">
                      <Link href={`/hht-px/pages/${row.id}`}>Prospect</Link>
                      {' · '}
                      <span className="hht-px-article-url">{row.url.replace(/^https?:\/\//, '')}</span>
                    </div>
                  </td>
                  <td>
                    <a href={`https://${row.domain}`} target="_blank" rel="noreferrer" className="hht-bl-domain">{row.domain}</a>
                  </td>
                  <td className="num">{num(row.authorityScore)}</td>
                  <td className="num">{score(row.score)}</td>
                  <td>{row.geographies ?? 'National'}</td>
                  <td>
                    <span className={`badge hht-px-badge-${hhtPxBadgeGroup(row.pageType)}`}>
                      {HHT_PX_PAGE_TYPE_LABELS[row.pageType]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Domains({ dashboard }: { dashboard: Awaited<ReturnType<typeof getHhtPxDashboard>> }) {
  return (
    <section className="hht-bl-section">
      {dashboard.domains.length === 0 ? (
        <div className="hht-bl-empty">No prospect domains yet. Which 100 sites are worth a relationship comes after page dedupe.</div>
      ) : (
        <div className="hht-bl-table-wrap">
          <table className="hht-bl-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th className="num">Score</th>
                <th className="num">Authority</th>
                <th className="num">Organic traffic</th>
                <th className="num">Pages</th>
                <th className="num">Geos</th>
                <th className="num">Clusters</th>
                <th>Strongest page</th>
                <th>Competitor</th>
                <th>Outreach</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.domains.map((row) => (
                <tr key={row.id}>
                  <td><a href={`https://${row.rootDomain}`} target="_blank" rel="noreferrer" className="hht-bl-domain">{row.rootDomain}</a></td>
                  <td>{row.domainType ? HHT_PX_PAGE_TYPE_LABELS[row.domainType] : NULL_DISPLAY}</td>
                  <td className="num">{score(row.opportunityScore)}</td>
                  <td className="num">{num(row.authorityScore)}</td>
                  <td className="num">{num(row.organicTraffic)}</td>
                  <td className="num">{num(row.pageCount)}</td>
                  <td className="num">{num(row.geographyCount)}</td>
                  <td className="num">{num(row.clusterCount)}</td>
                  <td>{row.strongest ? <Link href={`/hht-px/pages/${row.strongest.id}`}>{hhtPxArticleLabel(row.strongest.title, row.strongest.url)}</Link> : NULL_DISPLAY}</td>
                  <td>{row.competitorStrength}</td>
                  <td>{row.outreachStatus.replaceAll('_', ' ')}</td>
                  <td>{row.notes ?? NULL_DISPLAY}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="hht-bl-summary-item">
      <span>{label}</span>
      <strong>{num(value)}</strong>
    </div>
  )
}
