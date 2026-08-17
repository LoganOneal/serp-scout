import 'server-only'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { workspaceRoot } from '../paths.js'

export interface HhtBlProfile {
  discovery: {
    serp_sample_size: number
    organic_competitor_depth: number
    serp_result_limit: number
  }
  research_sites: { target_count: number }
  backlinks: {
    follow_only: boolean
    provider_follow_filter: boolean
    min_authority_score: number
    detailed_links_per_site: number
    page_size: number
  }
  crawl: {
    concurrency: number
    timeout_seconds: number
    max_attempts: number
    deep_analysis_limit: number
  }
  analysis: { provider: string; model: string }
  scoring: {
    link_value_weight: number
    gettability_weight: number
    transferability_weight: number
    effort_weight: number
  }
}

export interface HhtBlConfig {
  active_profile: string
  profiles: Record<string, HhtBlProfile>
  taxonomy: Record<string, string[]>
  destinations: string[]
}

const positiveInteger = (value: unknown, path: string): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${path} must be positive`)
  return Number(value)
}

export function validateHhtBlConfig(value: unknown): HhtBlConfig {
  if (!value || typeof value !== 'object') throw new Error('HHT backlink config must be an object')
  const config = value as Record<string, unknown>
  if (typeof config['active_profile'] !== 'string') throw new Error('active_profile is required')
  if (!config['profiles'] || typeof config['profiles'] !== 'object') {
    throw new Error('profiles are required')
  }
  if (!config['taxonomy'] || typeof config['taxonomy'] !== 'object') {
    throw new Error('taxonomy is required')
  }
  if (!Array.isArray(config['destinations']) || config['destinations'].length === 0) {
    throw new Error('destinations must be a non-empty array')
  }

  const profiles = config['profiles'] as Record<string, HhtBlProfile>
  const active = profiles[config['active_profile']]
  if (!active) throw new Error(`profile ${config['active_profile']} does not exist`)
  positiveInteger(active.discovery?.serp_sample_size, 'discovery.serp_sample_size')
  positiveInteger(active.research_sites?.target_count, 'research_sites.target_count')
  positiveInteger(active.backlinks?.page_size, 'backlinks.page_size')
  positiveInteger(active.crawl?.max_attempts, 'crawl.max_attempts')
  if (active.backlinks.follow_only && !active.backlinks.provider_follow_filter) {
    throw new Error(
      'provider_follow_filter must be true when follow_only is enabled',
    )
  }

  const weights = Object.values(active.scoring)
  if (weights.some((weight) => typeof weight !== 'number' || weight < 0)) {
    throw new Error('scoring weights must be non-negative numbers')
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (Math.abs(total - 1) > 0.0001) throw new Error('scoring weights must add to 1')

  for (const [category, patterns] of Object.entries(
    config['taxonomy'] as Record<string, unknown>,
  )) {
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string')) {
      throw new Error(`taxonomy.${category} must be an array of patterns`)
    }
  }

  return config as unknown as HhtBlConfig
}

export async function loadHhtBlConfig(
  path = resolve(workspaceRoot(), 'config', 'hht-bl', 'pipeline.yml'),
): Promise<HhtBlConfig> {
  return validateHhtBlConfig(parse(await readFile(path, 'utf8')))
}

export function activeHhtBlProfile(
  config: HhtBlConfig,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; profile: HhtBlProfile } {
  const name = env['HHT_BL_PROFILE']?.trim() || config.active_profile
  const profile = config.profiles[name]
  if (!profile) throw new Error(`HHT_BL_PROFILE=${name} is not defined`)
  return { name, profile }
}

export interface HhtBlKeywordSeed {
  category: string
  destination: string
  keyword: string
}

export function buildHhtBlKeywordUniverse(config: HhtBlConfig): HhtBlKeywordSeed[] {
  const rows: HhtBlKeywordSeed[] = []
  for (const [category, patterns] of Object.entries(config.taxonomy)) {
    for (const destination of config.destinations) {
      for (const pattern of patterns) {
        rows.push({
          category,
          destination,
          keyword: pattern.replaceAll('{destination}', destination),
        })
      }
    }
  }
  return rows
}

/** Deterministic stratified sample across both categories and the full destination set. */
export function sampleHhtBlKeywords(
  rows: HhtBlKeywordSeed[],
  limit: number,
): HhtBlKeywordSeed[] {
  const byCategory = new Map<string, HhtBlKeywordSeed[]>()
  for (const row of rows) {
    const bucket = byCategory.get(row.category) ?? []
    bucket.push(row)
    byCategory.set(row.category, bucket)
  }
  const categories = [...byCategory.keys()].sort()
  const target = Math.min(limit, rows.length)
  const quotas = new Map(categories.map((category) => [category, 0]))
  for (let assigned = 0; assigned < target; ) {
    let added = false
    for (const category of categories) {
      const size = byCategory.get(category)?.length ?? 0
      const quota = quotas.get(category) ?? 0
      if (quota >= size) continue
      quotas.set(category, quota + 1)
      assigned += 1
      added = true
      if (assigned === target) break
    }
    if (!added) break
  }

  const spread = new Map<string, HhtBlKeywordSeed[]>()
  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
    const category = categories[categoryIndex]!
    const bucket = byCategory.get(category) ?? []
    const quota = quotas.get(category) ?? 0
    spread.set(
      category,
      Array.from({ length: quota }, (_, index) => {
        const categoryOffset = categoryIndex / categories.length
        const bucketIndex = Math.floor(((index + categoryOffset) * bucket.length) / quota)
        return bucket[bucketIndex]!
      }),
    )
  }

  const sampled: HhtBlKeywordSeed[] = []
  for (let index = 0; sampled.length < target; index += 1) {
    for (const category of categories) {
      const row = spread.get(category)?.[index]
      if (row) sampled.push(row)
    }
  }
  return sampled
}

export function expandHhtBlKeywordSample(
  rows: HhtBlKeywordSeed[],
  existingKeywords: Iterable<string>,
  target: number,
): HhtBlKeywordSeed[] {
  if (!Number.isInteger(target) || target <= 0) throw new Error('keyword target must be positive')
  const existing = new Set(existingKeywords)
  if (target > rows.length) {
    throw new Error(`keyword target ${target} exceeds the ${rows.length}-keyword universe`)
  }
  if (existing.size >= target) return []

  return sampleHhtBlKeywords(rows, rows.length)
    .filter((row) => !existing.has(row.keyword))
    .slice(0, target - existing.size)
}
