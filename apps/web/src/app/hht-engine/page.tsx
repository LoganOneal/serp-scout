import Link from 'next/link'
import { listEngineReviewLeads } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { bulkPushLeadsToCrmAction } from './actions'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function label(value: string | null | undefined): string {
  return value ? value.replaceAll('_', ' ') : '—'
}

function date(value: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(value)
}

function tone(status: string | null): string {
  if (status === 'APPROVED' || status === 'QUEUED' || status === 'PASS') return 'go'
  if (status === 'REJECTED' || status === 'EXCLUDED' || status === 'FAILED') return 'stop'
  if (status === 'REVIEW' || status === 'PENDING') return 'warn'
  return 'neutral'
}

export default async function HhtEngineReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const status = one(params['status']) ?? 'ALL'
  const type = one(params['type']) ?? 'ALL'
  const query = one(params['q']) ?? ''
  const [allLeads, leads] = await Promise.all([
    listEngineReviewLeads(),
    listEngineReviewLeads({ status, type, query }),
  ])
  const message = one(params['message'])
  const error = one(params['tone']) === 'error'
  const metrics = {
    pending: allLeads.filter((lead) => lead.reviewStatus === 'PENDING').length,
    needsReview: allLeads.filter((lead) => lead.filterStatus === 'REVIEW').length,
    approved: allLeads.filter((lead) => lead.reviewStatus === 'APPROVED').length,
    queued: allLeads.filter((lead) => lead.crmStatus === 'QUEUED').length,
    rejected: allLeads.filter((lead) => lead.reviewStatus === 'REJECTED').length,
  }

  return (
    <div className="opp-workspace hht-bl-workspace engine-review-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <h1 className="page-title">Outreach Review</h1>
          <p className="page-desc">
            Review research, edit sequences, and approve the exact snapshot that may enter the CRM outbox. This app never sends outreach.
          </p>
        </div>
      </header>

      <HhtSectionTabs active="outreach-review" />

      {message ? <div className={error ? 'stopbox engine-review-message' : 'okbox engine-review-message'} role={error ? 'alert' : 'status'}>{message}</div> : null}

      <main className="hht-bl-view">
        <section className="hht-bl-summary hotel-bl-summary engine-review-summary" aria-label="Review queue summary">
          <Metric label="Pending review" value={metrics.pending} />
          <Metric label="Engine review flags" value={metrics.needsReview} />
          <Metric label="Approved" value={metrics.approved} />
          <Metric label="CRM queued" value={metrics.queued} />
          <Metric label="Rejected" value={metrics.rejected} />
        </section>

        <form method="get" className="hotel-bl-filters engine-review-filters" aria-label="Lead filters">
          <label>
            <span>Review status</span>
            <select name="status" defaultValue={status}>
              <option value="ALL">All</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
          <label>
            <span>Opportunity type</span>
            <select name="type" defaultValue={type}>
              <option value="ALL">All</option>
              <option value="guest_post">Guest post</option>
              <option value="link_insertion">Link insertion</option>
            </select>
          </label>
          <label className="engine-review-search">
            <span>Search</span>
            <input name="q" type="search" defaultValue={query} placeholder="Domain or subject" />
          </label>
          <div className="hotel-bl-filter-actions">
            <button className="primary" type="submit">Apply filters</button>
            <Link href="/hht-engine">Clear</Link>
          </div>
        </form>

        {leads.length === 0 ? (
          <div className="hht-bl-empty">
            No leads match these filters. Engine-generated drafts will appear here automatically.
          </div>
        ) : (
          <form action={bulkPushLeadsToCrmAction} className="engine-review-bulk-form">
            <div className="engine-review-toolbar">
              <p>Select approved leads to queue their exact approved snapshots. Changed or unapproved leads are skipped.</p>
              <button className="primary" type="submit">Push selected to CRM</button>
            </div>
            <div className="hht-bl-table-wrap">
              <table className="hht-bl-table engine-review-table">
                <thead>
                  <tr>
                    <th scope="col"><span className="sr-only">Select</span></th>
                    <th scope="col">Publisher</th>
                    <th scope="col">Type</th>
                    <th scope="col">Pipeline</th>
                    <th scope="col">Filters</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Draft</th>
                    <th scope="col">Review</th>
                    <th scope="col">CRM</th>
                    <th scope="col">Updated</th>
                    <th scope="col"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td>
                        <input
                          type="checkbox"
                          name="opportunityIds"
                          value={lead.id}
                          disabled={lead.reviewStatus !== 'APPROVED'}
                          aria-label={`Select ${lead.domain}`}
                        />
                      </td>
                      <td>
                        <Link href={`/hht-engine/${lead.id}`} className="hht-bl-domain">{lead.domain}</Link>
                        {lead.displayName ? <div className="hht-bl-subcell">{lead.displayName}</div> : null}
                      </td>
                      <td>{label(lead.type)}</td>
                      <td><span className={`badge ${tone(lead.pipelineStatus)}`}>{label(lead.pipelineStatus)}</span></td>
                      <td>
                        <span className={`badge ${tone(lead.filterStatus)}`}>{label(lead.filterStatus)}</span>
                        {lead.filterReasons.length ? <div className="hht-bl-subcell">{lead.filterReasons.join(', ')}</div> : null}
                      </td>
                      <td>{label(lead.contactMethod)}</td>
                      <td><span className={`badge ${lead.hasDraft ? 'go' : 'warn'}`}>{lead.hasDraft ? 'Ready' : 'Missing'}</span></td>
                      <td><span className={`badge ${tone(lead.reviewStatus)}`}>{label(lead.reviewStatus)}</span></td>
                      <td><span className={`badge ${tone(lead.crmStatus)}`}>{label(lead.crmStatus)}</span></td>
                      <td>{date(lead.updatedAt)}</td>
                      <td><Link className="button-link tiny" href={`/hht-engine/${lead.id}`}>Review</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        )}
      </main>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="hht-bl-summary-item">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  )
}
