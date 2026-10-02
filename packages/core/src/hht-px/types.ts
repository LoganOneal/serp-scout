/**
 * Hotel Hot Tubs SERP backlink prospecting — shared vocabulary.
 *
 * This pipeline finds existing editorial pages that already rank, then scores
 * whether a Hotel Hot Tubs citation would be editorially logical. Keyword
 * volume is a prioritization feature, not the output.
 */

export const HHT_PX_STAGES = [
  'geographies',
  'keyword_generation',
  'google_ads_volume',
  'keyword_prioritization',
  'semrush_serps',
  'serp_classification',
  'page_deduplication',
  'domain_enrichment',
  'opportunity_scoring',
  'review_export',
] as const

export type HhtPxStage = (typeof HHT_PX_STAGES)[number]

export const HHT_PX_RUN_STATUSES = [
  'draft',
  'running',
  'paused',
  'waiting',
  'complete',
  'failed',
] as const

export type HhtPxRunStatus = (typeof HHT_PX_RUN_STATUSES)[number]

export const HHT_PX_JOB_STATUSES = [
  'pending',
  'running',
  'complete',
  'cancelled',
  'waiting',
  'failed',
] as const

export type HhtPxJobStatus = (typeof HHT_PX_JOB_STATUSES)[number]

export const HHT_PX_GEO_TYPES = [
  'state',
  'city',
  'metro',
  'destination_region',
  'neighborhood',
] as const

export type HhtPxGeoType = (typeof HHT_PX_GEO_TYPES)[number]

export const HHT_PX_CLUSTERS = [
  'hotel_hot_tubs',
  'romantic_hotels',
  'romantic_getaways',
  'honeymoon_anniversary',
  'spa_wellness',
  'unique_boutique_luxury',
  'adjacent_amenities',
  'cabins_lodges',
  'seasonal',
  'ski_beach_mountain_lake',
  'destination_planning',
  'occasion',
  'hot_springs',
  'national_editorial',
  'near_queries',
] as const

export type HhtPxCluster = (typeof HHT_PX_CLUSTERS)[number]

export const HHT_PX_CLUSTER_LABELS: Record<HhtPxCluster, string> = {
  hotel_hot_tubs: 'Hotels with hot tubs',
  romantic_hotels: 'Romantic hotels',
  romantic_getaways: 'Romantic getaways',
  honeymoon_anniversary: 'Honeymoon / anniversary',
  spa_wellness: 'Spa / wellness',
  unique_boutique_luxury: 'Unique / boutique / luxury',
  adjacent_amenities: 'Adjacent romantic amenities',
  cabins_lodges: 'Cabins / lodges',
  seasonal: 'Seasonal travel',
  ski_beach_mountain_lake: 'Ski / beach / mountain / lake',
  destination_planning: 'Destination planning',
  occasion: 'Occasion-based',
  hot_springs: 'Hot springs',
  national_editorial: 'National editorial',
  near_queries: 'Near-geo experimental',
}

/** 0–100 topical fit of the cluster to Hotel Hot Tubs. */
export const HHT_PX_CLUSTER_TOPICAL_FIT: Record<HhtPxCluster, number> = {
  hotel_hot_tubs: 100,
  romantic_hotels: 90,
  romantic_getaways: 85,
  honeymoon_anniversary: 88,
  spa_wellness: 80,
  unique_boutique_luxury: 65,
  adjacent_amenities: 82,
  cabins_lodges: 70,
  seasonal: 68,
  ski_beach_mountain_lake: 72,
  destination_planning: 45,
  occasion: 60,
  hot_springs: 40,
  national_editorial: 75,
  near_queries: 35,
}

export const HHT_PX_PRIORITIES = [
  'very_high',
  'high',
  'medium_high',
  'medium',
  'low_medium',
  'low',
] as const

export type HhtPxPriority = (typeof HHT_PX_PRIORITIES)[number]

export const HHT_PX_PRIORITY_SCORE: Record<HhtPxPriority, number> = {
  very_high: 95,
  high: 80,
  medium_high: 65,
  medium: 50,
  low_medium: 35,
  low: 20,
}

export const HHT_PX_LINKABILITIES = [
  'very_high',
  'high',
  'medium_high',
  'medium',
  'low',
] as const

export type HhtPxLinkability = (typeof HHT_PX_LINKABILITIES)[number]

export const HHT_PX_LINKABILITY_SCORE: Record<HhtPxLinkability, number> = {
  very_high: 95,
  high: 80,
  medium_high: 70,
  medium: 55,
  low: 30,
}

