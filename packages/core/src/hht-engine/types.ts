/**
 * HHT backlink engine. Semrush access is the Cursor MCP connector's OAuth
 * session, copied off this Mac by the sync helper. Cursor Automations call
 * https://mcp.semrush.com/v2/mcp with that copied bearer token. It does not
 * use SEMRUSH_API_KEY.
 */

export const HHT_ENGINE_SEMRUSH_MCP_URL = 'https://mcp.semrush.com/v2/mcp'

export const HHT_ENGINE_SEMRUSH_TOKEN_ENDPOINT =
  'https://api.semrush.com/apis/v4-raw/auth/v1/oauth2/access_token'

export type KeywordStatus =
  | 'NEW'
  | 'QUEUED'
  | 'ACTIVE'
  | 'LOW_YIELD_AT_CURRENT_DEPTH'
  | 'SATURATED'
  | 'LOW_YIELD'
  | 'REJECTED_IRRELEVANT'

export type EngineKeywordSource =
  | 'google_keyword_idea'
  | 'google_url_seed'
  | 'google_site_seed'
  | 'publisher_keyword'
  | 'competitor_keyword'
  | 'geographic_expansion'
  | 'llm_generated'
  | 'manual'
  | 'seed'
  | 'serp_title'
  | 'geo_template'
  | 'related_term'

export type OpportunityType = 'guest_post' | 'link_insertion'

export type GuestPostStatus =
  | 'ACCEPTS'
  | 'LIKELY_ACCEPTS'
  | 'UNKNOWN'
  | 'LIKELY_REJECTS'
  | 'DOES_NOT_ACCEPT'

export type FilterStatus = 'PASS' | 'EXCLUDED' | 'REVIEW'

export type LeadStatus =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'CONTACT_ENRICHED'
  | 'DRAFT_READY'
  | 'READY_FOR_OUTREACH'
  | 'CONTACTED'
  | 'RESPONDED'
  | 'INTERESTED'
  | 'PRICE_RECEIVED'
  | 'NEGOTIATING'
  | 'PLACEMENT_CONFIRMED'
  | 'HELD'
  | 'DEMOTED'
  | 'REJECTED'
  | 'NO_RESPONSE'
  | 'DECLINED_BY_HHT'
  | 'BLOCKED'

export type SiteType =
  | 'editorial_blog'
  | 'news_media'
  | 'travel_guide'
  | 'hotel_property'
  | 'hotel_chain'
  | 'ota_booking'
  | 'competitor_directory'
  | 'forum_social_ugc'
  | 'marketplace'
  | 'search_engine'
  | 'hht'
  | 'unknown'

export type HhtPageType =
  | 'homepage'
  | 'city'
  | 'state'
  | 'collection'
  | 'editors_choice'
  | 'blog_guide'
  | 'property'

export type SemrushSystemState = 'RUNNING' | 'LOW_CREDITS' | 'EXHAUSTED' | 'AUTH_FAILURE'

export type GadsSystemState = 'GADS_RUNNING' | 'GADS_RATE_LIMITED' | 'GADS_AUTH_FAILURE'

export interface HhtInventoryPage {
  url: string
  pageType: HhtPageType
  city: string | null
  state: string | null
  collection: string | null
  verifiedStayCount: number
  title: string | null
}

export interface EngineConfig {
  lowYieldDomainThreshold: number
  maxSerpDepth: number
  exploreShare: number
  lowCreditsUnits: number
  rankingReverifyDays: number
  contactCooldownDays: number
  declineCooldownDays: number
  linkFarmOutboundLinks: number
  llmRelevanceLow: number
  llmRelevanceHigh: number
  priorityWeights: {
    clusterYield: number
    relevance: number
    footprint: number
    sourceYield: number
    novelty: number
    cost: number
    volume: number
  }
}
