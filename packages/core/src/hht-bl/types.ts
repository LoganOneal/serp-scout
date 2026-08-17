export const HHT_BL_STAGES = [
  'keywords',
  'serp_discovery',
  'competitor_discovery',
  'site_classification',
  'site_enrichment',
  'site_selection',
  'backlink_matrix',
  'backlink_collection',
  'crawling',
  'link_analysis',
  'opportunity_scoring',
  'strategy_clustering',
  'export',
] as const

export type HhtBlStage = (typeof HHT_BL_STAGES)[number]

export const HHT_BL_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETE',
  'WAITING_FOR_CREDENTIALS',
  'FAILED',
] as const

export type HhtBlJobStatus = (typeof HHT_BL_JOB_STATUSES)[number]

export const HHT_BL_RUN_STATUSES = [
  'DRAFT',
  'RUNNING',
  'PAUSED',
  'WAITING_FOR_CREDENTIALS',
  'COMPLETE',
  'FAILED',
] as const

export type HhtBlRunStatus = (typeof HHT_BL_RUN_STATUSES)[number]

export const HHT_BL_CANDIDATE_STATES = [
  'DISCOVERED',
  'CLASSIFIED',
  'ENRICHED',
  'SCORED',
  'SELECTED',
  'BACKLINK_RESEARCHED',
] as const

export type HhtBlCandidateState = (typeof HHT_BL_CANDIDATE_STATES)[number]

export const HHT_BL_BACKLINK_STATES = [
  'DISCOVERED',
  'NORMALIZED',
  'CRAWLED',
  'ANALYZED',
  'SCORED',
  'SHORTLISTED',
] as const

export type HhtBlBacklinkState = (typeof HHT_BL_BACKLINK_STATES)[number]

export const HHT_BL_SITE_TYPES = [
  'independent_affiliate_publisher',
  'travel_directory',
  'programmatic_travel_site',
  'independent_editorial_publisher',
  'destination_guide',
  'tourism_organization',
  'OTA',
  'major_travel_brand',
  'hotel_brand',
  'UGC_platform',
  'general_publisher',
  'other',
] as const

export type HhtBlSiteType = (typeof HHT_BL_SITE_TYPES)[number]

export interface HhtBlSiteClassification {
  siteType: HhtBlSiteType
  businessModel: string | null
  contentModel: string | null
  affiliateLikely: boolean
  directoryLikely: boolean
  programmaticSeoLikely: boolean
  hotelInventory: boolean
  editorialContent: boolean
  geographicLandingPages: boolean
  brandDependency: number
  travelRelevance: number
  hhtSimilarity: number
  transferability: number
  reasoning: string
  evidence: string[]
}

export function parseHhtBlSiteClassification(value: unknown): HhtBlSiteClassification {
  if (!value || typeof value !== 'object') throw new Error('site classification must be an object')
  const row = value as Record<string, unknown>
  if (typeof row['siteType'] !== 'string' || !HHT_BL_SITE_TYPES.includes(row['siteType'] as HhtBlSiteType)) {
    throw new Error('unknown site type')
  }
  const score = (name: string): number => {
    const candidate = row[name]
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 100) {
      throw new Error(`${name} must be a number from 0 to 100`)
    }
    return candidate
  }
  const bool = (name: string): boolean => {
    if (typeof row[name] !== 'boolean') throw new Error(`${name} must be boolean`)
    return row[name]
  }
  const nullableText = (name: string): string | null => {
    if (row[name] === null) return null
    if (typeof row[name] !== 'string') throw new Error(`${name} must be text or null`)
    return row[name].trim() || null
  }
  if (typeof row['reasoning'] !== 'string' || row['reasoning'].trim() === '') {
    throw new Error('reasoning must be non-empty text')
  }
  if (!Array.isArray(row['evidence']) || row['evidence'].some((item) => typeof item !== 'string')) {
    throw new Error('evidence must be an array of text')
  }
  return {
    siteType: row['siteType'] as HhtBlSiteType,
    businessModel: nullableText('businessModel'),
    contentModel: nullableText('contentModel'),
    affiliateLikely: bool('affiliateLikely'),
    directoryLikely: bool('directoryLikely'),
    programmaticSeoLikely: bool('programmaticSeoLikely'),
    hotelInventory: bool('hotelInventory'),
    editorialContent: bool('editorialContent'),
    geographicLandingPages: bool('geographicLandingPages'),
    brandDependency: score('brandDependency'),
    travelRelevance: score('travelRelevance'),
    hhtSimilarity: score('hhtSimilarity'),
    transferability: score('transferability'),
    reasoning: row['reasoning'].trim(),
    evidence: (row['evidence'] as string[]).map((item) => item.trim()).filter(Boolean),
  }
}

