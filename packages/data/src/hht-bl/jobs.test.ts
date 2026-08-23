import { describe, expect, it } from 'vitest'
import {
  chunkHhtBlBacklinkMetricTargets,
  hhtBlBacklinkMetricsJob,
  hhtBlDomainValidationJob,
  hhtBlSiteExpansionJobs,
  isHhtBlBacklinkMetricEligible,
  isHhtBlRelevantResearchSiteType,
} from './jobs.js'

describe('HHT site-first job planning', () => {
  it('builds a one-row domain traffic validation request', () => {
    expect(hhtBlDomainValidationJob(1, 'example.com')).toMatchObject({
      runId: 1,
      stage: 'site_enrichment',
      reportType: 'domain_rank',
      target: 'example.com',
      limit: 1,
      parameters: { target: 'example.com', database: 'us' },
    })
  })

  it('builds both organic and backlink peer expansion requests', () => {
    const jobs = hhtBlSiteExpansionJobs(1, 'example.com', {
      organicLimit: 10,
      backlinkLimit: 5,
    })
    expect(jobs.map((job) => [job.reportType, job.limit])).toEqual([
      ['domain_organic_organic', 10],
      ['backlinks_competitors', 5],
    ])
  })

  it('builds the observed batched backlink comparison request contract', () => {
    expect(hhtBlBacklinkMetricsJob(7, ['one.example', 'two.example'])).toEqual({
      runId: 7,
      stage: 'site_enrichment',
      reportType: 'backlinks_comparison',
      target: expect.stringMatching(/^backlink-metrics-[a-f0-9]{12}$/),
      parameters: {
        targets: ['one.example', 'two.example'],
        target_types: ['root_domain', 'root_domain'],
        export_columns: [
          'target',
          'target_type',
          'authority_score',
          'backlinks_num',
          'domains_num',
          'follows_num',
          'nofollows_num',
        ],
      },
      limit: 2,
    })
  })

  it('requires positive local relevance before paid backlink metrics', () => {
    const relevantMissingMetrics = {
      siteType: 'travel_directory' as const,
      authorityScore: null,
      totalBacklinks: null,
      referringDomains: null,
    }
    expect(isHhtBlBacklinkMetricEligible(relevantMissingMetrics)).toBe(true)
    expect(
      isHhtBlBacklinkMetricEligible({ ...relevantMissingMetrics, siteType: 'OTA' }),
    ).toBe(false)
    expect(
      isHhtBlBacklinkMetricEligible({ ...relevantMissingMetrics, siteType: 'other' }),
    ).toBe(false)
    expect(
      isHhtBlBacklinkMetricEligible({
        ...relevantMissingMetrics,
        authorityScore: 30,
        totalBacklinks: 100,
        referringDomains: 20,
      }),
    ).toBe(false)
  })

  it('batches comparison targets without exceeding the verified 40-domain contract', () => {
    expect(chunkHhtBlBacklinkMetricTargets(['a', 'b', 'c'], 2)).toEqual([
      ['a', 'b'],
      ['c'],
    ])
    expect(() => chunkHhtBlBacklinkMetricTargets(['a'], 41)).toThrow(/1 to 40/)
    expect(() => hhtBlBacklinkMetricsJob(1, [])).toThrow(/at least one/)
  })

  it('uses the same positive relevance gate for every paid enrichment stage', () => {
    expect(isHhtBlRelevantResearchSiteType('destination_guide')).toBe(true)
    expect(isHhtBlRelevantResearchSiteType('OTA')).toBe(false)
    expect(isHhtBlRelevantResearchSiteType(null)).toBe(false)
  })
})
