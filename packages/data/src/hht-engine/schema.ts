import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { withTimezone: true })
export const hhtEngineSchema = pgSchema('hht_engine')
const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(384)'
  },
  toDriver(value) {
    return `[${value.join(',')}]`
  },
  fromDriver(value) {
    return value.slice(1, -1).split(',').map(Number)
  },
})

export const hhtEngineKeywords = hhtEngineSchema.table('keywords', {
  id: serial('id').primaryKey(),
  keyword: text('keyword').notNull(),
  normalizedKeyword: text('normalized_keyword').notNull(),
  sourceType: text('source_type').notNull(),
  sourceKeywordId: integer('source_keyword_id'),
  sourceDomain: text('source_domain'),
  sourceUrl: text('source_url'),
  semanticCluster: text('semantic_cluster'),
  geoCity: text('geo_city'),
  geoState: text('geo_state'),
  intentType: text('intent_type'),
  avgMonthlySearches: integer('avg_monthly_searches'),
  volumeLow: integer('volume_low'),
  volumeHigh: integer('volume_high'),
  volumeIsRange: boolean('volume_is_range').notNull().default(false),
  volumeSource: text('volume_source'),
  keywordDifficulty: doublePrecision('keyword_difficulty'),
  relevanceScore: doublePrecision('relevance_score'),
  relevanceMethod: text('relevance_method'),
  priorityScore: doublePrecision('priority_score').notNull().default(0),
  expansionDepth: integer('expansion_depth').notNull().default(0),
  maxSerpPositionScanned: integer('max_serp_position_scanned').notNull().default(0),
  uniqueDomainsSeen: integer('unique_domains_seen').notNull().default(0),
  newDomainsDiscovered: integer('new_domains_discovered').notNull().default(0),
  guestPostDomains: integer('guest_post_domains').notNull().default(0),
  insertionCandidates: integer('insertion_candidates').notNull().default(0),
  marginalDomainYield: doublePrecision('marginal_domain_yield'),
  marginalOpportunityYield: doublePrecision('marginal_opportunity_yield'),
  consecutiveLowYieldBands: integer('consecutive_low_yield_bands').notNull().default(0),
  lastSerpScanAt: ts('last_serp_scan_at'),
  serpOverlap: doublePrecision('serp_overlap'),
  neighborhood: text('neighborhood'),
  status: text('status').notNull().default('NEW'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hht_engine_keywords_normalized_idx').on(table.normalizedKeyword),
  index('hht_engine_keywords_status_priority_idx').on(table.status, table.priorityScore),
])

export const hhtEngineHhtPages = hhtEngineSchema.table('hht_pages', {
  id: serial('id').primaryKey(),
  url: text('url').notNull(),
  pageType: text('page_type').notNull(),
  city: text('city'),
  state: text('state'),
  collection: text('collection'),
  verifiedStayCount: integer('verified_stay_count').notNull().default(0),
  title: text('title'),
  lastSyncedAt: ts('last_synced_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('hht_engine_hht_pages_url_idx').on(table.url)])

export const hhtEngineSerpScans = hhtEngineSchema.table('serp_scans', {
  id: serial('id').primaryKey(),
  keywordId: integer('keyword_id').notNull(),
  band: integer('band').notNull(),
  displayOffset: integer('display_offset').notNull(),
  displayLimit: integer('display_limit').notNull(),
  unitsSpent: integer('units_spent'),
  newQualifiedDomains: integer('new_qualified_domains').notNull().default(0),
  observedAt: ts('observed_at').notNull().defaultNow(),
})

export const hhtEngineSerpResults = hhtEngineSchema.table('serp_results', {
  id: serial('id').primaryKey(),
  keywordId: integer('keyword_id').notNull(),
  scanId: integer('scan_id').notNull(),
  url: text('url').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  rootDomain: text('root_domain').notNull(),
  position: integer('position').notNull(),
  band: integer('band').notNull(),
  observedAt: ts('observed_at').notNull().defaultNow(),
})

export const hhtEngineDomains = hhtEngineSchema.table('domains', {
  id: serial('id').primaryKey(),
  rootDomain: text('root_domain').notNull(),
  displayName: text('display_name'),
  siteType: text('site_type').notNull().default('unknown'),
  primaryTopic: text('primary_topic'),
  semrushAuthorityScore: integer('semrush_authority_score'),
  guestPostStatus: text('guest_post_status'),
  guestPostConfidence: doublePrecision('guest_post_confidence'),
  guestPostEvidenceUrl: text('guest_post_evidence_url'),
  guestPostRequirements: text('guest_post_requirements'),
  submissionMethod: text('submission_method'),
  submissionUrl: text('submission_url'),
  pitchTopicCount: integer('pitch_topic_count'),
  pitchContentStage: text('pitch_content_stage'),
  requiredSubjectLineFormat: text('required_subject_line_format'),
  acceptedTopics: jsonb('accepted_topics').$type<string[]>(),
  excludedTopics: jsonb('excluded_topics').$type<string[]>(),
  wordCount: text('word_count'),
  linkPolicy: text('link_policy'),
  samplesRequired: boolean('samples_required').notNull().default(false),
  bioRequired: boolean('bio_required').notNull().default(false),
  aiContentPolicy: text('ai_content_policy'),
  aiContentProhibited: boolean('ai_content_prohibited').notNull().default(false),
  paidOrSponsored: boolean('paid_or_sponsored').notNull().default(false),
  guidelineEvidence: jsonb('guideline_evidence').$type<Record<string, string>>(),
  sellsPlacements: boolean('sells_placements').notNull().default(false),
  filterStatus: text('filter_status'),
  filterReasons: jsonb('filter_reasons').$type<string[]>(),
  contactStatus: text('contact_status'),
  blocked: boolean('blocked').notNull().default(false),
  manualNotes: text('manual_notes'),
  firstDiscoveredAt: ts('first_discovered_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('hht_engine_domains_root_idx').on(table.rootDomain)])

export const hhtEngineOpportunities = hhtEngineSchema.table('opportunities', {
  id: serial('id').primaryKey(),
  canonicalKey: text('canonical_key').notNull(),
  externalId: text('external_id').notNull(),
  rootDomain: text('root_domain').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  targetHhtUrl: text('target_hht_url'),
  secondaryHhtUrl: text('secondary_hht_url'),
  matchRule: text('match_rule'),
  matchConfidence: doublePrecision('match_confidence'),
  weakTargetMatch: boolean('weak_target_match').notNull().default(false),
  noHhtCityPage: boolean('no_hht_city_page').notNull().default(false),
  sourceKeyword: text('source_keyword'),
  discoveredAt: ts('discovered_at').notNull().defaultNow(),
  filterStatus: text('filter_status'),
  filterReasons: jsonb('filter_reasons').$type<string[]>(),
  bestKeyword: text('best_keyword'),
  bestPosition: integer('best_position'),
  insertionSuggestion: text('insertion_suggestion'),
  guestPostPitchTopics: jsonb('guest_post_pitch_topics').$type<Array<{
    title: string
    targetHhtUrl: string
    citations: string[]
  }>>(),
  guestPostFitLine: text('guest_post_fit_line'),
  guestPostFitLineCitations: jsonb('guest_post_fit_line_citations').$type<string[]>(),
  guestPostSubjectLine: text('guest_post_subject_line'),
  guestPostSubjectLineCitations: jsonb('guest_post_subject_line_citations').$type<string[]>(),
  primaryThread: boolean('primary_thread').notNull().default(false),
  publisherExternalId: text('publisher_external_id'),
}, (table) => [uniqueIndex('hht_engine_opportunities_key_idx').on(table.canonicalKey)])

export const hhtEngineJobs = hhtEngineSchema.table('jobs', {
  id: serial('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  idempotencyKey: text('idempotency_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAfter: ts('run_after').notNull().defaultNow(),
  heartbeatAt: ts('heartbeat_at'),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hht_engine_jobs_idempotency_idx').on(table.idempotencyKey),
  index('hht_engine_jobs_status_idx').on(table.status, table.runAfter),
])

export const hhtEngineSystemState = hhtEngineSchema.table('system_state', {
  id: integer('id').primaryKey(),
  semrushState: text('semrush_state').notNull().default('RUNNING'),
  gadsState: text('gads_state').notNull().default('GADS_RUNNING'),
  semrushPausedAt: ts('semrush_paused_at'),
  gadsPausedAt: ts('gads_paused_at'),
  unitsUsed: integer('units_used').notNull().default(0),
  semrushRemainingUnits: integer('semrush_remaining_units'),
  semrushAccountMarker: text('semrush_account_marker'),
  consecutiveFailedRuns: integer('consecutive_failed_runs').notNull().default(0),
  consecutiveTimedOutRuns: integer('consecutive_timed_out_runs').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const hhtEngineNotifications = hhtEngineSchema.table('notifications', {
  id: serial('id').primaryKey(),
  channel: text('channel').notNull(),
  eventType: text('event_type'),
  subject: text('subject'),
  payload: text('payload').notNull(),
  deliveryResult: text('delivery_result'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
})

export const hhtEngineSemrushUsage = hhtEngineSchema.table('semrush_usage', {
  id: serial('id').primaryKey(),
  report: text('report').notNull(),
  units: integer('units'),
  remainingUnits: integer('remaining_units'),
  jobId: integer('job_id'),
  accountMarker: text('account_marker'),
  createdAt: ts('created_at').notNull().defaultNow(),
})

export const hhtEnginePublisherPages = hhtEngineSchema.table('publisher_pages', {
  id: serial('id').primaryKey(),
  canonicalUrl: text('canonical_url').notNull(),
  rootDomain: text('root_domain').notNull(),
  title: text('title'),
  pageType: text('page_type'),
  linksToHht: boolean('links_to_hht'),
  linksToHhtCheckedAt: ts('links_to_hht_checked_at'),
}, (table) => [uniqueIndex('hht_engine_publisher_pages_url_idx').on(table.canonicalUrl)])

export const hhtEnginePageRankings = hhtEngineSchema.table('page_rankings', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull(),
  keywordId: integer('keyword_id').notNull(),
  keyword: text('keyword').notNull(),
  position: integer('position').notNull(),
  observedAt: ts('observed_at').notNull().defaultNow(),
})

export const hhtEnginePublisherResearch = hhtEngineSchema.table('publisher_research', {
  id: serial('id').primaryKey(),
  rootDomain: text('root_domain').notNull(),
  guestPostStatus: text('guest_post_status'),
  evidenceUrl: text('evidence_url'),
  requirements: text('requirements'),
  sellsPlacements: boolean('sells_placements').notNull().default(false),
  checkedAt: ts('checked_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('hht_engine_publisher_research_domain_idx').on(table.rootDomain)])

export const hhtEngineOpportunityPages = hhtEngineSchema.table('opportunity_pages', {
  id: serial('id').primaryKey(),
  opportunityId: integer('opportunity_id').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  title: text('title'),
  bestPosition: integer('best_position').notNull(),
  keyword: text('keyword'),
}, (table) => [uniqueIndex('hht_engine_opportunity_pages_idx').on(table.opportunityId, table.canonicalUrl)])

export const hhtEngineContacts = hhtEngineSchema.table('contacts', {
  id: serial('id').primaryKey(),
  emailNormalized: text('email_normalized'),
  name: text('name'),
  role: text('role'),
  email: text('email'),
  formUrl: text('form_url'),
  method: text('method'),
  source: text('source'),
  validationStatus: text('validation_status').notNull().default('UNVERIFIED'),
  blocked: boolean('blocked').notNull().default(false),
  validatedAt: ts('validated_at'),
  lastContactedAt: ts('last_contacted_at'),
}, (table) => [uniqueIndex('hht_engine_contacts_email_idx').on(table.emailNormalized)])

export const hhtEngineContactDomains = hhtEngineSchema.table('contact_domains', {
  id: serial('id').primaryKey(),
  contactId: integer('contact_id').notNull(),
  rootDomain: text('root_domain').notNull(),
}, (table) => [uniqueIndex('hht_engine_contact_domains_idx').on(table.contactId, table.rootDomain)])

export const hhtEngineDrafts = hhtEngineSchema.table('drafts', {
  id: serial('id').primaryKey(),
  opportunityId: integer('opportunity_id').notNull(),
  templateId: text('template_id').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('hht_engine_drafts_opportunity_idx').on(table.opportunityId)])

export const hhtEngineResponses = hhtEngineSchema.table('responses', {
  id: serial('id').primaryKey(),
  opportunityId: integer('opportunity_id').notNull(),
  state: text('state').notNull(),
  price: doublePrecision('price'),
  currency: text('currency'),
  linkAttributes: text('link_attributes'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
})

export const hhtEngineCrmEvents = hhtEngineSchema.table('crm_events', {
  id: serial('id').primaryKey(),
  opportunityId: integer('opportunity_id'),
  requestId: text('request_id').notNull(),
  result: text('result').notNull(),
  detail: text('detail'),
  createdAt: ts('created_at').notNull().defaultNow(),
})

export const hhtEngineKeywordRelationships = hhtEngineSchema.table('keyword_relationships', {
  id: serial('id').primaryKey(),
  keywordId: integer('keyword_id').notNull(),
  sourceKeywordId: integer('source_keyword_id'),
  relation: text('relation').notNull(),
})

export const hhtEngineCrmOutbox = hhtEngineSchema.table('crm_outbox', {
  id: serial('id').primaryKey(),
  publisherExternalId: text('publisher_external_id').notNull(),
  opportunityExternalId: text('opportunity_external_id').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('PENDING_APPROVAL'),
  approvedReviewId: integer('approved_review_id'),
  contentHash: text('content_hash'),
  queuedAt: ts('queued_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  syncedAt: ts('synced_at'),
}, (table) => [
  uniqueIndex('hht_engine_crm_outbox_opportunity_idx').on(table.opportunityExternalId),
])

export interface OutreachSequenceStep {
  position: number
  delayDays: number
  subject: string
  body: string
}

export const hhtEngineLeadReviews = hhtEngineSchema.table('lead_reviews', {
  id: serial('id').primaryKey(),
  opportunityId: integer('opportunity_id').notNull(),
  status: text('status').notNull().default('PENDING'),
  subject: text('subject'),
  body: text('body'),
  sequence: jsonb('sequence').$type<OutreachSequenceStep[]>().notNull(),
  reviewer: text('reviewer'),
  notes: text('notes'),
  approvedHash: text('approved_hash'),
  approvedAt: ts('approved_at'),
  rejectedAt: ts('rejected_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hht_engine_lead_reviews_opportunity_idx').on(table.opportunityId),
  index('hht_engine_lead_reviews_status_idx').on(table.status),
])

export const hhtEngineLeadReviewEvents = hhtEngineSchema.table('lead_review_events', {
  id: serial('id').primaryKey(),
  opportunityId: integer('opportunity_id').notNull(),
  reviewId: integer('review_id').notNull(),
  decision: text('decision').notNull(),
  reviewer: text('reviewer'),
  notes: text('notes'),
  contentHash: text('content_hash'),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (table) => [
  index('hht_engine_lead_review_events_opportunity_idx').on(table.opportunityId, table.createdAt),
])

export const hhtEngineLlmTasks = hhtEngineSchema.table('llm_tasks', {
  id: serial('id').primaryKey(),
  taskType: text('task_type').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  outputSchema: jsonb('output_schema').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('PENDING'),
  answer: jsonb('answer').$type<Record<string, unknown>>(),
  parkedJobId: integer('parked_job_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hht_engine_llm_tasks_entity_idx').on(table.taskType, table.entityType, table.entityId),
  index('hht_engine_llm_tasks_status_idx').on(table.status),
])

export const hhtEngineRunLocks = hhtEngineSchema.table('run_locks', {
  name: text('name').primaryKey(),
  owner: text('owner').notNull(),
  acquiredAt: ts('acquired_at').notNull().defaultNow(),
  heartbeatAt: ts('heartbeat_at').notNull().defaultNow(),
})

export const hhtEngineRuns = hhtEngineSchema.table('runs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  jobsCompleted: integer('jobs_completed').notNull().default(0),
  semrushUnits: integer('semrush_units').notNull().default(0),
  googleAdsCalls: integer('google_ads_calls').notNull().default(0),
  outboxRows: integer('outbox_rows').notNull().default(0),
  error: text('error'),
})

export const hhtEngineEmbeddings = hhtEngineSchema.table('embeddings', {
  id: serial('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityKey: text('entity_key').notNull(),
  model: text('model').notNull(),
  embedding: vector384('embedding').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hht_engine_embeddings_entity_idx').on(table.entityType, table.entityKey, table.model),
])

export const hhtEngineFrontierLog = hhtEngineSchema.table('frontier_log', {
  id: serial('id').primaryKey(),
  eventType: text('event_type').notNull(),
  keywordId: integer('keyword_id'),
  url: text('url'),
  rootDomain: text('root_domain'),
  stage: text('stage'),
  quality: text('quality'),
  lane: text('lane'),
  affiliate: boolean('affiliate'),
  score: doublePrecision('score'),
  reasons: jsonb('reasons').$type<string[]>(),
  pitchableDomains: integer('pitchable_domains'),
  overlap: doublePrecision('overlap'),
  neighborhood: text('neighborhood'),
  candidatesAdded: integer('candidates_added'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (table) => [
  index('hht_engine_frontier_log_event_idx').on(table.eventType, table.createdAt),
])

export const hhtEngineGoogleAdsUsage = hhtEngineSchema.table('google_ads_usage', {
  id: serial('id').primaryKey(),
  operation: text('operation').notNull(),
  jobId: integer('job_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
})