export const HHT_BL_MECHANISMS = [
  'journalist_editorial',
  'data_research_citation',
  'statistics_citation',
  'tourism_board_resource',
  'destination_guide',
  'curated_resource_page',
  'directory_listing',
  'association_listing',
  'hotel_partner',
  'guest_contribution',
  'expert_quote',
  'broken_link',
  'tool_widget_embed',
  'image_attribution',
  'affiliate_relationship',
  'PR_coverage',
  'syndication',
  'sponsored_paid',
  'organic_unreplicable',
  'spam_or_PBN',
  'unknown',
] as const

export type HhtBlMechanism = (typeof HHT_BL_MECHANISMS)[number]

export interface HhtBlLinkAnalysis {
  mechanism: HhtBlMechanism
  mechanismConfidence: number
  editorial: boolean
  likelyPaid: boolean
  replicable: boolean
  replicabilityScore: number
  hotelHotTubsRelevance: number
  requiresNewAsset: boolean
  requiredAssetType: string | null
  likelyContactRole: string | null
  recommendedAction: string
  /** Directly observed statements, each tied to supplied page evidence. */
  facts: string[]
  /** Model conclusions that are plausible but not directly observed. */
  inferences: string[]
  evidence: string[]
}

export function isHhtBlMechanism(value: unknown): value is HhtBlMechanism {
  return typeof value === 'string' && HHT_BL_MECHANISMS.includes(value as HhtBlMechanism)
}

export function parseHhtBlLinkAnalysis(value: unknown): HhtBlLinkAnalysis {
  if (!value || typeof value !== 'object') throw new Error('link analysis must be an object')
  const row = value as Record<string, unknown>
  if (!isHhtBlMechanism(row['mechanism'])) throw new Error('unknown acquisition mechanism')

  const score = (name: string): number => {
    const candidate = row[name]
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 100) {
      throw new Error(`${name} must be a number from 0 to 100`)
    }
    return candidate
  }
  const confidence = (name: string): number => {
    const candidate = row[name]
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
      throw new Error(`${name} must be a number from 0 to 1`)
    }
    return candidate
  }
  const bool = (name: string): boolean => {
    const candidate = row[name]
    if (typeof candidate !== 'boolean') throw new Error(`${name} must be boolean`)
    return candidate
  }
  const text = (name: string): string => {
    const candidate = row[name]
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new Error(`${name} must be non-empty text`)
    }
    return candidate.trim()
  }
  const nullableText = (name: string): string | null => {
    const candidate = row[name]
    if (candidate === null) return null
    if (typeof candidate !== 'string') throw new Error(`${name} must be text or null`)
    return candidate.trim() || null
  }
  const texts = (name: string): string[] => {
    const candidate = row[name]
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== 'string')) {
      throw new Error(`${name} must be an array of text`)
    }
    return candidate.map((item) => item.trim()).filter(Boolean)
  }

  return {
    mechanism: row['mechanism'],
    mechanismConfidence: confidence('mechanismConfidence'),
    editorial: bool('editorial'),
    likelyPaid: bool('likelyPaid'),
    replicable: bool('replicable'),
    replicabilityScore: score('replicabilityScore'),
    hotelHotTubsRelevance: score('hotelHotTubsRelevance'),
    requiresNewAsset: bool('requiresNewAsset'),
    requiredAssetType: nullableText('requiredAssetType'),
    likelyContactRole: nullableText('likelyContactRole'),
    recommendedAction: text('recommendedAction'),
    facts: texts('facts'),
    inferences: texts('inferences'),
    evidence: texts('evidence'),
  }
}
