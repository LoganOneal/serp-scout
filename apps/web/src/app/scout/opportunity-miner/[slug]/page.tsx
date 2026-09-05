import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, getMarketDetail, queryOr } from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import { NULL_DISPLAY, num } from '@/lib/format'
import { ReviewForm } from '@/components/opportunity-miner/ReviewForm'

export const dynamic = 'force-dynamic'

export default async function MarketDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const detail = await queryOr('getMarketDetail', () => getMarketDetail(db(), slug), null)
  if (!detail) notFound()
  const { market, scores, economics, keywords, domains, ads, anomalies, prices } = detail
  const score = market.scoreOverride ?? scores?.totalScore ?? null

  return (
    <div className="opp-workspace om-workspace">
      <div className="run-page-head">
        <PageHeader
          title={market.name}
          description={market.canonicalProblem ?? 'Clustered search market'}
          breadcrumb={
            <Link href="/scout/opportunity-miner" className="page-breadcrumb">
              Opportunity Miner
            </Link>
          }
        />
        <div className="om-hero">
          <Stat label="Score" value={score == null ? NULL_DISPLAY : `${score.toFixed(1)} / 100`} />
          <Stat label="US search demand" value={market.adjustedVolume == null ? NULL_DISPLAY : num(market.adjustedVolume)} />
          <Stat label="12m growth" value={pct(market.growth12m)} />
          <Stat label="Weighted CPC" value={money(market.weightedCpc)} />
          <Stat
            label="Median competitor price"
            value={money(economics?.observedMedianPrice ?? economics?.estimatedMonthlyPriceBase ?? null)}
            hint={economics?.priceConfidence === 'observed' ? 'OBSERVED' : 'WEAKLY INFERRED'}
          />
          <Stat label="Persistent advertisers" value={String(market.persistentAdvertisers)} />
          <Stat label="Base sustainable CPC" value={money(economics?.sustainableCpcBase ?? null)} />
          <Stat label="CPC coverage" value={economics?.cpcCoverageBase ? `${economics.cpcCoverageBase.toFixed(2)}x` : NULL_DISPLAY} />
          <Stat label="SERP weakness" value={market.serpWeakness == null ? NULL_DISPLAY : `${market.serpWeakness.toFixed(1)} / 5`} />
          <Stat label="Recurring / WTP / Build" value={`${market.recurringUsage ?? '—'} / ${market.willingnessToPay ?? '—'} / ${market.buildComplexity ?? '—'}`} />
        </div>
      </div>

      <div className="om-detail-grid">
        <section className="card">
          <h2>Why it&apos;s interesting</h2>
          <p>{market.thesis ?? 'Thesis not written yet. Run `python miner.py score` after Anthropic is configured, or add notes below.'}</p>
          {market.businessIdea && (
            <>
              <h3>Business idea</h3>
              <p>{market.businessIdea}</p>
            </>
          )}
          <h3>Customer</h3>
          <p>
            {market.likelyCustomer ?? NULL_DISPLAY} · {market.buyerType} · {market.monetizationModel.replace('_', ' ')}
          </p>
        </section>

        <section className="card">
          <h2>Risks</h2>
          <p>{market.risks ?? 'No risk write-up yet.'}</p>
          {market.rejectionReasons.length > 0 && (
            <p className="om-sub">Flags: {market.rejectionReasons.join(', ')}</p>
          )}
        </section>

        <section className="card">
          <h2>Economics</h2>
          <p className="om-sub">
            Price confidence: <strong>{economics?.priceConfidence ?? 'unknown'}</strong>
            {' · '}
            Lifetime: <strong>{economics?.lifetimeConfidence ?? 'unknown'}</strong>
          </p>
          <table className="sm-table">
            <thead>
              <tr>
                <th />
                <th className="num">Bear</th>
                <th className="num">Base</th>
                <th className="num">Bull</th>
              </tr>
            </thead>
            <tbody>
              <Triple label="Monthly price" a={economics?.estimatedMonthlyPriceBear} b={economics?.estimatedMonthlyPriceBase} c={economics?.estimatedMonthlyPriceBull} money />
              <Triple label="Lifetime months" a={economics?.estimatedLifetimeMonthsBear} b={economics?.estimatedLifetimeMonthsBase} c={economics?.estimatedLifetimeMonthsBull} />
              <Triple label="GP-LTV" a={economics?.grossProfitLtvBear} b={economics?.grossProfitLtvBase} c={economics?.grossProfitLtvBull} money />
              <Triple label="Allowable CAC" a={economics?.allowableCacBear} b={economics?.allowableCacBase} c={economics?.allowableCacBull} money />
              <Triple label="Sustainable CPC" a={economics?.sustainableCpcBear} b={economics?.sustainableCpcBase} c={economics?.sustainableCpcBull} money />
              <Triple label="CPC coverage" a={economics?.cpcCoverageBear} b={economics?.cpcCoverageBase} c={economics?.cpcCoverageBull} suffix="x" />
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Search demand</h2>
          <p className="om-sub">
            Raw {num(market.rawVolume)} · Adjusted {num(market.adjustedVolume)} (semantic-group max, then conservative overlap).
            Median KD {market.medianKd == null ? NULL_DISPLAY : market.medianKd.toFixed(0)}.
          </p>
          <table className="sm-table">
            <thead>
              <tr>
                <th>Keyword</th>
                <th className="num">Volume</th>
                <th className="num">CPC</th>
                <th className="num">KD</th>
                <th>Intent</th>
              </tr>
            </thead>
            <tbody>
              {keywords.slice(0, 20).map((k) => (
                <tr key={k.id}>
                  <td>{k.keyword}</td>
                  <td className="num">{num(k.volume)}</td>
                  <td className="num">{money(k.cpc)}</td>
                  <td className="num">{k.keywordDifficulty == null ? NULL_DISPLAY : k.keywordDifficulty.toFixed(0)}</td>
                  <td>{k.intent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Competitors</h2>
          <p className="om-sub">Organic traffic is Semrush domain_rank, not Traffic Analytics (plan-gated).</p>
          <table className="sm-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Role</th>
                <th className="num">Authority</th>
                <th className="num">Organic traffic</th>
                <th className="num">Keywords here</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={`${d.id}-${d.role}`}>
                  <td>{d.domain}</td>
                  <td>{d.role}</td>
                  <td className="num">{d.authorityScore == null ? NULL_DISPLAY : d.authorityScore.toFixed(0)}</td>
                  <td className="num">{num(d.estimatedOrganicTraffic)}</td>
                  <td className="num">{d.keywordCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Advertising evidence</h2>
          <p>
            {market.uniqueAdvertisers} unique advertisers · {market.persistentAdvertisers} treated as persistent.
          </p>
          {ads.length === 0 ? (
            <p className="om-sub">No ad copies stored yet. Discover with --live to pull phrase_adwords_historical.</p>
          ) : (
            <ul className="om-ads">
              {ads.slice(0, 8).map((ad) => (
                <li key={ad.id}>
                  <strong>{ad.adTitle ?? 'Untitled ad'}</strong>
                  <div>{ad.adText}</div>
                  <div className="om-sub">{ad.dateSeen ?? 'date unknown'}</div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Observed pricing</h2>
          {prices.length === 0 ? (
            <p className="om-sub">No pricing pages fetched. Estimates above are weakly inferred priors.</p>
          ) : (
            <ul>
              {prices.map((p) => (
                <li key={p.id}>
                  {p.sourceUrl}: {p.cheapestPaid != null ? `$${p.cheapestPaid}` : '—'} –{' '}
                  {p.highestSelfServe != null ? `$${p.highestSelfServe}` : '—'} ({p.confidence})
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Expansion</h2>
          <p>{market.expansionNotes ?? 'No adjacent-product write-up yet.'}</p>
        </section>

        <section className="card">
          <h2>Discovered via</h2>
          <pre className="om-cli">{market.discoveryPath ?? 'Seed → related keywords → this cluster'}</pre>
          {anomalies.length > 0 && (
            <>
              <h3>Anomaly screens</h3>
              <ul>
                {anomalies.map((a) => (
                  <li key={a.id}>
                    <strong>{a.kind.replace(/_/g, ' ')}</strong> — {a.why}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card">
          <h2>Review</h2>
          <ReviewForm
            slug={market.slug}
            status={market.status}
            notes={market.notes ?? ''}
            tags={market.tags}
            scoreOverride={market.scoreOverride}
          />
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="om-hero-stat">
      <div className="om-hero-value">{value}</div>
      <div className="om-hero-label">
        {label}
        {hint ? <span className={`om-conf ${hint === 'OBSERVED' ? 'observed' : 'inferred'}`}>{hint}</span> : null}
      </div>
    </div>
  )
}

function Triple({
  label,
  a,
  b,
  c,
  money: asMoney,
  suffix,
}: {
  label: string
  a: number | null | undefined
  b: number | null | undefined
  c: number | null | undefined
  money?: boolean
  suffix?: string
}) {
  const fmt = (n: number | null | undefined) => {
    if (n == null) return NULL_DISPLAY
    if (asMoney) return `$${n.toFixed(n >= 20 ? 0 : 2)}`
    if (suffix) return `${n.toFixed(2)}${suffix}`
    return n.toFixed(2)
  }
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmt(a)}</td>
      <td className="num">{fmt(b)}</td>
      <td className="num">{fmt(c)}</td>
    </tr>
  )
}

function money(n: number | null | undefined): string {
  return n == null ? NULL_DISPLAY : `$${n.toFixed(n >= 20 ? 0 : 2)}`
}

function pct(n: number | null | undefined): string {
  return n == null ? NULL_DISPLAY : `${Math.round(n * 100)}%`
}
