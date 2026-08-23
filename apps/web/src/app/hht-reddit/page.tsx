import Link from 'next/link'
import { db, getHhtRedditDashboard } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'

export const dynamic = 'force-dynamic'

function dateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function usd(value: bigint | null): string {
  if (value === null) return NULL_DISPLAY
  return `$${(Number(value) / 1_000_000).toFixed(2)}`
}

function sourceLabel(sources: string[]): string {
  if (sources.includes('grid') && sources.includes('google_ads_idea')) return 'Grid + idea'
  if (sources.includes('google_ads_idea')) return 'Keyword idea'
  return 'Grid'
}

function SummaryMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="hht-bl-summary-item">
      <span>{label}</span>
      <strong>{typeof value === 'number' ? num(value) : value}</strong>
    </div>
  )
}

export default async function HhtRedditPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string; page?: string }>
}) {
  const { city, page } = await searchParams
  const requestedPage = page ? Number(page) : undefined
  const result = await getHhtRedditDashboard(
    db(),
    'hotelhottubs.com',
    city,
    requestedPage,
  ).then(
    (dashboard) => ({ dashboard, error: null }),
    (error: unknown) => ({
      dashboard: null,
      error: error instanceof Error ? error.message : 'The Reddit keyword workspace could not load.',
    }),
  )

  if (!result.dashboard) {
    return (
      <div className="opp-workspace hht-bl-workspace">
        <header className="run-page-head hht-bl-head">
          <h1 className="page-title">HHT Reddit research</h1>
          <p className="page-desc">HotelHotTubs location-keyword demand</p>
        </header>
        <HhtSectionTabs active="reddit" />
        <main className="hht-bl-view">
          <div className="stopbox" role="alert">
            <strong>Keyword snapshot unavailable.</strong> {result.error}
          </div>
        </main>
      </div>
    )
  }

  const { cities, keywordPagination, keywords, keywordScope, run, selectedCity, site } =
    result.dashboard
  if (!run) {
    return (
      <div className="opp-workspace hht-bl-workspace">
        <header className="run-page-head hht-bl-head">
          <h1 className="page-title">HHT Reddit research</h1>
          <p className="page-desc">{site.domain}</p>
        </header>
        <HhtSectionTabs active="reddit" />
        <main className="hht-bl-view">
          <div className="hht-bl-empty">No Google Ads keyword snapshot has been persisted yet.</div>
        </main>
      </div>
    )
  }

  const showingAllCities = keywordScope === 'all'
  const globalConservativeVolume = cities.reduce(
    (sum, row) => sum + row.conservativeAggregateVolume,
    0,
  )
  const globalRawVolume = cities.reduce((sum, row) => sum + row.rawAggregateVolume, 0)
  const measuredKeywordCount = showingAllCities
    ? run.measuredKeywordCount
    : (selectedCity?.measuredKeywordCount ?? 0)
  const unmeasuredKeywordCount = showingAllCities
    ? run.eligibleKeywordCount - run.measuredKeywordCount
    : (selectedCity?.unmeasuredKeywordCount ?? 0)
  const conservativeVolume = showingAllCities
    ? globalConservativeVolume
    : (selectedCity?.conservativeAggregateVolume ?? 0)
  const rawVolume = showingAllCities
    ? globalRawVolume
    : (selectedCity?.rawAggregateVolume ?? 0)
  const firstVisibleKeyword =
    keywordPagination.totalRows === 0 ? 0 : keywordPagination.offset + 1
  const lastVisibleKeyword = Math.min(
    keywordPagination.offset + keywords.length,
    keywordPagination.totalRows,
  )

  return (
    <div className="opp-workspace hht-bl-workspace hht-reddit-workspace">
      <header className="run-page-head hht-bl-head">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">HHT Reddit research</h1>
            <p className="page-desc">
              {site.domain} · US keyword demand · Updated {dateTime(run.generatedAt)}
            </p>
          </div>
          <div className="hht-bl-run-state">
            <span className="badge go">Google Ads</span>
            <span className="hht-bl-current-stage">Free only · no SERPs</span>
          </div>
        </div>
      </header>

      <HhtSectionTabs active="reddit" />

      <main className="hht-reddit-view">
        <section className="hht-bl-summary" aria-label="Keyword analysis summary">
          <SummaryMetric label="Cities" value={run.destinationCount} />
          <SummaryMetric label="Measured cities" value={run.measuredCityCount} />
          <SummaryMetric label="Raw keywords" value={run.eligibleKeywordCount} />
          <SummaryMetric label="Measured keywords" value={run.measuredKeywordCount} />
          <SummaryMetric label="Positive clusters" value={run.positiveClusterCount} />
          <SummaryMetric label="Provider cost" value="$0" />
        </section>

        <div className="hht-reddit-method" role="note">
          <strong>Use conservative volume to rank cities.</strong> It takes the highest-volume
          phrase in each normalized intent cluster. Raw volume is the direct keyword sum and can
          double-count close variants. Null keyword volume remains unmeasured, never zero.
        </div>

        <form className="hht-reddit-city-picker" method="get" aria-label="Select keyword scope">
          <label htmlFor="hht-reddit-city">Keyword scope</label>
          <select
            id="hht-reddit-city"
            name="city"
            defaultValue={showingAllCities ? 'all' : selectedCity?.citySlug}
          >
            <option value="all">
              All cities — volume descending ({num(run.measuredKeywordCount)} measured)
            </option>
            {cities.map((row) => (
              <option key={row.citySlug} value={row.citySlug}>
                {row.city} — {num(row.conservativeAggregateVolume)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-secondary">
            Show keywords
          </button>
        </form>

        <div className="hht-reddit-grid">
          <section className="hht-reddit-panel" aria-labelledby="hht-reddit-cities-heading">
            <div className="hht-reddit-panel-head">
              <div>
                <h2 id="hht-reddit-cities-heading">City demand</h2>
                <p>Cluster-deduped and raw monthly search sums</p>
              </div>
              <span>{num(cities.length)} cities</span>
            </div>
            <div className="hht-reddit-table-wrap">
              <table className="hht-reddit-table hht-reddit-city-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>City</th>
                    <th className="num">Conservative</th>
                    <th className="num">Raw</th>
                    <th className="num">Measured</th>
                  </tr>
                </thead>
                <tbody>
                  {cities.map((row) => {
                    const active = row.citySlug === selectedCity?.citySlug
                    return (
                      <tr key={row.citySlug} className={active ? 'is-selected' : undefined}>
                        <td className="num">{num(row.cityRank)}</td>
                        <td>
                          <Link
                            href={`/hht-reddit?city=${encodeURIComponent(row.citySlug)}#keywords`}
                            aria-current={active ? 'location' : undefined}
                          >
                            {row.city}
                          </Link>
                          <span className="hht-reddit-top-keyword" title={row.topKeyword ?? undefined}>
                            {row.topKeyword ?? 'No measured keyword'}
                          </span>
                        </td>
                        <td className="num hht-reddit-primary-volume">
                          {num(row.conservativeAggregateVolume)}
                        </td>
                        <td className="num">{num(row.rawAggregateVolume)}</td>
                        <td className="num">
                          {num(row.measuredKeywordCount)} / {num(row.keywordCount)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section
            id="keywords"
            className="hht-reddit-panel"
            aria-labelledby="hht-reddit-keywords-heading"
          >
            <div className="hht-reddit-panel-head">
              <div>
                <h2 id="hht-reddit-keywords-heading">
                  {showingAllCities ? 'All-city keywords' : `${selectedCity?.city} keywords`}
                </h2>
                <p>
                  {showingAllCities
                    ? `Showing ${num(firstVisibleKeyword)}–${num(lastVisibleKeyword)} of ${num(
                        keywordPagination.totalRows,
                      )} · volume descending`
                    : `${num(measuredKeywordCount)} measured · ${num(
                        unmeasuredKeywordCount,
                      )} unmeasured`}
                </p>
              </div>
              <div className="hht-reddit-selected-sums">
                <span>
                  Conservative <strong>{num(conservativeVolume)}</strong>
                </span>
                <span>
                  Raw <strong>{num(rawVolume)}</strong>
                </span>
              </div>
            </div>
            <div className="hht-reddit-table-wrap">
              <table className="hht-reddit-table hht-reddit-keyword-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Keyword</th>
                    {showingAllCities ? <th>City</th> : null}
                    <th className="num" aria-sort="descending">
                      Volume ↓
                    </th>
                    <th>Intent</th>
                    <th>Cluster</th>
                    <th className="num">Competition</th>
                    <th className="num">Bid low</th>
                    <th className="num">Bid high</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.map((row) => (
                    <tr key={row.id}>
                      <td className="num">
                        {num(showingAllCities ? row.globalRank : row.cityRank)}
                      </td>
                      <td className="hht-reddit-keyword">{row.keyword}</td>
                      {showingAllCities ? (
                        <td className="hht-reddit-keyword-city">
                          <Link href={`/hht-reddit?city=${encodeURIComponent(row.citySlug)}#keywords`}>
                            {row.city}
                          </Link>
                        </td>
                      ) : null}
                      <td className="num hht-reddit-primary-volume">
                        {num(row.avgMonthlySearches)}
                      </td>
                      <td>{row.intentTier}</td>
                      <td className="hht-reddit-cluster">{row.intentCluster}</td>
                      <td className="num">{num(row.competitionIndex)}</td>
                      <td className="num">{usd(row.lowTopOfPageBidMicros)}</td>
                      <td className="num">{usd(row.highTopOfPageBidMicros)}</td>
                      <td>{sourceLabel(row.sources)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showingAllCities && keywordPagination.totalPages > 1 ? (
              <nav className="hht-reddit-pagination" aria-label="Global keyword pages">
                {keywordPagination.page > 1 ? (
                  <Link
                    href={`/hht-reddit?city=all&page=${keywordPagination.page - 1}#keywords`}
                    rel="prev"
                  >
                    ← Previous
                  </Link>
                ) : (
                  <span aria-disabled="true">← Previous</span>
                )}
                <strong>
                  Page {num(keywordPagination.page)} of {num(keywordPagination.totalPages)}
                </strong>
                {keywordPagination.page < keywordPagination.totalPages ? (
                  <Link
                    href={`/hht-reddit?city=all&page=${keywordPagination.page + 1}#keywords`}
                    rel="next"
                  >
                    Next →
                  </Link>
                ) : (
                  <span aria-disabled="true">Next →</span>
                )}
              </nav>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  )
}
