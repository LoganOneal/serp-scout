import Link from 'next/link'
import { HHT_PX_PAGE_TYPES, HHT_PX_PAGE_TYPE_LABELS, hhtPxBadgeGroup } from '@rnr/core'
import { db, getHhtPxKeywordDetail } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import { overrideHhtPxSerpAction } from '../../actions'

export const dynamic = 'force-dynamic'

function pct(value: number | null | undefined): string {
  if (value == null) return NULL_DISPLAY
  return `${Math.round(value * 100)}%`
}

export default async function HhtPxKeywordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ message?: string; tone?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const keywordId = Number(id)
  const detail = Number.isInteger(keywordId) ? await getHhtPxKeywordDetail(db(), keywordId) : null
  if (!detail) {
    return (
      <div className="opp-workspace hht-bl-workspace">
        <header className="run-page-head hht-bl-head">
          <Link href="/hht-px?view=keywords" className="hotel-bl-back">← Keywords</Link>
          <h1 className="page-title">Keyword not found</h1>
        </header>
        <HhtSectionTabs active="serp-prospects" />
      </div>
    )
  }

  return (
    <div className="opp-workspace hht-bl-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <Link href="/hht-px?view=keywords" className="hotel-bl-back">← Keywords</Link>
          <h1 className="page-title">{detail.keyword}</h1>
          <p className="page-desc">
            {detail.geoName ?? 'National'} · {detail.cluster.replaceAll('_', ' ')} · Volume {num(detail.volume)}
            {detail.returnedKeyword && detail.returnedKeyword !== detail.keyword
              ? ` · Google returned “${detail.returnedKeyword}”`
              : ''}
          </p>
        </div>
      </header>
      <HhtSectionTabs active="serp-prospects" />
      {query.message ? <div className={query.tone === 'error' ? 'stopbox' : 'hht-bl-credential-alert'}>{query.message}</div> : null}
      <section className="hht-bl-summary">
        <div className="hht-bl-summary-item"><span>Opportunity score</span><strong>{detail.score == null ? NULL_DISPLAY : detail.score.toFixed(1)}</strong></div>
        <div className="hht-bl-summary-item"><span>Editorial density</span><strong>{pct(detail.editorialDensity)}</strong></div>
        <div className="hht-bl-summary-item"><span>Prospectable density</span><strong>{pct(detail.prospectableDensity)}</strong></div>
        <div className="hht-bl-summary-item"><span>SERP status</span><strong>{detail.serpStatus}</strong></div>
      </section>
      <section className="hht-bl-section">
        <div className="hht-bl-section-head">
          <div>
            <h2>Organic results</h2>
            <p>Raw rows are kept even when a domain rule flags them as not prospectable. Overrides are stored on the result.</p>
          </div>
        </div>
        {detail.results.length === 0 ? (
          <div className="hht-bl-empty">No cached SERP. Run Semrush on the representative keyword first.</div>
        ) : (
          <div className="hht-bl-table-wrap">
            <table className="hht-bl-table">
              <thead>
                <tr>
                  <th className="num">Pos</th>
                  <th>Result</th>
                  <th>Type</th>
                  <th>Prospectable</th>
                  <th>Competitor</th>
                  <th>Override</th>
                </tr>
              </thead>
              <tbody>
                {detail.results.map((row) => (
                  <tr key={row.id}>
                    <td className="num">{row.position}</td>
                    <td>
                      <a href={row.url} target="_blank" rel="noreferrer" className="hht-bl-url">{row.title ?? row.url}</a>
                      <div className="hht-bl-subcell">{row.rootDomain}</div>
                    </td>
                    <td>
                      <span className={`badge hht-px-badge-${hhtPxBadgeGroup(row.pageType)}`}>
                        {HHT_PX_PAGE_TYPE_LABELS[row.pageType]}
                      </span>
                    </td>
                    <td>{row.isProspectable ? 'Yes' : 'No'}{row.manualOverride ? ' · override' : ''}</td>
                    <td>{row.competitorStrength}</td>
                    <td>
                      <form action={overrideHhtPxSerpAction} className="hht-px-override">
                        <input type="hidden" name="resultId" value={row.id} />
                        <input type="hidden" name="keywordId" value={detail.id} />
                        <select name="pageType" defaultValue={row.pageType} aria-label="Page type">
                          {HHT_PX_PAGE_TYPES.map((type) => (
                            <option key={type} value={type}>{HHT_PX_PAGE_TYPE_LABELS[type]}</option>
                          ))}
                        </select>
                        <select name="isProspectable" defaultValue={row.isProspectable ? 'yes' : 'no'} aria-label="Prospectable">
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                        <button type="submit">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
