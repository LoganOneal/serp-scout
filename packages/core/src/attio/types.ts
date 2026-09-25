/**
 * Hotel Hot Tubs outreach CRM vocabulary.
 *
 * GitHub/source repos own target facts. Attio owns outreach state.
 * Sync must never invent contacts, never regress status, and never
 * overwrite a populated CRM field with a blank source value.
 */

export const ATTIO_WORKSTREAMS = ['editors-choice', 'backlinks', 'guest-posts'] as const
export type AttioWorkstream = (typeof ATTIO_WORKSTREAMS)[number]

export const ATTIO_STATUSES = [
  'New',
  'Researching',
  'Contact Found',
  'Ready to Contact',
  'Contacted',
  'Replied',
  'Positive',
  'Won / Published',
  'No Response',
  'Rejected',
] as const
export type AttioStatus = (typeof ATTIO_STATUSES)[number]

/** Statuses that mean outreach has started. Sync must not reset these to New. */
export const ATTIO_OUTREACH_STARTED: ReadonlySet<AttioStatus> = new Set([
  'Contacted',
  'Replied',
  'Positive',
  'Won / Published',
  'No Response',
  'Rejected',
])

/** Statuses that mean a follow-up should not be created. */
export const ATTIO_FOLLOWUP_BLOCKED: ReadonlySet<AttioStatus> = new Set([
  'Replied',
  'Positive',
  'Won / Published',
  'No Response',
  'Rejected',
])

export const ATTIO_ASK_TYPES = ['Verification', 'Photos', 'Backlink / Badge', 'Mixed'] as const
export type AttioAskType = (typeof ATTIO_ASK_TYPES)[number]

/** Which Editor's Choice email track this lead is on. Set from the first-touch body. */
export const ATTIO_SEQUENCES = ['New contact', 'Asked backlink', 'Fact-check'] as const
export type AttioSequence = (typeof ATTIO_SEQUENCES)[number]

export const ATTIO_PLACEMENT_TYPES = [
  'Link insertion',
  'New article',
  'Paid',
  'Free / editorial',
  'Unknown',
] as const
export type AttioPlacementType = (typeof ATTIO_PLACEMENT_TYPES)[number]

export interface AttioContact {
  email: string
  name?: string | null
  jobTitle?: string | null
}

export interface AttioSourceTarget {
  workstream: AttioWorkstream
  sourceKey: string
  sourceRef: string
  companyName: string
  /** Canonical hostname used as the Attio Company domain. Null when unknown. */
  domain: string | null
  companyWebsiteUrl?: string | null
  contact?: AttioContact | null
  noteTitle?: string | null
  noteBody?: string | null
  sourceOwned: Record<string, unknown>
}

export type FieldOwner = 'source' | 'crm'

export const CRM_OWNED_FIELDS = [
  'status',
  'primary_contact',
  'sequence',
  'contact_1_date',
  'contact_2_date',
  'contact_3_date',
  'contact_4_date',
  'replied_at',
  'outreach_date',
  'next_follow_up',
  'outcome_notes',
  'suppress_outreach',
  'price_quoted',
  'live_link_coverage_url',
  'live_backlink_url',
  'published_url',
] as const

export type CrmOwnedField = (typeof CRM_OWNED_FIELDS)[number]

export interface FollowupCadence {
  firstDays: number
  secondDays: number
}

export const DEFAULT_FOLLOWUP_CADENCE: FollowupCadence = {
  firstDays: 6,
  secondDays: 7,
}

export const ATTIO_LISTS = {
  'editors-choice': {
    name: "Editor's Choice Targets",
    slug: 'editors_choice_targets',
  },
  backlinks: {
    name: 'Backlink Targets',
    slug: 'backlink_targets',
  },
  'guest-posts': {
    name: 'Guest Post Targets',
    slug: 'guest_post_targets',
  },
} as const

export const LEGACY_ATTIO_LIST_SLUGS = ['press_outreach', 'content_co_creation', 'content_co_creation_3'] as const