export const HHT_PX_KEYWORD_SOURCES = ['template', 'google_keyword_ideas', 'discovery_seed'] as const
export type HhtPxKeywordSource = (typeof HHT_PX_KEYWORD_SOURCES)[number]

/** Paid placement queue, earned tourism partnership, hard exclusion, or not yet inspected. */
export const HHT_PX_PUBLISHER_LANES = ['paid_outreach', 'earned_partnership', 'excluded', 'needs_review'] as const
export type HhtPxPublisherLane = (typeof HHT_PX_PUBLISHER_LANES)[number]

export const HHT_PX_EVIDENCE_STATES = ['observed', 'inferred', 'unknown'] as const
export type HhtPxEvidenceState = (typeof HHT_PX_EVIDENCE_STATES)[number]

/** outreach_ready is the only status that enters the approach list. */
export const HHT_PX_QUALIFICATIONS = ['outreach_ready', 'downgraded', 'excluded', 'needs_review', 'unreviewed'] as const
export type HhtPxQualification = (typeof HHT_PX_QUALIFICATIONS)[number]

export const HHT_PX_PUBLISHER_LANE_LABELS: Record<HhtPxPublisherLane, string> = {
  paid_outreach: 'Paid outreach',
  earned_partnership: 'Earned partnership',
  excluded: 'Excluded',
  needs_review: 'Needs review',
}

export const HHT_PX_SERP_STATUSES = [
  'unchecked',
  'queued',
  'cached',
  'stale',
  'failed',
  'skipped',
] as const

export type HhtPxSerpStatus = (typeof HHT_PX_SERP_STATUSES)[number]

export const HHT_PX_DESIRABLE_TYPES = [
  'travel_blog',
  'editorial_travel_site',
  'local_media',
  'regional_magazine',
  'national_magazine',
  'newspaper_travel',
  'tourism_board',
  'destination_guide',
  'lifestyle_blog',
  'couples_relationship_site',
  'wedding_honeymoon_site',
  'wellness_spa_site',
  'independent_hotel_guide',
] as const

export type HhtPxDesirableType = (typeof HHT_PX_DESIRABLE_TYPES)[number]

export const HHT_PX_UNDESIRABLE_TYPES = [
  'ota',
  'hotel',
  'hotel_chain',
  'direct_hht_competitor',
  'ugc_forum',
  'reddit',
  'social_media',
  'maps',
  'search_engine',
  'directory',
  'coupon_site',
  'spam_site',
  'irrelevant',
] as const

export type HhtPxUndesirableType = (typeof HHT_PX_UNDESIRABLE_TYPES)[number]

export const HHT_PX_PAGE_TYPES = [...HHT_PX_DESIRABLE_TYPES, ...HHT_PX_UNDESIRABLE_TYPES] as const
export type HhtPxPageType = (typeof HHT_PX_PAGE_TYPES)[number]

export const HHT_PX_PAGE_TYPE_LABELS: Record<HhtPxPageType, string> = {
  travel_blog: 'Travel blog',
  editorial_travel_site: 'Editorial',
  local_media: 'Local media',
  regional_magazine: 'Regional magazine',
  national_magazine: 'National magazine',
  newspaper_travel: 'Newspaper travel',
  tourism_board: 'Tourism',
  destination_guide: 'Destination guide',
  lifestyle_blog: 'Lifestyle blog',
  couples_relationship_site: 'Couples / relationship',
  wedding_honeymoon_site: 'Wedding / honeymoon',
  wellness_spa_site: 'Wellness / spa',
  independent_hotel_guide: 'Independent hotel guide',
  ota: 'OTA',
  hotel: 'Hotel',
  hotel_chain: 'Hotel chain',
  direct_hht_competitor: 'Competitor',
  ugc_forum: 'UGC',
  reddit: 'Reddit',
  social_media: 'Social',
  maps: 'Maps',
  search_engine: 'Search',
  directory: 'Directory',
  coupon_site: 'Coupon',
  spam_site: 'Spam',
  irrelevant: 'Other',
}

export const HHT_PX_BADGE_GROUPS: Record<
  'editorial' | 'blog' | 'local_media' | 'tourism' | 'ota' | 'hotel' | 'competitor' | 'ugc' | 'other',
  readonly HhtPxPageType[]
