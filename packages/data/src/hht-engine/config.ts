import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from '@rnr/core'
import type { BlockLists, SiteRules } from '@rnr/core'

export interface EngineFileConfig {
  seeds: string[]
  geoTemplates: string[]
  competitors: string[]
  blockLists: BlockLists
  siteRules: SiteRules
  engine: EngineConfig
  expansionDepthCap: number
  dailyKeywordCap: number
  nearDuplicateSimilarity: number
  serpOverlapSaturated: number
  neighborhoodSimilarity: number
  semrushRelatedKeywords: boolean
  gadsRateLimitNotifyHours: number
  crmOutageNotifyMinutes: number
  reminderHours: number
  crmEnabled: boolean
  batchWallClockMinutes: number
  semrushUnitCap: number | null
  googleAdsCallCap: number
  llmTaskExportCap: number
  googleAdsGeoTargetId: number
  googleAdsLanguageId: number
  band2MinNewDomains: number
  band3MinNewDomains: number
  guestPostTopicDefaultCount: number
  guestPostTopicMaxChars: number
  guestPostFitLineMaxChars: number
  guestPostSubjectLineMaxChars: number
}

export function loadEngineConfig(path = process.env['HHT_ENGINE_CONFIG'] || 'config/hht-engine/engine.yml'): EngineFileConfig {
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const lists = (raw['block_lists'] ?? {}) as Record<string, string[]>
  const weights = (raw['weights'] ?? {}) as Record<string, number>
  return {
    seeds: stringList(raw['seeds']),
    geoTemplates: stringList(raw['geo_templates']),
    competitors: stringList(raw['competitors']),
    blockLists: {
      jobs: lists['jobs'] ?? [],
      salesRepair: lists['sales_repair'] ?? [],
      parts: lists['parts'] ?? [],
      brands: lists['brands'] ?? [],
      adult: lists['adult'] ?? [],
      outsideGeo: lists['outside_geo'] ?? [],
    },
    siteRules: {
      otas: stringList(raw['otas']),
      hotelChains: stringList(raw['hotel_chains']),
      competitors: stringList(raw['competitors']),
      forums: stringList(raw['forums']),
      marketplaces: stringList(raw['marketplaces']),
      searchEngines: stringList(raw['search_engines']),
      hht: ['hotelhottubs.com'],
    },
    engine: {
      ...DEFAULT_ENGINE_CONFIG,
      exploreShare: numberOr(raw['explore_share'], DEFAULT_ENGINE_CONFIG.exploreShare),
      lowYieldDomainThreshold: numberOr(raw['low_yield_domain_threshold'], DEFAULT_ENGINE_CONFIG.lowYieldDomainThreshold),
      maxSerpDepth: numberOr(raw['max_serp_depth'], DEFAULT_ENGINE_CONFIG.maxSerpDepth),
      lowCreditsUnits: numberOr(raw['low_credits_units'], DEFAULT_ENGINE_CONFIG.lowCreditsUnits),
      rankingReverifyDays: numberOr(raw['ranking_reverify_days'], DEFAULT_ENGINE_CONFIG.rankingReverifyDays),
      contactCooldownDays: numberOr(raw['contact_cooldown_days'], DEFAULT_ENGINE_CONFIG.contactCooldownDays),
      declineCooldownDays: numberOr(raw['decline_cooldown_days'], DEFAULT_ENGINE_CONFIG.declineCooldownDays),
      linkFarmOutboundLinks: numberOr(raw['link_farm_outbound_links'], DEFAULT_ENGINE_CONFIG.linkFarmOutboundLinks),
      llmRelevanceLow: numberOr(raw['relevance_low'], DEFAULT_ENGINE_CONFIG.llmRelevanceLow),
      llmRelevanceHigh: numberOr(raw['relevance_high'], DEFAULT_ENGINE_CONFIG.llmRelevanceHigh),
      priorityWeights: {
        clusterYield: numberOr(weights['cluster_yield'], DEFAULT_ENGINE_CONFIG.priorityWeights.clusterYield),
        relevance: numberOr(weights['relevance'], DEFAULT_ENGINE_CONFIG.priorityWeights.relevance),
        footprint: numberOr(weights['footprint'], DEFAULT_ENGINE_CONFIG.priorityWeights.footprint),
        sourceYield: numberOr(weights['source_yield'], DEFAULT_ENGINE_CONFIG.priorityWeights.sourceYield),
        novelty: numberOr(weights['novelty'], DEFAULT_ENGINE_CONFIG.priorityWeights.novelty),
        cost: numberOr(weights['cost'], DEFAULT_ENGINE_CONFIG.priorityWeights.cost),
        volume: numberOr(weights['volume'], DEFAULT_ENGINE_CONFIG.priorityWeights.volume),
      },
    },
    expansionDepthCap: numberOr(raw['expansion_depth_cap'], 4),
    dailyKeywordCap: numberOr(raw['daily_keyword_cap'], 200),
    nearDuplicateSimilarity: numberOr(raw['near_duplicate_similarity'], 0.92),
    serpOverlapSaturated: numberOr(raw['serp_overlap_saturated'], 0.5),
    neighborhoodSimilarity: numberOr(raw['neighborhood_similarity'], 0.72),
    semrushRelatedKeywords: raw['semrush_related_keywords'] === true,
    gadsRateLimitNotifyHours: numberOr(raw['gads_rate_limit_notify_hours'], 6),
    crmOutageNotifyMinutes: numberOr(raw['crm_outage_notify_minutes'], 60),
    reminderHours: numberOr(raw['reminder_hours'], 24),
    crmEnabled: raw['crm_enabled'] === true,
    batchWallClockMinutes: numberOr(raw['batch_wall_clock_minutes'], 20),
    semrushUnitCap: nullableNumber(raw['semrush_unit_cap']),
    googleAdsCallCap: numberOr(raw['google_ads_call_cap'], 100),
    llmTaskExportCap: numberOr(raw['llm_task_export_cap'], 100),
    googleAdsGeoTargetId: numberOr(raw['google_ads_geo_target_id'], 2840),
    googleAdsLanguageId: numberOr(raw['google_ads_language_id'], 1000),
    band2MinNewDomains: numberOr(raw['band_2_min_new_domains'], 1),
    band3MinNewDomains: numberOr(raw['band_3_min_new_domains'], 1),
    guestPostTopicDefaultCount: numberOr(raw['guest_post_topic_default_count'], 3),
    guestPostTopicMaxChars: numberOr(raw['guest_post_topic_max_chars'], 120),
    guestPostFitLineMaxChars: numberOr(raw['guest_post_fit_line_max_chars'], 240),
    guestPostSubjectLineMaxChars: numberOr(raw['guest_post_subject_line_max_chars'], 120),
  }
}

