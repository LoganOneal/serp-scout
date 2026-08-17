import { describe, expect, it } from 'vitest'
import { buildHhtBlKeywordUniverse, sampleHhtBlKeywords, validateHhtBlConfig } from './config.js'

const config = {
  active_profile: 'pilot',
  profiles: {
    pilot: {
      discovery: { serp_sample_size: 4, organic_competitor_depth: 1, serp_result_limit: 10 },
      research_sites: { target_count: 2 },
      backlinks: {
        follow_only: true,
        provider_follow_filter: false,
        min_authority_score: 20,
        detailed_links_per_site: 10,
        page_size: 5,
      },
      crawl: { concurrency: 2, timeout_seconds: 20, max_attempts: 3, deep_analysis_limit: 10 },
      analysis: { provider: 'export', model: 'configurable' },
      scoring: {
        link_value_weight: 0.4,
        gettability_weight: 0.3,
        transferability_weight: 0.2,
        effort_weight: 0.1,
      },
    },
  },
  taxonomy: {
    hotels: ['hotels in {destination}'],
    trips: ['weekend trips in {destination}'],
  },
  destinations: ['Chicago', 'Miami'],
}

describe('HHT backlink configuration', () => {
  it('builds and samples a deterministic, stratified keyword universe', () => {
    const parsed = validateHhtBlConfig(config)
    const universe = buildHhtBlKeywordUniverse(parsed)
    expect(universe).toHaveLength(4)
    expect(sampleHhtBlKeywords(universe, 2).map((row) => row.category)).toEqual(['hotels', 'trips'])
  })

  it('spreads a pilot across destinations instead of exhausting the first city', () => {
    const destinations = Array.from({ length: 12 }, (_, index) => `City ${index + 1}`)
    const parsed = validateHhtBlConfig({ ...config, destinations })
    const sample = sampleHhtBlKeywords(buildHhtBlKeywordUniverse(parsed), 8)

    expect(new Set(sample.map((row) => row.category))).toEqual(new Set(['hotels', 'trips']))
    expect(new Set(sample.map((row) => row.destination)).size).toBeGreaterThanOrEqual(6)
  })

  it('refuses to claim provider-side follow filtering that Semrush does not expose', () => {
    const bad = structuredClone(config)
    bad.profiles.pilot.backlinks.provider_follow_filter = true
    expect(() => validateHhtBlConfig(bad)).toThrow(/verified Semrush backlinks schema/)
  })
})
