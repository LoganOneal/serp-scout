import {
  ATTIO_ASK_TYPES,
  ATTIO_LISTS,
  ATTIO_PLACEMENT_TYPES,
  ATTIO_SEQUENCES,
  ATTIO_STATUSES,
  type AttioWorkstream,
} from './types.js'

export type AttioAttributeType =
  | 'text'
  | 'checkbox'
  | 'currency'
  | 'date'
  | 'number'
  | 'status'
  | 'select'
  | 'record-reference'

export interface AttioAttributeSpec {
  title: string
  apiSlug: string
  type: AttioAttributeType
  description: string
  isUnique?: boolean
  isMultiselect?: boolean
  options?: readonly string[]
  statuses?: readonly string[]
  allowedObjects?: readonly string[]
  currencyCode?: 'USD'
}

export interface AttioListSpec {
  workstream: AttioWorkstream
  name: string
  slug: string
  parentObject: 'companies'
  attributes: readonly AttioAttributeSpec[]
}

const SHARED: AttioAttributeSpec[] = [
  {
    title: 'Status',
    apiSlug: 'status',
    type: 'status',
    description: 'Outreach workflow status. Attio is authoritative; GitHub sync never regresses it.',
    statuses: ATTIO_STATUSES,
  },
  {
    title: 'Primary Contact',
    apiSlug: 'primary_contact',
    type: 'record-reference',
    description: 'Person who should receive outreach. Discovered contacts live here, not as a duplicate email column.',
    allowedObjects: ['people'],
  },
  {
    title: '1st Contact',
    apiSlug: 'contact_1_date',
    type: 'date',
    description: 'Date of the first outbound email to this lead. CRM-owned.',
  },
  {
    title: '2nd Contact',
    apiSlug: 'contact_2_date',
    type: 'date',
    description: 'Date of the second outbound email (first follow-up). CRM-owned.',
  },
  {
    title: '3rd Contact',
    apiSlug: 'contact_3_date',
    type: 'date',
    description: 'Date of the third outbound email (second follow-up). CRM-owned.',
  },
  {
    title: '4th Contact',
    apiSlug: 'contact_4_date',
    type: 'date',
    description: 'Date of the fourth outbound email (third follow-up). CRM-owned.',
  },
  {
    title: 'Replied At',
    apiSlug: 'replied_at',
    type: 'date',
    description: 'Date the lead first replied. CRM-owned.',
  },
  {
    title: 'Sequence',
    apiSlug: 'sequence',
    type: 'select',
    description: 'Email track: new contact, or a follow-up track based on whether the first email asked for a backlink. CRM-owned.',
    options: ATTIO_SEQUENCES,
  },
  {
    title: 'Outreach Date',
    apiSlug: 'outreach_date',
    type: 'date',
    description: 'Date the first outreach email was sent. Mirrors 1st Contact when blank. CRM-owned.',
  },
  {
    title: 'Next Follow-up',
    apiSlug: 'next_follow_up',
    type: 'date',
    description: 'Date the next follow-up is due. CRM-owned.',
  },
  {
    title: 'Outcome / Notes',
    apiSlug: 'outcome_notes',
    type: 'text',
    description: 'Human/agent notes about the conversation. CRM-owned.',
  },
  {
    title: 'Suppress Outreach',
    apiSlug: 'suppress_outreach',
    type: 'checkbox',
    description: 'Do not email this lead. CRM-owned. Used for explicit exclusions.',
  },
  {
    title: '_Source Key',
    apiSlug: 'source_key',
    type: 'text',
    description: 'Stable deterministic identifier for this opportunity. Used for idempotent sync.',
    isUnique: true,
  },
  {
    title: '_Source Ref',
    apiSlug: 'source_ref',
    type: 'text',
    description: 'Human-debuggable source location in GitHub, never an absolute filesystem path.',
  },
]