export function validateEngineConfig(config: EngineFileConfig): string[] {
  const errors: string[] = []
  if (config.seeds.length === 0) errors.push('seeds must not be empty')
  if (config.geoTemplates.length === 0) errors.push('geo_templates must not be empty')
  if (config.engine.llmRelevanceLow < 0 || config.engine.llmRelevanceLow >= config.engine.llmRelevanceHigh) {
    errors.push('relevance_low must be >= 0 and below relevance_high')
  }
  if (config.engine.llmRelevanceHigh > 1) errors.push('relevance_high must be <= 1')
  if (config.nearDuplicateSimilarity <= config.engine.llmRelevanceHigh || config.nearDuplicateSimilarity > 1) {
    errors.push('near_duplicate_similarity must be above relevance_high and <= 1')
  }
  if (config.serpOverlapSaturated <= 0 || config.serpOverlapSaturated >= 1) {
    errors.push('serp_overlap_saturated must be between 0 and 1')
  }
  if (config.neighborhoodSimilarity <= 0 || config.neighborhoodSimilarity >= config.nearDuplicateSimilarity) {
    errors.push('neighborhood_similarity must be above 0 and below near_duplicate_similarity')
  }
  if (config.engine.exploreShare < 0 || config.engine.exploreShare > 1) errors.push('explore_share must be between 0 and 1')
  if (config.engine.maxSerpDepth < 20 || config.engine.maxSerpDepth > 100) errors.push('max_serp_depth must be between 20 and 100')
  if (config.batchWallClockMinutes <= 0) errors.push('batch_wall_clock_minutes must be positive')
  if (config.googleAdsGeoTargetId <= 0 || config.googleAdsLanguageId <= 0) errors.push('Google Ads geo and language IDs must be positive')
  if (config.guestPostTopicDefaultCount < 1 || config.guestPostTopicDefaultCount > 10) {
    errors.push('guest_post_topic_default_count must be between 1 and 10')
  }
  if (config.guestPostTopicMaxChars < 20 || config.guestPostFitLineMaxChars < 40 || config.guestPostSubjectLineMaxChars < 20) {
    errors.push('guest-post personalization length limits are too small')
  }
  if (config.crmEnabled) errors.push('crm_enabled must remain false until the CRM integration phase')
  return errors
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === 'none') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
