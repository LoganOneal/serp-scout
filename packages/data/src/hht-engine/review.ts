import { createHash, randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { publisherExternalId } from '@rnr/core'
import { getEngineDatabase, type EngineDatabase } from './db.js'
import {
  hhtEngineContactDomains,
  hhtEngineContacts,
  hhtEngineCrmEvents,
  hhtEngineCrmOutbox,
  hhtEngineDomains,
  hhtEngineDrafts,
  hhtEngineLeadReviewEvents,
  hhtEngineLeadReviews,
  hhtEngineOpportunities,
  hhtEngineOpportunityPages,
  hhtEnginePublisherResearch,
  type OutreachSequenceStep,
} from './schema.js'

export type LeadReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface EngineReviewLead {
  id: number
  externalId: string
  domain: string
  displayName: string | null
  type: string
  pipelineStatus: string
  filterStatus: string | null
  filterReasons: string[]
  contactMethod: string | null
  hasDraft: boolean
  reviewStatus: LeadReviewStatus
  approvalCurrent: boolean | null
  crmStatus: string | null
  subject: string
  body: string
  updatedAt: Date
}

export interface EngineReviewLeadDetail extends EngineReviewLead {
  opportunity: typeof hhtEngineOpportunities.$inferSelect
  publisher: typeof hhtEngineDomains.$inferSelect | null
  research: typeof hhtEnginePublisherResearch.$inferSelect | null
  draft: typeof hhtEngineDrafts.$inferSelect | null
  review: typeof hhtEngineLeadReviews.$inferSelect | null
  outbox: typeof hhtEngineCrmOutbox.$inferSelect | null
  contact: typeof hhtEngineContacts.$inferSelect | null
  pages: Array<typeof hhtEngineOpportunityPages.$inferSelect>
  events: Array<typeof hhtEngineLeadReviewEvents.$inferSelect>
  currentHash: string
}

export interface SaveLeadReviewInput {
  opportunityId: number
  subject: string
  body: string
  sequence: OutreachSequenceStep[]
  reviewer: string
  notes: string
}

export interface QueueResult {
  opportunityId: number
  queued: boolean
  reason?: string
}

type ReviewSnapshot = Record<string, unknown>

export async function listEngineReviewLeads(
  options: { status?: string; type?: string; query?: string } = {},
  db: EngineDatabase = getEngineDatabase(),
): Promise<EngineReviewLead[]> {
  const rows = await db.select({
    opportunity: hhtEngineOpportunities,
    domain: hhtEngineDomains,
    draft: hhtEngineDrafts,
    review: hhtEngineLeadReviews,
    outbox: hhtEngineCrmOutbox,
  })
    .from(hhtEngineOpportunities)
    .leftJoin(hhtEngineDomains, eq(hhtEngineDomains.rootDomain, hhtEngineOpportunities.rootDomain))
    .leftJoin(hhtEngineDrafts, eq(hhtEngineDrafts.opportunityId, hhtEngineOpportunities.id))
    .leftJoin(hhtEngineLeadReviews, eq(hhtEngineLeadReviews.opportunityId, hhtEngineOpportunities.id))
    .leftJoin(hhtEngineCrmOutbox, eq(hhtEngineCrmOutbox.opportunityExternalId, hhtEngineOpportunities.externalId))
    .orderBy(desc(hhtEngineOpportunities.discoveredAt))

  const query = options.query?.trim().toLowerCase()
  return rows
    .map((row): EngineReviewLead => {
      const reviewStatus = asReviewStatus(row.review?.status)
      return {
        id: row.opportunity.id,
        externalId: row.opportunity.externalId,
        domain: row.opportunity.rootDomain,
        displayName: row.domain?.displayName ?? null,
        type: row.opportunity.type,
        pipelineStatus: row.opportunity.status,
        filterStatus: row.opportunity.filterStatus,
        filterReasons: row.opportunity.filterReasons ?? [],
        contactMethod: row.domain?.submissionMethod ?? null,
        hasDraft: Boolean(row.draft),
        reviewStatus,
        approvalCurrent: reviewStatus === 'APPROVED' ? null : false,
        crmStatus: row.outbox?.status ?? null,
        subject: row.review?.subject ?? row.draft?.subject ?? '',
        body: row.review?.body ?? row.draft?.body ?? '',
        updatedAt: row.review?.updatedAt ?? row.draft?.createdAt ?? row.opportunity.discoveredAt,
      }
    })
    .filter((lead) => options.status === undefined || options.status === 'ALL' || lead.reviewStatus === options.status)
    .filter((lead) => options.type === undefined || options.type === 'ALL' || lead.type === options.type)
    .filter((lead) => !query || `${lead.domain} ${lead.displayName ?? ''} ${lead.subject}`.toLowerCase().includes(query))
}

export async function getEngineReviewLead(
  opportunityId: number,
  db: EngineDatabase = getEngineDatabase(),
): Promise<EngineReviewLeadDetail | null> {
  const [row] = await db.select({
    opportunity: hhtEngineOpportunities,
    domain: hhtEngineDomains,
    draft: hhtEngineDrafts,
    review: hhtEngineLeadReviews,
    outbox: hhtEngineCrmOutbox,
  })
    .from(hhtEngineOpportunities)
    .leftJoin(hhtEngineDomains, eq(hhtEngineDomains.rootDomain, hhtEngineOpportunities.rootDomain))
    .leftJoin(hhtEngineDrafts, eq(hhtEngineDrafts.opportunityId, hhtEngineOpportunities.id))
    .leftJoin(hhtEngineLeadReviews, eq(hhtEngineLeadReviews.opportunityId, hhtEngineOpportunities.id))
    .leftJoin(hhtEngineCrmOutbox, eq(hhtEngineCrmOutbox.opportunityExternalId, hhtEngineOpportunities.externalId))
    .where(eq(hhtEngineOpportunities.id, opportunityId))
  if (!row) return null

  const [research] = await db.select().from(hhtEnginePublisherResearch)
    .where(eq(hhtEnginePublisherResearch.rootDomain, row.opportunity.rootDomain))
  const pages = await db.select().from(hhtEngineOpportunityPages)
    .where(eq(hhtEngineOpportunityPages.opportunityId, opportunityId))
  const [contactLink] = await db.select().from(hhtEngineContactDomains)
    .where(eq(hhtEngineContactDomains.rootDomain, row.opportunity.rootDomain))
  const [contact] = contactLink
    ? await db.select().from(hhtEngineContacts).where(eq(hhtEngineContacts.id, contactLink.contactId))
    : []
  const events = await db.select().from(hhtEngineLeadReviewEvents)
    .where(eq(hhtEngineLeadReviewEvents.opportunityId, opportunityId))
    .orderBy(desc(hhtEngineLeadReviewEvents.createdAt))

  const subject = row.review?.subject ?? row.draft?.subject ?? ''
  const body = row.review?.body ?? row.draft?.body ?? ''
  const sequence = row.review?.sequence ?? []
  const snapshot = buildSnapshot({
    opportunity: row.opportunity,
    publisher: row.domain ?? null,
    research: research ?? null,
    draft: row.draft ?? null,
    contact: contact ?? null,
    pages,
    subject,
    body,
    sequence,
  })
  const currentHash = hashReviewSnapshot(snapshot)
  const reviewStatus = asReviewStatus(row.review?.status)

  return {
    id: row.opportunity.id,
    externalId: row.opportunity.externalId,
    domain: row.opportunity.rootDomain,
    displayName: row.domain?.displayName ?? null,
    type: row.opportunity.type,
    pipelineStatus: row.opportunity.status,
    filterStatus: row.opportunity.filterStatus,
    filterReasons: row.opportunity.filterReasons ?? [],
    contactMethod: row.domain?.submissionMethod ?? contact?.method ?? null,
    hasDraft: Boolean(row.draft),
    reviewStatus,
    approvalCurrent: reviewStatus === 'APPROVED' && row.review?.approvedHash === currentHash,
    crmStatus: row.outbox?.status ?? null,
    subject,
    body,
    updatedAt: row.review?.updatedAt ?? row.draft?.createdAt ?? row.opportunity.discoveredAt,
    opportunity: row.opportunity,
    publisher: row.domain ?? null,
    research: research ?? null,
    draft: row.draft ?? null,
    review: row.review ?? null,
    outbox: row.outbox ?? null,
    contact: contact ?? null,
    pages,
    events,
    currentHash,
  }
}

export async function saveLeadReview(
  input: SaveLeadReviewInput,
  db: EngineDatabase = getEngineDatabase(),
): Promise<void> {
  const existing = await getEngineReviewLead(input.opportunityId, db)
  if (!existing) throw new Error('Lead not found')
  const nextSnapshot = buildSnapshot({
    opportunity: existing.opportunity,
    publisher: existing.publisher,
    research: existing.research,
    draft: existing.draft,
    contact: existing.contact,
    pages: existing.pages,
    subject: input.subject,
    body: input.body,
    sequence: input.sequence,
  })
  const nextHash = hashReviewSnapshot(nextSnapshot)
  const remainsApproved = existing.review?.status === 'APPROVED' && existing.review.approvedHash === nextHash
  await db.insert(hhtEngineLeadReviews).values({
    opportunityId: input.opportunityId,
    status: remainsApproved ? 'APPROVED' : 'PENDING',
    subject: input.subject,
    body: input.body,
    sequence: input.sequence,
    reviewer: input.reviewer || null,
    notes: input.notes || null,
    approvedHash: remainsApproved ? existing.review?.approvedHash : null,
    approvedAt: remainsApproved ? existing.review?.approvedAt : null,
    rejectedAt: null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: hhtEngineLeadReviews.opportunityId,
    set: {
      status: remainsApproved ? 'APPROVED' : 'PENDING',
      subject: input.subject,
      body: input.body,
      sequence: input.sequence,
      reviewer: input.reviewer || null,
      notes: input.notes || null,
      approvedHash: remainsApproved ? existing.review?.approvedHash : null,
      approvedAt: remainsApproved ? existing.review?.approvedAt : null,
      rejectedAt: null,
      updatedAt: new Date(),
    },
  })
}

export async function approveLeadReview(
  input: SaveLeadReviewInput,
  db: EngineDatabase = getEngineDatabase(),
): Promise<void> {
  if (!input.reviewer.trim()) throw new Error('Reviewer is required')
  await saveLeadReview(input, db)
  const lead = await getEngineReviewLead(input.opportunityId, db)
  if (!lead) throw new Error('Lead not found')
  if (!lead.subject.trim() || !lead.body.trim()) throw new Error('Subject and body are required before approval')
  const now = new Date()
  await db.update(hhtEngineLeadReviews).set({
    status: 'APPROVED',
    reviewer: input.reviewer.trim(),
    notes: input.notes || null,
    approvedHash: lead.currentHash,
    approvedAt: now,
    rejectedAt: null,
    updatedAt: now,
  }).where(eq(hhtEngineLeadReviews.opportunityId, input.opportunityId))
  const [review] = await db.select().from(hhtEngineLeadReviews)
    .where(eq(hhtEngineLeadReviews.opportunityId, input.opportunityId))
  if (!review) throw new Error('Review was not saved')
  await db.insert(hhtEngineLeadReviewEvents).values({
    opportunityId: input.opportunityId,
    reviewId: review.id,
    decision: 'APPROVED',
    reviewer: input.reviewer.trim(),
    notes: input.notes || null,
    contentHash: lead.currentHash,
    snapshot: await buildApprovedCrmPayload(input.opportunityId, db),
  })
}

export async function rejectLeadReview(
  input: SaveLeadReviewInput,
  db: EngineDatabase = getEngineDatabase(),
): Promise<void> {
  if (!input.reviewer.trim()) throw new Error('Reviewer is required')
  await saveLeadReview(input, db)
  const lead = await getEngineReviewLead(input.opportunityId, db)
  if (!lead) throw new Error('Lead not found')
  const [review] = await db.update(hhtEngineLeadReviews).set({
    status: 'REJECTED',
    reviewer: input.reviewer.trim(),
    notes: input.notes || null,
    approvedHash: null,
    approvedAt: null,
    rejectedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(hhtEngineLeadReviews.opportunityId, input.opportunityId)).returning()
  if (!review) throw new Error('Review was not saved')
  await db.insert(hhtEngineLeadReviewEvents).values({
    opportunityId: input.opportunityId,
    reviewId: review.id,
    decision: 'REJECTED',
    reviewer: input.reviewer.trim(),
    notes: input.notes || null,
    contentHash: lead.currentHash,
    snapshot: await buildApprovedCrmPayload(input.opportunityId, db),
  })
}

export async function queueApprovedOpportunityForCrm(
  opportunityId: number,
  db: EngineDatabase = getEngineDatabase(),
): Promise<QueueResult> {
  const lead = await getEngineReviewLead(opportunityId, db)
  if (!lead) return { opportunityId, queued: false, reason: 'Lead not found' }
  if (lead.reviewStatus !== 'APPROVED') {
    return { opportunityId, queued: false, reason: 'Lead is not approved' }
  }
  if (!lead.approvalCurrent || !lead.review?.approvedHash) {
    return { opportunityId, queued: false, reason: 'Lead changed after approval' }
  }
  const payload = await buildApprovedCrmPayload(opportunityId, db)
  const payloadReview = payload['review'] as Record<string, unknown> | undefined
  if (payloadReview?.['contentHash'] !== lead.review.approvedHash) {
    return { opportunityId, queued: false, reason: 'Lead changed while it was being queued' }
  }
  const now = new Date()
  await db.insert(hhtEngineCrmOutbox).values({
    publisherExternalId: lead.opportunity.publisherExternalId ?? publisherExternalId(lead.domain),
    opportunityExternalId: lead.externalId,
    payload,
    status: 'QUEUED',
    approvedReviewId: lead.review.id,
    contentHash: lead.review.approvedHash,
    queuedAt: now,
    updatedAt: now,
    syncedAt: null,
  }).onConflictDoUpdate({
    target: hhtEngineCrmOutbox.opportunityExternalId,
    set: {
      publisherExternalId: lead.opportunity.publisherExternalId ?? publisherExternalId(lead.domain),
      payload,
      status: 'QUEUED',
      approvedReviewId: lead.review.id,
      contentHash: lead.review.approvedHash,
      queuedAt: now,
      updatedAt: now,
      syncedAt: null,
    },
  })
  await db.insert(hhtEngineCrmEvents).values({
    opportunityId,
    requestId: randomUUID(),
    result: 'queued_after_approval',
    detail: lead.review.approvedHash,
  })
  return { opportunityId, queued: true }
}

export async function queueApprovedOpportunitiesForCrm(
  opportunityIds: number[],
  db: EngineDatabase = getEngineDatabase(),
): Promise<QueueResult[]> {
  const uniqueIds = [...new Set(opportunityIds)]
  return Promise.all(uniqueIds.map((id) => queueApprovedOpportunityForCrm(id, db)))
}

export async function buildApprovedCrmPayload(
  opportunityId: number,
  db: EngineDatabase = getEngineDatabase(),
): Promise<Record<string, unknown>> {
  const lead = await getEngineReviewLead(opportunityId, db)
  if (!lead) throw new Error('Lead not found')
  const sequence = lead.review?.sequence ?? []
  const snapshot = buildSnapshot({
    opportunity: lead.opportunity,
    publisher: lead.publisher,
    research: lead.research,
    draft: lead.draft,
    contact: lead.contact,
    pages: lead.pages,
    subject: lead.subject,
    body: lead.body,
    sequence,
  })
  return {
    ...snapshot,
    review: {
      reviewId: lead.review?.id ?? null,
      status: lead.reviewStatus,
      reviewer: lead.review?.reviewer ?? null,
      notes: lead.review?.notes ?? null,
      approvedAt: lead.review?.approvedAt?.toISOString() ?? null,
      contentHash: hashReviewSnapshot(snapshot),
    },
  }
}

export function hashReviewSnapshot(snapshot: ReviewSnapshot): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex')
}

function buildSnapshot(input: {
  opportunity: typeof hhtEngineOpportunities.$inferSelect
  publisher: typeof hhtEngineDomains.$inferSelect | null
  research: typeof hhtEnginePublisherResearch.$inferSelect | null
  draft: typeof hhtEngineDrafts.$inferSelect | null
  contact: typeof hhtEngineContacts.$inferSelect | null
  pages: Array<typeof hhtEngineOpportunityPages.$inferSelect>
  subject: string
  body: string
  sequence: OutreachSequenceStep[]
}): ReviewSnapshot {
  const { opportunity, publisher, research, draft, contact, pages } = input
  return {
    publisherExternalId: opportunity.publisherExternalId ?? publisherExternalId(opportunity.rootDomain),
    opportunityExternalId: opportunity.externalId,
    publisher: {
      domain: opportunity.rootDomain,
      displayName: publisher?.displayName ?? null,
      siteType: publisher?.siteType ?? 'unknown',
      primaryTopic: publisher?.primaryTopic ?? null,
      semrushAuthorityScore: publisher?.semrushAuthorityScore ?? null,
    },
    opportunity: {
      type: opportunity.type,
      status: opportunity.status,
      primary: opportunity.primaryThread,
      sourceKeyword: opportunity.sourceKeyword,
      bestKeyword: opportunity.bestKeyword,
      bestPosition: opportunity.bestPosition,
      insertionSuggestion: opportunity.insertionSuggestion,
    },
    pages: pages.map((page) => ({
      url: page.canonicalUrl,
      title: page.title,
      position: page.bestPosition,
      keyword: page.keyword,
    })),
    hht: {
      targetHhtUrl: opportunity.targetHhtUrl,
      secondaryHhtUrl: opportunity.secondaryHhtUrl,
      matchRule: opportunity.matchRule,
      matchConfidence: opportunity.matchConfidence,
      weakTargetMatch: opportunity.weakTargetMatch,
    },
    filters: { status: opportunity.filterStatus, reasons: opportunity.filterReasons ?? [] },
    guestPost: research ? {
      status: research.guestPostStatus,
      evidenceUrl: research.evidenceUrl,
      requirements: research.requirements,
      guidelines: {
        submissionMethod: publisher?.submissionMethod ?? null,
        submissionUrl: publisher?.submissionUrl ?? null,
        pitchFormat: {
          topicIdeasRequired: publisher?.pitchTopicCount ?? null,
          contentStage: publisher?.pitchContentStage ?? null,
          requiredSubjectLineFormat: publisher?.requiredSubjectLineFormat ?? null,
        },
        acceptedTopics: publisher?.acceptedTopics ?? [],
        excludedTopics: publisher?.excludedTopics ?? [],
        wordCount: publisher?.wordCount ?? null,
        linkPolicy: publisher?.linkPolicy ?? null,
        samplesRequired: publisher?.samplesRequired ?? false,
        bioRequired: publisher?.bioRequired ?? false,
        aiContentPolicy: publisher?.aiContentPolicy ?? null,
        aiContentProhibited: publisher?.aiContentProhibited ?? false,
        paidOrSponsored: publisher?.paidOrSponsored ?? false,
        evidence: publisher?.guidelineEvidence ?? {},
      },
      personalization: opportunity.type === 'guest_post' ? {
        pitchTopics: opportunity.guestPostPitchTopics ?? [],
        fitLine: opportunity.guestPostFitLine,
        fitLineCitations: opportunity.guestPostFitLineCitations ?? [],
        subjectLine: opportunity.guestPostSubjectLine,
        subjectLineCitations: opportunity.guestPostSubjectLineCitations ?? [],
      } : null,
    } : null,
    contact: contact ? {
      method: publisher?.submissionMethod ?? contact.method,
      name: contact.name,
      role: contact.role,
      email: contact.email,
      formUrl: publisher?.submissionUrl ?? contact.formUrl,
      validationStatus: contact.validationStatus,
      source: contact.source,
    } : null,
    outreach: {
      subject: input.subject,
      body: input.body,
      sequence: input.sequence,
      templateId: draft?.templateId ?? null,
    },
    provenance: {
      discoveredAt: opportunity.discoveredAt.toISOString(),
      sourceKeyword: opportunity.sourceKeyword,
    },
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function asReviewStatus(value: string | null | undefined): LeadReviewStatus {
  return value === 'APPROVED' || value === 'REJECTED' ? value : 'PENDING'
}