export const ATTIO_LIST_SPECS: Record<AttioWorkstream, AttioListSpec> = {
  'editors-choice': {
    workstream: 'editors-choice',
    name: ATTIO_LISTS['editors-choice'].name,
    slug: ATTIO_LISTS['editors-choice'].slug,
    parentObject: 'companies',
    attributes: [
      ...SHARED,
      { title: 'Hotel Website', apiSlug: 'hotel_website', type: 'text', description: 'Official hotel website when known. Not an OTA listing.' },
      { title: 'HHT Listing URL', apiSlug: 'hht_listing_url', type: 'text', description: 'Hotel Hot Tubs listing URL for this stay.' },
      { title: 'Press / Media Page', apiSlug: 'press_media_page', type: 'text', description: 'Hotel press, media, or newsroom page when known.' },
      {
        title: 'Ask Type',
        apiSlug: 'ask_type',
        type: 'select',
        description: 'What we are asking the hotel to do.',
        options: ATTIO_ASK_TYPES,
      },
      { title: 'Live Link / Coverage URL', apiSlug: 'live_link_coverage_url', type: 'text', description: 'Published coverage or live badge URL. CRM-owned.' },
    ],
  },
  backlinks: {
    workstream: 'backlinks',
    name: ATTIO_LISTS.backlinks.name,
    slug: ATTIO_LISTS.backlinks.slug,
    parentObject: 'companies',
    attributes: [
      ...SHARED,
      { title: 'Target Article URL', apiSlug: 'target_article_url', type: 'text', description: 'Canonical URL of the ranking article we want to be cited on.' },
      { title: 'Article Title', apiSlug: 'article_title', type: 'text', description: 'Title of the target article when known.' },
      { title: 'HHT Page to Link', apiSlug: 'hht_page_to_link', type: 'text', description: 'Hotel Hot Tubs URL that would make the citation editorially useful.' },
      { title: 'SERP Keyword', apiSlug: 'serp_keyword', type: 'text', description: 'Highest-volume keyword this page ranks for in HHT prospecting.' },
      { title: 'SERP Position', apiSlug: 'serp_position', type: 'number', description: 'Best Google position for that keyword.' },
      { title: 'Keyword Volume', apiSlug: 'keyword_volume', type: 'number', description: 'National monthly search volume for that keyword.' },
      { title: 'Authority', apiSlug: 'authority_score', type: 'number', description: 'Semrush authority score for the domain. Not Moz DA.' },
      { title: 'Referring Domains', apiSlug: 'referring_domains', type: 'number', description: 'Referring domains to the site, when measured.' },
      { title: 'Outbound Links', apiSlug: 'outbound_links', type: 'number', description: 'External links on the crawled landing page. Null when that page was not crawled.' },
      { title: 'Why Link', apiSlug: 'why_link', type: 'text', description: 'Why a Hotel Hot Tubs citation would be editorially useful.' },
      {
        title: 'Placement Type',
        apiSlug: 'placement_type',
        type: 'select',
        description: 'How the link would be placed.',
        options: ATTIO_PLACEMENT_TYPES,
      },
      {
        title: 'Price Quoted',
        apiSlug: 'price_quoted',
        type: 'currency',
        description: 'Quoted or negotiated placement price in USD. CRM-owned once populated.',
        currencyCode: 'USD',
      },
      { title: 'Live Backlink URL', apiSlug: 'live_backlink_url', type: 'text', description: 'URL of the live citation. CRM-owned.' },
    ],
  },
  'guest-posts': {
    workstream: 'guest-posts',
    name: ATTIO_LISTS['guest-posts'].name,
    slug: ATTIO_LISTS['guest-posts'].slug,
    parentObject: 'companies',
    attributes: [
      ...SHARED,
      { title: 'Guidelines URL', apiSlug: 'guidelines_url', type: 'text', description: 'Contributor / write-for-us / guest-post guidelines URL.' },
      { title: 'Target Page URL', apiSlug: 'target_page_url', type: 'text', description: 'Specific page to pitch, not just the root domain.' },
      { title: 'Pitch / Topic', apiSlug: 'pitch_topic', type: 'text', description: 'Specific pitch angle appropriate for this publication.' },
      { title: 'Authority', apiSlug: 'authority_score', type: 'number', description: 'Semrush authority score for the domain. Not Moz DA.' },
      { title: 'Outbound Links', apiSlug: 'outbound_links', type: 'number', description: 'External links on the crawled page or domain sample. Null if not crawled.' },
      { title: 'SERP Keyword', apiSlug: 'serp_keyword', type: 'text', description: 'Keyword this landing page ranks for, when it also appears in HHT prospecting.' },
      { title: 'SERP Position', apiSlug: 'serp_position', type: 'number', description: 'Best Google position for that keyword, when known.' },
      { title: 'Keyword Volume', apiSlug: 'keyword_volume', type: 'number', description: 'National monthly search volume for that keyword, when known.' },
      { title: 'Eligibility', apiSlug: 'eligibility', type: 'text', description: 'Guest-post eligibility from the opportunity engine.' },
      { title: 'Link Allowed?', apiSlug: 'link_allowed', type: 'checkbox', description: 'Whether the guidelines allow an editorial or author link.' },
      { title: 'Published URL', apiSlug: 'published_url', type: 'text', description: 'URL of the published guest post. CRM-owned.' },
    ],
  },
}

export function listSpec(workstream: AttioWorkstream): AttioListSpec {
  return ATTIO_LIST_SPECS[workstream]
}

export function allListSpecs(): AttioListSpec[] {
  return Object.values(ATTIO_LIST_SPECS)
}
