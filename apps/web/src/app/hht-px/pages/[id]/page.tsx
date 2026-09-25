import Link from 'next/link'
import { HHT_PX_OUTREACH_STATUSES, HHT_PX_PAGE_TYPE_LABELS, HHT_PX_WHY_LINK_LABELS, hhtPxArticleLabel } from '@rnr/core'
import { db, getHhtPxPageDetail } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import { updateHhtPxOutreachAction } from '../../actions'

export const dynamic = 'force-dynamic'

export default async function HhtPxPageDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ message?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const pageId = Number(id)
  const detail = Number.isInteger(pageId) ? await getHhtPxPageDetail(db(), pageId) : null
  if (!detail) {
    return (
      <div className="opp-workspace hht-bl-workspace">
        <header className="run-page-head hht-bl-head">
          <Link href="/hht-px?view=pages" className="hotel-bl-back">← Pages</Link>
          <h1 className="page-title">Page not found</h1>
        </header>
        <HhtSectionTabs active="serp-prospects" />
      </div>
    )
  }

  return (
    <div className="opp-workspace hht-bl-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <Link href="/hht-px?view=pages" className="hotel-bl-back">← Pages</Link>
          <h1 className="page-title">{hhtPxArticleLabel(detail.title, detail.url)}</h1>
          <p className="page-desc">
            <a href={detail.url} target="_blank" rel="noreferrer">{detail.url}</a>
          </p>
        </div>
      </header>
      <HhtSectionTabs active="serp-prospects" />
      {query.message ? <div className="hht-bl-credential-alert">{query.message}</div> : null}
      <section className="hotel-bl-detail-grid">
        <section className="hotel-bl-detail-card">
          <h2>Why they could link</h2>
          <p>
            <strong>{detail.whyLinkCategory ? HHT_PX_WHY_LINK_LABELS[detail.whyLinkCategory] : NULL_DISPLAY}.</strong>{' '}
            {detail.whyLink ?? NULL_DISPLAY}
          </p>
          <p>
            Suggested HHT URL:{' '}
            {detail.suggestedHhtUrl ? (
              <a href={detail.suggestedHhtUrl} target="_blank" rel="noreferrer">{detail.suggestedHhtUrl}</a>
            ) : (
              NULL_DISPLAY
            )}
          </p>
        </section>
        <section className="hotel-bl-detail-card">
          <h2>Page metrics</h2>
          <p>Type: {HHT_PX_PAGE_TYPE_LABELS[detail.pageType]}</p>
          <p>Prospectable: {detail.isProspectable ? 'Yes' : 'No'}</p>
          <p>Competitor: {detail.competitorStrength}</p>
          <p>Score: {detail.opportunityScore == null ? NULL_DISPLAY : detail.opportunityScore.toFixed(1)}</p>
          <p>Best position: {num(detail.bestPosition)}</p>
          <p>Highest keyword volume: {num(detail.maxKeywordVolume)} (US destination volume, not a synonym sum)</p>
          <p>Domain authority: {num(detail.domain.authorityScore)}</p>
          <p>Organic traffic: {num(detail.domain.organicTraffic)}</p>
        </section>
      </section>
      <section className="hht-bl-section">
        <div className="hht-bl-section-head"><div><h2>Matching queries</h2><p>US destination volume and organic position for each keyword this article ranks for.</p></div></div>
        <div className="hht-bl-table-wrap">
          <table className="hht-bl-table">
            <thead>
              <tr>
                <th>Keyword</th>
                <th>Geo</th>
                <th>Cluster</th>
                <th className="num">Position</th>
                <th className="num">Volume</th>
              </tr>
            </thead>
            <tbody>
              {detail.matches.map((row) => (
                <tr key={row.keywordId}>
                  <td>
                    <Link href={`/hht-px/keywords/${row.keywordId}`}>{row.keyword}</Link>
                    {row.returnedKeyword && row.returnedKeyword !== row.keyword ? (
                      <div className="hht-bl-subcell">Google Ads returned “{row.returnedKeyword}”</div>
                    ) : null}
                  </td>
                  <td>{row.geoName ?? 'National'}</td>
                  <td>{row.cluster.replaceAll('_', ' ')}</td>
                  <td className="num">{num(row.position)}</td>
                  <td className="num">{num(row.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="hht-bl-section">
        <form action={updateHhtPxOutreachAction} className="hht-px-filters">
          <input type="hidden" name="pageId" value={detail.id} />
          <input type="hidden" name="domainId" value={detail.domainId} />
          <label>
            Outreach
            <select name="status" defaultValue={detail.outreachStatus}>
              {HHT_PX_OUTREACH_STATUSES.map((status) => (
                <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>
              ))}
            </select>
          </label>
          <label>
            Notes
            <input name="notes" defaultValue={detail.notes ?? ''} />
          </label>
          <button type="submit">Save outreach</button>
        </form>
      </section>
    </div>
  )
}
