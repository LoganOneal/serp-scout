import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getEngineReviewLead } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import {
  approveLeadReviewAction,
  pushLeadToCrmAction,
  rejectLeadReviewAction,
  saveLeadReviewAction,
} from '../actions'

export const dynamic = 'force-dynamic'

function label(value: string | null | undefined): string {
  return value ? value.replaceAll('_', ' ') : '—'
}

function date(value: Date | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function tone(status: string | null): string {
  if (status === 'APPROVED' || status === 'QUEUED' || status === 'PASS') return 'go'
  if (status === 'REJECTED' || status === 'EXCLUDED' || status === 'FAILED') return 'stop'
  if (status === 'REVIEW' || status === 'PENDING') return 'warn'
  return 'neutral'
}

export default async function HhtEngineReviewDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id: rawId } = await params
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) notFound()
  const lead = await getEngineReviewLead(id)
  if (!lead) notFound()
  const sp = await searchParams
  const message = Array.isArray(sp['message']) ? sp['message'][0] : sp['message']
  const error = (Array.isArray(sp['tone']) ? sp['tone'][0] : sp['tone']) === 'error'
  const sequence = lead.review?.sequence ?? []
  const followup1 = sequence.find((step) => step.position === 1)
  const followup2 = sequence.find((step) => step.position === 2)
  const evidence = lead.publisher?.guidelineEvidence ?? {}

  return (
    <div className="opp-workspace hht-bl-workspace engine-review-workspace">
      <header className="run-page-head hht-bl-head engine-review-detail-head">
        <div>
          <Link href="/hht-engine" className="hotel-bl-back">← Outreach Review</Link>
          <h1 className="page-title">{lead.domain}</h1>
          <p className="page-desc">{label(lead.type)} · exact-copy approval before CRM queueing</p>
        </div>
        <div className="engine-review-head-status">
          <span className={`badge ${tone(lead.reviewStatus)}`}>{lead.reviewStatus}</span>
          <span className={`badge ${tone(lead.crmStatus)}`}>CRM {label(lead.crmStatus)}</span>
        </div>
      </header>

      <HhtSectionTabs active="outreach-review" />
      {message ? <div className={error ? 'stopbox engine-review-message' : 'okbox engine-review-message'} role={error ? 'alert' : 'status'}>{message}</div> : null}
      {lead.reviewStatus === 'APPROVED' && !lead.approvalCurrent ? (
        <div className="warnbox engine-review-message" role="alert">
          Research, contact, target, or copy changed after approval. Re-approve before pushing to CRM.
        </div>
      ) : null}

      <main className="hht-bl-view engine-review-detail">
        <section className="hht-bl-summary hotel-bl-summary engine-review-summary" aria-label="Lead summary">
          <Fact label="Review" value={lead.reviewStatus} />
          <Fact label="Pipeline" value={label(lead.pipelineStatus)} />
          <Fact label="Filter" value={label(lead.filterStatus)} />
          <Fact label="Authority" value={lead.publisher?.semrushAuthorityScore?.toString() ?? '—'} />
          <Fact label="Contact" value={label(lead.contactMethod)} />
          <Fact label="CRM outbox" value={label(lead.crmStatus)} />
        </section>

        <div className="engine-review-detail-grid">
          <article className="hotel-bl-detail-card">
            <h2>Opportunity</h2>
            <dl>
              <Detail label="Type" value={label(lead.type)} />
              <Detail label="Best keyword" value={lead.opportunity.bestKeyword ?? lead.opportunity.sourceKeyword ?? '—'} />
              <Detail label="SERP position" value={lead.opportunity.bestPosition?.toString() ?? '—'} />
              <Detail label="Insertion suggestion" value={lead.opportunity.insertionSuggestion ?? '—'} />
              <Detail label="Filter reasons" value={lead.filterReasons.join(', ') || 'None'} />
            </dl>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>HHT target</h2>
            <dl>
              <DetailLink label="Primary page" href={lead.opportunity.targetHhtUrl} />
              <DetailLink label="Secondary page" href={lead.opportunity.secondaryHhtUrl} />
              <Detail label="Match rule" value={lead.opportunity.matchRule ?? '—'} />
              <Detail label="Confidence" value={lead.opportunity.matchConfidence?.toFixed(2) ?? '—'} />
              <Detail label="Weak match" value={lead.opportunity.weakTargetMatch ? 'Yes — review carefully' : 'No'} />
            </dl>
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Contact</h2>
            {lead.contact ? (
              <dl>
                <Detail label="Method" value={label(lead.publisher?.submissionMethod ?? lead.contact.method)} />
                <Detail label="Name" value={lead.contact.name ?? '—'} />
                <Detail label="Role" value={lead.contact.role ?? '—'} />
                <Detail label="Email" value={lead.contact.email ?? '—'} />
                <DetailLink label="Form" href={lead.publisher?.submissionUrl ?? lead.contact.formUrl} />
                <Detail label="Validation" value={label(lead.contact.validationStatus)} />
                <DetailLink label="Source" href={lead.contact.source} />
              </dl>
            ) : <p>No contact has been extracted.</p>}
          </article>

          <article className="hotel-bl-detail-card">
            <h2>Publisher</h2>
            <dl>
              <Detail label="Name" value={lead.publisher?.displayName ?? '—'} />
              <Detail label="Site type" value={label(lead.publisher?.siteType)} />
              <Detail label="Primary topic" value={lead.publisher?.primaryTopic ?? '—'} />
              <Detail label="Authority Score" value={lead.publisher?.semrushAuthorityScore?.toString() ?? '—'} />
              <Detail label="Discovered" value={date(lead.opportunity.discoveredAt)} />
            </dl>
          </article>
        </div>

        {lead.type === 'guest_post' ? (
          <>
            <article className="hotel-bl-detail-card">
              <div className="hht-bl-section-head">
                <div>
                  <h2>Guest-post guidelines</h2>
                  <p>Structured requirements and the source URL supporting each field.</p>
                </div>
                {lead.research?.evidenceUrl ? <a href={lead.research.evidenceUrl} target="_blank" rel="noreferrer">Open main evidence</a> : null}
              </div>
              <div className="engine-guideline-grid">
                <Guideline label="Submission method" value={label(lead.publisher?.submissionMethod)} evidence={evidence['submission_method']} />
                <Guideline label="Submission URL" value={lead.publisher?.submissionUrl ?? '—'} evidence={evidence['submission_url']} />
                <Guideline label="Topic ideas required" value={lead.publisher?.pitchTopicCount?.toString() ?? 'Default: 3'} evidence={evidence['pitch_topic_count']} />
                <Guideline label="Outline or draft" value={label(lead.publisher?.pitchContentStage)} evidence={evidence['pitch_content_stage']} />
                <Guideline label="Subject format" value={lead.publisher?.requiredSubjectLineFormat ?? 'No required format'} evidence={evidence['required_subject_line_format']} />
                <Guideline label="Accepted topics" value={lead.publisher?.acceptedTopics?.join(', ') || '—'} evidence={evidence['accepted_topics']} />
                <Guideline label="Excluded topics" value={lead.publisher?.excludedTopics?.join(', ') || '—'} evidence={evidence['excluded_topics']} />
                <Guideline label="Word count" value={lead.publisher?.wordCount ?? '—'} evidence={evidence['word_count']} />
                <Guideline label="Link policy" value={lead.publisher?.linkPolicy ?? '—'} evidence={evidence['link_policy']} />
                <Guideline label="Samples required" value={lead.publisher?.samplesRequired ? 'Yes — REVIEW' : 'No'} evidence={evidence['samples_required']} />
                <Guideline label="Bio required" value={lead.publisher?.bioRequired ? 'Yes' : 'No'} evidence={evidence['bio_required']} />
                <Guideline label="AI policy" value={lead.publisher?.aiContentPolicy ?? '—'} evidence={evidence['ai_content_policy']} />
                <Guideline label="Paid or sponsored" value={lead.publisher?.paidOrSponsored ? 'Yes — REVIEW' : 'No'} evidence={evidence['paid_or_sponsored']} />
              </div>
            </article>

            <article className="hotel-bl-detail-card">
              <h2>Grounded personalization</h2>
              {(lead.opportunity.guestPostPitchTopics ?? []).length ? (
                <ol className="engine-topic-list">
                  {(lead.opportunity.guestPostPitchTopics ?? []).map((topic) => (
                    <li key={`${topic.title}:${topic.targetHhtUrl}`}>
                      <strong>{topic.title}</strong>
                      <div><a href={topic.targetHhtUrl} target="_blank" rel="noreferrer">HHT target</a></div>
                      <Citations urls={topic.citations} />
                    </li>
                  ))}
                </ol>
              ) : <p>No grounded pitch topics are available.</p>}
              <h3>Fit line</h3>
              <p>{lead.opportunity.guestPostFitLine ?? '—'}</p>
              <Citations urls={lead.opportunity.guestPostFitLineCitations ?? []} />
              <h3>Generated subject</h3>
              <p>{lead.opportunity.guestPostSubjectLine ?? '—'}</p>
              <Citations urls={lead.opportunity.guestPostSubjectLineCitations ?? []} />
            </article>
          </>
        ) : null}

        <article className="hotel-bl-detail-card">
          <h2>Source pages and rankings</h2>
          {lead.pages.length ? (
            <div className="hht-bl-table-wrap">
              <table className="hht-bl-table engine-source-table">
                <thead><tr><th>Page</th><th>Keyword</th><th>Position</th></tr></thead>
                <tbody>
                  {lead.pages.map((page) => (
                    <tr key={page.id}>
                      <td><a href={page.canonicalUrl} target="_blank" rel="noreferrer">{page.title ?? page.canonicalUrl}</a></td>
                      <td>{page.keyword ?? '—'}</td>
                      <td>{page.bestPosition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p>No source pages are attached.</p>}
        </article>

        <form action={saveLeadReviewAction} className="hotel-bl-detail-card engine-copy-form">
          <input type="hidden" name="opportunityId" value={lead.id} />
          <div className="hht-bl-section-head">
            <div>
              <h2>Copy and sequence</h2>
              <p>Edits invalidate an approval. The CRM receives these exact words and may not regenerate them.</p>
            </div>
            <span className="muted">{lead.draft?.templateId ? `Template: ${lead.draft.templateId}` : 'No source template'}</span>
          </div>
          <label>
            <span>Initial subject</span>
            <input name="subject" defaultValue={lead.subject} required />
          </label>
          <label>
            <span>Initial body</span>
            <textarea name="body" rows={14} defaultValue={lead.body} required />
          </label>
          <fieldset>
            <legend>Follow-up 1 (optional)</legend>
            <div className="engine-sequence-row">
              <label>
                <span>Delay in days</span>
                <input name="followup1Delay" type="number" min="1" max="90" defaultValue={followup1?.delayDays ?? 3} />
              </label>
              <label>
                <span>Subject</span>
                <input name="followup1Subject" defaultValue={followup1?.subject ?? ''} />
              </label>
            </div>
            <label>
              <span>Body</span>
              <textarea name="followup1Body" rows={6} defaultValue={followup1?.body ?? ''} />
            </label>
          </fieldset>
          <fieldset>
            <legend>Follow-up 2 (optional)</legend>
            <div className="engine-sequence-row">
              <label>
                <span>Delay in days</span>
                <input name="followup2Delay" type="number" min="1" max="90" defaultValue={followup2?.delayDays ?? 7} />
              </label>
              <label>
                <span>Subject</span>
                <input name="followup2Subject" defaultValue={followup2?.subject ?? ''} />
              </label>
            </div>
            <label>
              <span>Body</span>
              <textarea name="followup2Body" rows={6} defaultValue={followup2?.body ?? ''} />
            </label>
          </fieldset>
          <div className="engine-reviewer-grid">
            <label>
              <span>Reviewer</span>
              <input name="reviewer" defaultValue={lead.review?.reviewer ?? 'Kai'} required />
            </label>
            <label>
              <span>Review notes</span>
              <textarea name="notes" rows={3} defaultValue={lead.review?.notes ?? ''} />
            </label>
          </div>
          <div className="engine-review-actions">
            <button type="submit">Save changes</button>
            <button className="primary" type="submit" formAction={approveLeadReviewAction}>Approve exact snapshot</button>
            <button className="danger" type="submit" formAction={rejectLeadReviewAction}>Reject</button>
          </div>
        </form>

        <article className="hotel-bl-detail-card engine-crm-card">
          <div>
            <h2>CRM handoff</h2>
            <p>
              Queueing writes one approved payload to Supabase. The CRM integration is not connected yet, so this does not send outreach.
            </p>
          </div>
          <form action={pushLeadToCrmAction}>
            <input type="hidden" name="opportunityId" value={lead.id} />
            <button className="primary" type="submit" disabled={!lead.approvalCurrent}>
              {lead.crmStatus === 'QUEUED' ? 'Re-queue approved snapshot' : 'Push to CRM'}
            </button>
          </form>
        </article>

        <article className="hotel-bl-detail-card">
          <h2>Review history</h2>
          {lead.events.length ? (
            <ol className="engine-review-history">
              {lead.events.map((event) => (
                <li key={event.id}>
                  <span className={`badge ${tone(event.decision)}`}>{event.decision}</span>
                  {' '}{event.reviewer ?? 'Unknown reviewer'} · {date(event.createdAt)}
                  {event.notes ? <div>{event.notes}</div> : null}
                  {event.contentHash ? <code>{event.contentHash.slice(0, 12)}</code> : null}
                </li>
              ))}
            </ol>
          ) : <p>No decisions recorded yet.</p>}
        </article>
      </main>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="hht-bl-summary-item"><span>{label}</span><strong>{value}</strong></div>
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function DetailLink({ label, href }: { label: string; href: string | null | undefined }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{href ? <a href={href} target="_blank" rel="noreferrer">{href}</a> : '—'}</dd>
    </div>
  )
}

function Guideline({ label, value, evidence }: { label: string; value: string; evidence?: string }) {
  return (
    <div className="engine-guideline">
      <h3>{label}</h3>
      <p>{value}</p>
      {evidence ? <a href={evidence} target="_blank" rel="noreferrer">Evidence</a> : <span className="muted">No field-level evidence</span>}
    </div>
  )
}

function Citations({ urls }: { urls: string[] }) {
  if (!urls.length) return <p className="muted">No citations</p>
  return (
    <ul className="engine-citations">
      {urls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}
    </ul>
  )
}