> = {
  editorial: ['editorial_travel_site', 'national_magazine', 'regional_magazine', 'newspaper_travel', 'independent_hotel_guide'],
  blog: ['travel_blog', 'lifestyle_blog', 'couples_relationship_site', 'wedding_honeymoon_site', 'wellness_spa_site'],
  local_media: ['local_media'],
  tourism: ['tourism_board', 'destination_guide'],
  ota: ['ota', 'directory', 'coupon_site'],
  hotel: ['hotel', 'hotel_chain'],
  competitor: ['direct_hht_competitor'],
  ugc: ['ugc_forum', 'reddit', 'social_media'],
  other: ['maps', 'search_engine', 'spam_site', 'irrelevant'],
}

export function hhtPxBadgeGroup(
  type: HhtPxPageType,
): keyof typeof HHT_PX_BADGE_GROUPS {
  for (const [group, types] of Object.entries(HHT_PX_BADGE_GROUPS)) {
    if ((types as readonly HhtPxPageType[]).includes(type)) {
      return group as keyof typeof HHT_PX_BADGE_GROUPS
    }
  }
  return 'other'
}

export const HHT_PX_COMPETITOR_STRENGTHS = ['none', 'weak', 'moderate', 'direct'] as const
export type HhtPxCompetitorStrength = (typeof HHT_PX_COMPETITOR_STRENGTHS)[number]

export const HHT_PX_OUTREACH_STATUSES = [
  'not_contacted',
  'contacted',
  'in_conversation',
  'linked',
  'declined',
  'skipped',
] as const

export type HhtPxOutreachStatus = (typeof HHT_PX_OUTREACH_STATUSES)[number]

export const HHT_PX_WHY_LINK_CATEGORIES = [
  'resource_extension',
  'amenity_extension',
  'data_citation',
  'property_verification',
] as const

export type HhtPxWhyLinkCategory = (typeof HHT_PX_WHY_LINK_CATEGORIES)[number]

export const HHT_PX_WHY_LINK_LABELS: Record<HhtPxWhyLinkCategory, string> = {
  resource_extension: 'Resource extension',
  amenity_extension: 'Amenity extension',
  data_citation: 'Data citation',
  property_verification: 'Property verification',
}

export const DESIRABLE_TYPE_SET: ReadonlySet<HhtPxPageType> = new Set(HHT_PX_DESIRABLE_TYPES)
export const UNDESIRABLE_TYPE_SET: ReadonlySet<HhtPxPageType> = new Set(HHT_PX_UNDESIRABLE_TYPES)

export function isHhtPxPageType(value: string): value is HhtPxPageType {
  return (HHT_PX_PAGE_TYPES as readonly string[]).includes(value)
}

export function isHhtPxCluster(value: string): value is HhtPxCluster {
  return (HHT_PX_CLUSTERS as readonly string[]).includes(value)
}

export function isHhtPxGeoType(value: string): value is HhtPxGeoType {
  return (HHT_PX_GEO_TYPES as readonly string[]).includes(value)
}

export function isHhtPxPriority(value: string): value is HhtPxPriority {
  return (HHT_PX_PRIORITIES as readonly string[]).includes(value)
}

export function isHhtPxOutreachStatus(value: string): value is HhtPxOutreachStatus {
  return (HHT_PX_OUTREACH_STATUSES as readonly string[]).includes(value)
}

export function isHhtPxCompetitorStrength(value: string): value is HhtPxCompetitorStrength {
  return (HHT_PX_COMPETITOR_STRENGTHS as readonly string[]).includes(value)
}

export interface HhtPxKeywordTemplateSeed {
  template: string
  cluster: HhtPxCluster
  variantGroup: string
  priority: HhtPxPriority
  expectedLinkability: HhtPxLinkability
  geographic: boolean
  enabled: boolean
}

export interface HhtPxGeographySeed {
  name: string
  normalizedName: string
  state: string | null
  stateCode: string | null
  type: HhtPxGeoType
  parentNormalizedName: string | null
  hhtSlug: string | null
  /** Phrase used inside `[GEO]` templates. May be more specific than `name`. */
  queryName: string
  hotelCount: number | null
  privateHotTubCount: number | null
  sharedHotTubCount: number | null
  editorsChoiceCount: number | null
  active: boolean
  priority: number
}

export interface HhtPxGeneratedKeyword {
  keyword: string
  keywordNorm: string
  geographyKey: string | null
  template: string
  cluster: HhtPxCluster
  variantGroup: string
  source: HhtPxKeywordSource
  priority: HhtPxPriority
  expectedLinkability: HhtPxLinkability
}

export const HHT_PX_SERP_OVERLAP_THRESHOLD = 0.7
export const HHT_PX_SERP_DEPTH = 20
export const HHT_PX_SERP_STALE_DAYS = 90
export const HHT_SITE_ORIGIN = 'https://hotelhottubs.com'
