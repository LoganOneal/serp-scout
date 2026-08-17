import { describe, expect, it } from 'vitest'
import { hhtBlDomainValidationJob, hhtBlSiteExpansionJobs } from './jobs.js'

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
})
