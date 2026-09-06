/**
 * HHT Backlink Opportunity Engine — shared vocabulary.
 *
 * Evidence fields (price, eligibility, contact, link policy) are NEVER produced
 * by an LLM. Every important claim carries source URL, excerpt, date, and
 * confidence. Absence of a prohibition is not a PASS.
 */

export const HHT_OPP_TYPES = [
  'editorial_guest',
  'paid_guest_post',
  'paid_link_insertion',
  'sponsored_content',
  'directory_listing',
  'resource_page',
  'existing_article',
  'broken_link',
  'unlinked_mention',
  'data_pr',
  'expert_source',
  'hotel_tourism_partnership',
  'other',
] as const

export type HhtOppType = (typeof HHT_OPP_TYPES)[number]

export const HHT_OPP_TYPE_LABELS: Record<HhtOppType, string> = {
  editorial_guest: 'Editorial guest contribution',
  paid_guest_post: 'Paid guest post',
  paid_link_insertion: 'Paid link insertion',
  sponsored_content: 'Sponsored content / advertorial',
  directory_listing: 'Directory / listing',
  resource_page: 'Resource-page inclusion',
  existing_article: 'Existing-article link',
  broken_link: 'Broken-link replacement',
  unlinked_mention: 'Unlinked brand mention',
  data_pr: 'Data / digital PR',
  expert_source: 'Expert-source',
  hotel_tourism_partnership: 'Hotel / tourism partnership',
  other: 'Other opportunity',
}

export const HHT_OPP_LINK_TYPES = [
  'contextual_dofollow',
  'contextual_nofollow',
  'contextual_sponsored',
  'bio_dofollow',
  'bio_nofollow',
  'directory_dofollow',
  'directory_nofollow',
  'unknown',
  'prohibited',
] as const

export type HhtOppLinkType = (typeof HHT_OPP_LINK_TYPES)[number]

export const HHT_OPP_ELIGIBILITY = ['PASS', 'REVIEW', 'FAIL'] as const
export type HhtOppEligibility = (typeof HHT_OPP_ELIGIBILITY)[number]

export const HHT_OPP_SEO_RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const
export type HhtOppSeoRisk = (typeof HHT_OPP_SEO_RISKS)[number]

export const HHT_OPP_PRICE_STATUSES = [
  'FREE',
  'PUBLISHER_PAYS',
  'FIXED',
  'QUOTE_REQUIRED',
  'UNKNOWN',
] as const
export type HhtOppPriceStatus = (typeof HHT_OPP_PRICE_STATUSES)[number]

export const HHT_OPP_PRICING_MODELS = ['one_time', 'monthly', 'annual', 'unspecified'] as const
export type HhtOppPricingModel = (typeof HHT_OPP_PRICING_MODELS)[number]

export const HHT_OPP_STATUSES = [
  'NEW',
  'RESEARCHING',
  'PASS',
  'REVIEW',
  'FAIL',
  'ENRICHED',
  'DRAFT_READY',
  'CONTACTED',
  'REPLIED',
  'NEGOTIATING',
  'PLACED',
  'REJECTED',
  'ARCHIVED',
  'QUOTED',
  'APPROVED',
  'PURCHASED',
] as const
export type HhtOppStatus = (typeof HHT_OPP_STATUSES)[number]

export const HHT_OPP_CONTACT_STATUSES = ['VERIFIED_PUBLIC', 'INFERRED', 'UNKNOWN'] as const
export type HhtOppContactStatus = (typeof HHT_OPP_CONTACT_STATUSES)[number]

export const HHT_OPP_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const
export type HhtOppConfidence = (typeof HHT_OPP_CONFIDENCE)[number]

export const HHT_OPP_QUALITY = ['OK', 'LOW_QUALITY', 'POSSIBLE_LINK_FARM'] as const
export type HhtOppQuality = (typeof HHT_OPP_QUALITY)[number]

export const HHT_OPP_IMAGE_RIGHTS = [
  'HHT_OWNED',
  'HOTEL_PRESS_KIT',
  'HOTEL_SUPPLIED',
  'LICENSED',
  'UNKNOWN',
] as const
export type HhtOppImageRights = (typeof HHT_OPP_IMAGE_RIGHTS)[number]

export const HHT_OPP_REQUIREMENT_GROUPS = [
  'contributor',
  'content',
  'link',
  'image',
  'submission',
  'financial',
  'miscellaneous',
] as const
export type HhtOppRequirementGroup = (typeof HHT_OPP_REQUIREMENT_GROUPS)[number]

export const HHT_OPP_STRATEGIES = [
  'manual_seed',
  'direct_keyword_search',
  'topic_serp',
  'competitor_backlinks',
  'backlink_graph',
  'author_graph',
  'directory_mining',
  'site_navigation',
  'paid_placement_language',
  'broken_links',
  'unlinked_mentions',
  'local_tourism',
  'creative_query',
] as const
export type HhtOppStrategy = (typeof HHT_OPP_STRATEGIES)[number]

export const HHT_OPP_DRAFT_STATUSES = ['draft', 'approved', 'sent', 'discarded'] as const
export type HhtOppDraftStatus = (typeof HHT_OPP_DRAFT_STATUSES)[number]

export interface HhtOppScoreWeights {
  seoValue: number
  feasibility: number
  topicalRelevance: number
  editorialQuality: number
  costEfficiency: number
  freshness: number
}

export const DEFAULT_HHT_OPP_SCORE_WEIGHTS: HhtOppScoreWeights = {
  seoValue: 0.3,
  feasibility: 0.25,
  topicalRelevance: 0.2,
  editorialQuality: 0.1,
  costEfficiency: 0.1,
  freshness: 0.05,
}

export interface HhtOppEvidence {
  sourceUrl: string
  sourceExcerpt: string
  checkedAt: string
  confidence: HhtOppConfidence
}

export interface HhtOppInventedType {
  name: string
  definition: string
  whyBacklink: string
  discoveryMethod: string
  outreachMethod: string
}

export const HHT_BRAND_TERMS = [
  'Hotel Hot Tubs',
  'HotelHotTubs',
  'hotelhottubs.com',
  'HotelHotTubs.com',
] as const

export const HHT_SITE_NAME = 'HotelHotTubs.com'
export const HHT_SITE_URL = 'https://hotelhottubs.com'
export const HHT_SITE_DOMAIN = 'hotelhottubs.com'
