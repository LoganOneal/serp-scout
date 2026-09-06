import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HHT_OPP_STATUSES, HHT_OPP_TYPE_LABELS, formatPrice, type HhtOppType } from '@rnr/core'
import { db, getHhtOppDetail, queryOr, suggestHhtAssets } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import { generateHhtOppDraftAction, recordHhtOppOutreachAction, updateHhtOppStatusAction } from '../actions'

export const dynamic = 'force-dynamic'

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

export default async function HhtOppDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id: rawId } = await params
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) notFound()
  const detail = await queryOr('getHhtOppDetail', () => getHhtOppDetail(db(), id), null)
  if (!detail) notFound()

  const sp = await searchParams
  const message = Array.isArray(sp['message']) ? sp['message'][0] : sp['message']
  const messageTone = (Array.isArray(sp['tone']) ? sp['tone'][0] : sp['tone']) === 'error' ? 'stopbox' : 'okbox'
  const { opportunity, domain, requirements, sources, pricing, contacts, drafts, pages, outreach, metrics } = detail
  const assets = await queryOr(
    'suggestHhtAssets',
    () =>
      suggestHhtAssets(db(), {
        text: `${opportunity.whyItMatters ?? ''} ${opportunity.requirementsSummary.join(' ')}`,
        opportunityUrl: opportunity.opportunityUrl,
      }),
    [],
  )
  const priceLabel = formatPrice({
    amount: opportunity.priceAmount,
    currency: opportunity.priceCurrency,
    status: opportunity.priceStatus,
    pricingModel: opportunity.pricingModel,
    included: null,
    evidence: null,
  })

  return (
    <div className="opp-workspace hht-bl-workspace hht-opp-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <Link href="/hht-opp" className="hotel-bl-back">
            ← Opportunity Engine
          </Link>
          <h1 className="page-title">{domain.rootDomain}</h1>
          <p className="page-desc">
            {label(opportunity.opportunityType)}
            {opportunity.inventedType && typeof opportunity.inventedType['name'] === 'string'
              ? ` · ${opportunity.inventedType['name']}`
              : ''}
          </p>
        </div>
        <a href={opportunity.opportunityUrl} target="_blank" rel="noreferrer" className="button-link">
          Open opportunity URL
        </a>
      </header>
      <HhtSectionTabs active="opportunity-engine" />
      {message ? <div className={messageTone}>{message}</div> : null}

      <main className="hht-bl-view hht-opp-detail">
        <section className="hht-bl-summary hotel-bl-summary">
          <Fact label="Overall" value={opportunity.overallScore == null ? NULL_DISPLAY : opportunity.overallScore.toFixed(1)} />
          <Fact label="Feasibility" value={opportunity.feasibilityScore == null ? NULL_DISPLAY : opportunity.feasibilityScore.toFixed(1)} />
          <Fact label="SEO value" value={opportunity.seoValueScore == null ? NULL_DISPLAY : opportunity.seoValueScore.toFixed(1)} />
          <Fact label="Authority Score" value={num(metrics['authority_score'] ?? null)} />
          <Fact label="Organic traffic" value={num(metrics['organic_traffic'] ?? null)} />
          <Fact label="Referring domains" value={num(metrics['referring_domains'] ?? null)} />
        </section>

        <div className="hht-opp-detail-grid">
          <article className="hotel-bl-detail-card">
            <h2>Overview</h2>
            <p>{opportunity.whyItMatters ?? 'No thesis stored.'}</p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${tone(opportunity.status)}`}>{opportunity.status}</span>
                </dd>
              </div>
              <div>
                <dt>Eligibility</dt>
                <dd>
                  <span className={`badge ${tone(opportunity.eligibility)}`}>{opportunity.eligibility}</span> · {opportunity.eligibilityReason}
                </dd>
              </div>
              <div>
                <dt>Pitch angle</dt>
                <dd>{opportunity.pitchAngle ?? NULL_DISPLAY}</dd>
              </div>
              <div>
                <dt>Discovered by</dt>
                <dd>{opportunity.discoveredByStrategy.replaceAll('_', ' ')}</dd>
              </div>
              {opportunity.requirementsChanged ? (
                <div>
                  <dt>Freshness</dt>
                  <dd>Publisher requirements changed.</dd>
                </div>
              ) : null}
            </dl>
            <form action={updateHhtOppStatusAction} className="hht-opp-status-form">
              <input type="hidden" name="opportunityId" value={opportunity.id} />
              <label>
                <span>Human status</span>
                <select name="status" defaultValue={opportunity.status}>
                  {HHT_OPP_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">Update status</button>
            </form>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Eligibility</h2>
            <p>
              <strong>{opportunity.eligibility}</strong> ({opportunity.eligibilityConfidence} confidence)
            </p>
            <p>{opportunity.eligibilityReason}</p>
            {opportunity.eligibilityExcerpt ? <blockquote>{opportunity.eligibilityExcerpt}</blockquote> : <p>No explicit eligibility excerpt — this cannot be a PASS.</p>}
            <p className="muted">
              Source: {opportunity.eligibilitySourceUrl ?? NULL_DISPLAY} · checked {date(opportunity.eligibilityCheckedAt)}
            </p>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Pricing</h2>
            <p className="hht-opp-price">{priceLabel}</p>
            {pricing.length === 0 ? (
              <p>No public price extracted. Never invent one.</p>
            ) : (
              <ul>
                {pricing.map((row) => (
                  <li key={row.id}>
                    {row.label}: {row.amount != null ? `$${row.amount}` : priceLabel}
                    {row.evidenceText ? <div className="muted">{row.evidenceText}</div> : null}
                    <div className="muted">
                      {row.evidenceUrl} · {date(row.dateChecked)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Link details</h2>
            <dl>
              <div>
                <dt>Link type</dt>
                <dd>{opportunity.linkType.replaceAll('_', ' ')}</dd>
              </div>
              <div>
                <dt>SEO risk</dt>
                <dd>
                  <span className={`badge ${tone(opportunity.seoRisk === 'HIGH' ? 'FAIL' : opportunity.seoRisk === 'MEDIUM' ? 'REVIEW' : 'PASS')}`}>
                    {opportunity.seoRisk}
                  </span>
                </dd>
              </div>
            </dl>
            <ul>
              {opportunity.seoRiskReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="muted">
              Avg. external links/article: {domain.avgExternalLinks == null ? NULL_DISPLAY : domain.avgExternalLinks.toFixed(1)} (sampled {domain.outboundSampleSize ?? 0} pages — not a sitewide total)
            </p>
          </article>
        </div>

        <article className="hotel-bl-detail-card">
          <h2>Requirements</h2>
          {opportunity.requirementsSummary.length > 0 ? (
            <ul className="hht-opp-summary-list">
              {opportunity.requirementsSummary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {requirements.length === 0 ? (
            <p>No structured requirements extracted.</p>
          ) : (
            <div className="hht-bl-table-wrap">
              <table className="hht-bl-table">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Requirement</th>
                    <th>Evidence</th>
                    <th>Source</th>
                    <th>Confidence</th>
                    <th>Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.map((row) => (
                    <tr key={row.id}>
                      <td>{row.groupName}</td>
                      <td>
                        <strong>{row.label}</strong>
                        <div>{row.requirementText}</div>
                      </td>
                      <td className="hht-bl-long-cell">{row.sourceExcerpt}</td>
                      <td>
                        <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                          {row.sourceUrl}
                        </a>
                      </td>
                      <td>{row.confidence}</td>
                      <td>{date(row.dateChecked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <div className="hht-opp-detail-grid">
          <article className="hotel-bl-detail-card">
            <h2>Broken link / replacement</h2>
            {opportunity.brokenUrl ? (
              <dl>
                <div>
                  <dt>Broken URL</dt>
                  <dd>
                    <a href={opportunity.brokenUrl} target="_blank" rel="noreferrer">
                      {opportunity.brokenUrl}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Proposed HHT replacement</dt>
                  <dd>
                    {opportunity.replacementUrl ? (
                      <a href={opportunity.replacementUrl} target="_blank" rel="noreferrer">
                        {opportunity.replacementUrl}
                      </a>
                    ) : (
                      NULL_DISPLAY
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <p>No broken-link target on this row.</p>
            )}
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Relevant existing content</h2>
            {opportunity.relevantArticleUrl ? (
              <p>
                <a href={opportunity.relevantArticleUrl} target="_blank" rel="noreferrer">
                  {opportunity.relevantArticleUrl}
                </a>
              </p>
            ) : (
              <p>No specific article stored.</p>
            )}
            <ul>
              {pages
                .filter((page) => page.title)
                .slice(0, 8)
                .map((page) => (
                  <li key={page.id}>
                    <a href={page.url} target="_blank" rel="noreferrer">
                      {page.title}
                    </a>
                  </li>
                ))}
            </ul>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>HHT assets</h2>
            <ul>
              {assets.map((asset) => (
                <li key={asset.url}>
                  <a href={asset.url} target="_blank" rel="noreferrer">
                    {asset.label}
                  </a>
                  <div className="muted">
                    {asset.reason}
                    {asset.imageRights === 'UNKNOWN' ? ' Image rights require review.' : ''}
                  </div>
                </li>
              ))}
            </ul>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>SEO metrics</h2>
            <dl>
              <div>
                <dt>Authority Score</dt>
                <dd>{num(metrics['authority_score'] ?? null)}</dd>
              </div>
              <div>
                <dt>Organic traffic</dt>
                <dd>{num(metrics['organic_traffic'] ?? null)}</dd>
              </div>
              <div>
                <dt>Organic keywords</dt>
                <dd>{num(metrics['organic_keywords'] ?? null)}</dd>
              </div>
              <div>
                <dt>Referring domains</dt>
                <dd>{num(metrics['referring_domains'] ?? null)}</dd>
              </div>
              <div>
                <dt>Backlinks</dt>
                <dd>{num(metrics['backlinks'] ?? null)}</dd>
              </div>
            </dl>
            <p className="muted">Semrush Authority Score, not DA. Empty until you enrich a PASS or approved REVIEW domain.</p>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Contacts</h2>
            {contacts.length === 0 ? (
              <p>No public contact extracted. Default outreach only to VERIFIED_PUBLIC addresses.</p>
            ) : (
              <ul>
                {contacts.map((row) => (
                  <li key={row.id}>
                    {row.email ?? row.formUrl ?? NULL_DISPLAY} · {row.status}
                    <div className="muted">{row.sourceUrl}</div>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>

        <article className="hotel-bl-detail-card">
          <h2>Sources</h2>
          <ul>
            {sources.map((row) => (
              <li key={row.id}>
                <a href={row.url} target="_blank" rel="noreferrer">
                  {row.title ?? row.url}
                </a>{' '}
                · {row.role}
              </li>
            ))}
          </ul>
        </article>

        <article className="hotel-bl-detail-card">
          <h2>Outreach outcomes</h2>
          <p>Log what happened after a human sent a pitch. This form does not send email.</p>
          <form action={recordHhtOppOutreachAction} className="hht-opp-outreach-form">
            <input type="hidden" name="opportunityId" value={opportunity.id} />
            <label>
              <span>Date sent</span>
              <input type="date" name="dateSent" />
            </label>
            <label>
              <span>Channel</span>
              <input name="channel" defaultValue="email" />
            </label>
            <label>
              <span>Quoted price</span>
              <input type="number" name="priceQuoted" min="0" step="1" />
            </label>
            <label>
              <span>Final cost</span>
              <input type="number" name="finalCost" min="0" step="1" />
            </label>
            <label>
              <span>Link URL</span>
              <input name="linkUrl" />
            </label>
            <label>
              <span>Target HHT URL</span>
              <input name="targetHhtUrl" />
            </label>
            <label className="hotel-bl-check">
              <input type="checkbox" name="reply" value="1" />
              <span>Reply</span>
            </label>
            <label className="hotel-bl-check">
              <input type="checkbox" name="positiveReply" value="1" />
              <span>Positive reply</span>
            </label>
            <label className="hotel-bl-check">
              <input type="checkbox" name="linkAcquired" value="1" />
              <span>Link acquired</span>
            </label>
            <label>
              <span>Notes</span>
              <input name="notes" />
            </label>
            <button className="primary" type="submit">
              Save outcome
            </button>
          </form>
          {outreach.length === 0 ? (
            <p>No outreach events recorded.</p>
          ) : (
            <ul>
              {outreach.map((row) => (
                <li key={row.id}>
                  {date(row.dateSent)} · {row.channel ?? '—'}
                  {row.reply ? ' · reply' : ''}
                  {row.linkAcquired ? ' · link acquired' : ''}
                  {row.finalCost != null ? ` · $${row.finalCost}` : ''}
                  {row.notes ? ` · ${row.notes}` : ''}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="hotel-bl-detail-card">
          <h2>Drafts</h2>
          <p>Human approval only. Nothing here sends mail.</p>
          <form action={generateHhtOppDraftAction} className="hht-opp-draft-actions">
            <input type="hidden" name="opportunityId" value={opportunity.id} />
            <button className="primary" type="submit" name="tone" value="default">
              Generate draft
            </button>
            <button type="submit" name="tone" value="shorter">
              Shorter
            </button>
            <button type="submit" name="tone" value="more_editorial">
              More editorial
            </button>
            <button type="submit" name="tone" value="more_casual">
              More casual
            </button>
            <button type="submit" name="tone" value="more_data">
              More data-driven
            </button>
            <button type="submit" name="tone" value="new_angle">
              New angle
            </button>
          </form>
          {drafts.length === 0 ? (
            <p>No drafts yet.</p>
          ) : (
            drafts.map((draft) => (
              <section key={draft.id} className="hht-opp-draft">
                <h3>
                  {draft.subject} <span className="muted">{date(draft.createdAt)} · {draft.tone} · {draft.status}</span>
                </h3>
                {draft.pitchAngle ? <p className="muted">{draft.pitchAngle}</p> : null}
                <pre>{draft.body}</pre>
                {draft.articleIdeas.length > 0 ? (
                  <ul>
                    {draft.articleIdeas.map((idea) => (
                      <li key={idea}>{idea}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))
          )}
        </article>
      </main>
    </div>
  )
}

function Fact({ label: factLabel, value }: { label: string; value: string }) {
  return (
    <div className="hht-bl-summary-item">
      <span>{factLabel}</span>
      <strong>{value}</strong>
    </div>
  )
}
