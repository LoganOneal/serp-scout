/**
 * Opportunity Miner — shared vocabulary.
 *
 * Evidence fields (volume, CPC, KD, traffic, advertiser counts, observed
 * prices) are NEVER produced by an LLM. Inferred fields always carry a
 * confidence so the dashboard can tell measurement from hypothesis.
 */

export type Confidence = 'observed' | 'strongly_inferred' | 'weakly_inferred' | 'unknown'

export type OmCountry = 'us' | 'uk' | 'ca' | 'au'

export type KeywordSourceType =
  | 'seed'
  | 'related'
  | 'broad'
  | 'question'
  | 'semantic_expansion'
  | 'competitor_keyword'
  | 'paid_keyword'
  | 'google_ads_idea'
  | 'manual'

export type KeywordRelationType = Exclude<KeywordSourceType, 'seed' | 'manual' | 'google_ads_idea'> | 'google_ads_idea'

export type KeywordIntent =
  | 'commercial'
  | 'transactional'
  | 'informational'
  | 'navigational'
  | 'unknown'

export type RankingType = 'organic' | 'paid'

export type OmDomainClass =
  | 'dedicated_saas'
  | 'marketplace'
  | 'affiliate_content'
  | 'community'
  | 'major_platform'
  | 'major_incumbent'
  | 'small_niche'
  | 'irrelevant'
  | 'unknown'

export type DomainRole = 'competitor' | 'advertiser' | 'publisher' | 'platform' | 'irrelevant'

export type BusinessType =
  | 'B2C'
  | 'prosumer'
  | 'SMB'
  | 'vertical_saas'
  | 'creator'
  | 'ecommerce'
  | 'marketplace'
  | 'utility'
  | 'lead_gen'
  | 'unknown'

export type BuyerType =
  | 'consumer'
  | 'prosumer'
  | 'freelancer'
  | 'SMB'
  | 'mid_market'
  | 'enterprise'
  | 'unknown'

export type MonetizationModel =
  | 'subscription'
  | 'usage_based'
  | 'transaction_fee'
  | 'lead_gen'
  | 'advertising'
  | 'affiliate'
  | 'one_time'
  | 'unknown'

export type MarketStatus = 'new' | 'interesting' | 'investigate' | 'rejected' | 'validated' | 'building'

export type QueueJobType =
  | 'discover_keyword'
  | 'expand_keyword'
  | 'analyze_domain'
  | 'cluster'
  | 'score'
  | 'enrich_pricing'

export type QueueJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type AnomalyKind =
  | 'high_cpc_low_kd'
  | 'tiny_competitors_huge_traffic'
  | 'persistent_ads_weak_organic'
  | 'high_pricing_low_cpc'
  | 'fast_growth_weak_incumbents'
  | 'plg_sweet_spot'
  | 'utility_goldmine'
  | 'vertical_saas_wedge'

export type RejectionReason =
  | 'celebrity_news'
  | 'piracy'
  | 'illegal'
  | 'one_off_event'
  | 'purely_informational'
  | 'impossible_regulation'
  | 'navigational_cluster'
  | 'no_monetization_path'
  | 'owned_by_free_platform'
  | 'low_frequency_novelty'
  | 'adult_regulated'
  | 'duplicate_concept'
  | 'too_broad'
  | 'manual'

export interface KeywordMetrics {
  keyword: string
  volume: number | null
  cpc: number | null
  competition: number | null
  keywordDifficulty: number | null
  intent: KeywordIntent
  results: number | null
  /** Semrush trend string, e.g. "0.12,0.14,0.18,..." — newest last when present. */
  trend: string | null
  source: 'semrush' | 'google_ads' | 'merged'
}

export interface MonthlyVolume {
  year: number
  month: number
  volume: number
}

export interface ExtractedConcept {
  workflow: string | null
  industry: string | null
  persona: string | null
  object: string | null
  productArchetype: string | null
  commercialIntent: number
  recurringUsageLikelihood: number
  confidence: Confidence
}

export interface ScenarioTriple {
  bear: number
  base: number
  bull: number
}

export interface UnitEconomicsInput {
  monthlyPrice: ScenarioTriple
  lifetimeMonths: ScenarioTriple
  grossMargin: ScenarioTriple
  clickToPaid: ScenarioTriple
  /** Share of GP-LTV we are willing to spend on CAC. */
  targetCacShare: ScenarioTriple
  observedWeightedCpc: number | null
}

export interface UnitEconomicsResult {
  grossProfitLtv: ScenarioTriple
  allowableCac: ScenarioTriple
  sustainableCpc: ScenarioTriple
  cpcCoverage: ScenarioTriple
}

export interface MarketScoreBreakdown {
  demandScore: number
  commercialIntentScore: number
  monetizationEvidenceScore: number
  willingnessToPayScore: number
  recurringUsageScore: number
  expansionScore: number
  seoAccessibilityScore: number
  paidAcquisitionScore: number
  competitorWeaknessScore: number
  growthScore: number
  buildFeasibilityScore: number
  totalScore: number
}

export interface ScoreWeights {
  monetizationEvidence: number
  unitEconomics: number
  searchDemand: number
  competitiveAccessibility: number
  recurringRetention: number
  growth: number
  buildFeasibility: number
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  monetizationEvidence: 0.25,
  unitEconomics: 0.2,
  searchDemand: 0.15,
  competitiveAccessibility: 0.15,
  recurringRetention: 0.1,
  growth: 0.1,
  buildFeasibility: 0.05,
}

export const OM_CACHE_TTL_DAYS = {
  keywordMetrics: 30,
  serp: 7,
  domainTraffic: 30,
  adsHistory: 30,
  competitorPricing: 60,
  domainOverview: 30,
  backlinks: 30,
} as const

export const MAJOR_INCUMBENTS = [
  'google.com',
  'google.com/maps',
  'microsoft.com',
  'office.com',
  'adobe.com',
  'canva.com',
  'intuit.com',
  'quickbooks.intuit.com',
  'hubspot.com',
  'shopify.com',
  'amazon.com',
  'facebook.com',
  'meta.com',
  'apple.com',
  'linkedin.com',
  'youtube.com',
  'wikipedia.org',
  'yelp.com',
  'angi.com',
  'thumbtack.com',
] as const

export const COMMUNITY_DOMAINS = [
  'reddit.com',
  'quora.com',
  'stackoverflow.com',
  'stackexchange.com',
  'facebook.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'medium.com',
  'wordpress.com',
] as const

export const AFFILIATE_HINTS = [
  'best-',
  'vs-',
  'review',
  'top-10',
  'top10',
  'alternatives',
  'g2.com',
  'capterra.com',
  'getapp.com',
  'softwareadvice.com',
  'trustpilot.com',
  'pcmag.com',
  'techradar.com',
  'forbes.com',
  'nerdwallet.com',
]

export const PRODUCT_ARCHETYPES = [
  'generator',
  'maker',
  'creator',
  'builder',
  'checker',
  'analyzer',
  'tracker',
  'planner',
  'scheduler',
  'calculator',
  'converter',
  'optimizer',
  'monitor',
  'editor',
  'enhancer',
  'remover',
  'finder',
  'software',
  'app',
  'tool',
  'platform',
  'automation',
  'crm',
  'estimator',
  'invoicing',
] as const

export type ProductArchetype = (typeof PRODUCT_ARCHETYPES)[number]
