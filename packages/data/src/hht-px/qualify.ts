import 'server-only'
import { eq } from 'drizzle-orm'
import {
  assessHhtPxPublisher,
  hhtPxDiscoverySeeds,
  inspectPublisherHtml,
  normalizeHhtPxKeyword,
  type HhtPxPublisherLane,
  type PublisherAssessment,
} from '@rnr/core'
import type { Database } from '../db.js'
import { rawSql } from '../db.js'
import { hhtPxKeywords, hhtPxProspectDomains, hhtPxProspectPages } from '../schema.js'

const LANE_RANK: Record<HhtPxPublisherLane, number> = {
  paid_outreach: 4,
  needs_review: 3,
  earned_partnership: 2,
  excluded: 1,
}

export async function ensureHhtPxPublisherColumns(): Promise<void> {
  const sqlClient = rawSql()
  await sqlClient.unsafe(`
    ALTER TABLE hht_px_prospect_domains ADD COLUMN IF NOT EXISTS publisher_lane text;
    ALTER TABLE hht_px_prospect_domains ADD COLUMN IF NOT EXISTS publisher_reason text;
    ALTER TABLE hht_px_prospect_domains ADD COLUMN IF NOT EXISTS publisher_evidence text;
    ALTER TABLE hht_px_prospect_domains ADD COLUMN IF NOT EXISTS contact_url text;
    ALTER TABLE hht_px_prospect_domains ADD COLUMN IF NOT EXISTS classified_at timestamp with time zone;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS publisher_lane text;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS qualification text;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS qualification_reason text;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS editorial_score double precision;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS feasibility_score double precision;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS insertion_location text;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS reader_benefit text;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS evidence_confidence text;
    ALTER TABLE hht_px_prospect_pages ADD COLUMN IF NOT EXISTS score_detail text;
  `)
}

export async function insertHhtPxDiscoverySeeds(database: Database): Promise<{ inserted: number; totalSeeds: number; pilot: number }> {
  const seeds = hhtPxDiscoverySeeds()
  let inserted = 0
  for (const seed of seeds) {
    const keywordNorm = normalizeHhtPxKeyword(seed.phrase)
    const result = await database
      .insert(hhtPxKeywords)
      .values({
        keyword: seed.phrase,
        keywordNorm,
        cluster: 'national_editorial',
        variantGroup: `discovery:${keywordNorm}`,
        source: 'discovery_seed',
        priority: seed.pilot ? 'very_high' : 'high',
        expectedLinkability: 'very_high',
        isRepresentative: true,
        promoted: true,
        serpStatus: 'unchecked',
      })
      .onConflictDoNothing()
      .returning({ id: hhtPxKeywords.id })
    inserted += result.length
  }
  return { inserted, totalSeeds: seeds.length, pilot: seeds.filter((seed) => seed.pilot).length }
}

export async function qualifyHhtPxPublishers(
  database: Database,
  options: { limit?: number } = {},
): Promise<{ pages: number; fetched: number; failed: number; lanes: Record<string, number> }> {
  await ensureHhtPxPublisherColumns()
  const sqlClient = rawSql()
  await sqlClient`
    update hht_px_prospect_pages
    set publisher_lane = case
      when qualification = 'excluded' then 'excluded'
      when editorial_score is not null then 'paid_outreach'
      when qualification = 'downgraded' then 'earned_partnership'
      else 'needs_review'
    end
    where publisher_lane is null
      and (qualification is not null or evidence_confidence is not null)
  `
  const limit = Math.max(1, options.limit ?? 160)
  const pages = await database
    .select({
      id: hhtPxProspectPages.id,
      domainId: hhtPxProspectPages.domainId,
      url: hhtPxProspectPages.url,
      pageType: hhtPxProspectPages.pageType,
      score: hhtPxProspectPages.opportunityScore,
      bestPosition: hhtPxProspectPages.bestPosition,
      volume: hhtPxProspectPages.maxKeywordVolume,
      suggestedHhtUrl: hhtPxProspectPages.suggestedHhtUrl,
      domain: hhtPxProspectDomains.rootDomain,
      publisherLane: hhtPxProspectPages.publisherLane,
      qualificationReason: hhtPxProspectPages.qualificationReason,
      domainLane: hhtPxProspectDomains.publisherLane,
    })
    .from(hhtPxProspectPages)
    .innerJoin(hhtPxProspectDomains, eq(hhtPxProspectDomains.id, hhtPxProspectPages.domainId))

  const withGeo = await attachGeography(pages)
  const ranked = [...withGeo].sort((a, b) => {
    const aPending = a.publisherLane ? 1 : 0
    const bPending = b.publisherLane ? 1 : 0
    if (aPending !== bPending) return aPending - bPending
    return (b.score ?? 0) - (a.score ?? 0)
  })
  const pending = (row: { publisherLane: string | null; qualificationReason: string | null }) =>
    !row.publisherLane || /has not been fetched|unknown until the page is inspected/i.test(row.qualificationReason ?? '')
  const fetchBudget = new Set(ranked.filter(pending).slice(0, limit).map((row) => row.id))
  let fetched = 0
  let failed = 0
  const domainAssessments = new Map<number, PublisherAssessment>()
  const lanes: Record<string, number> = {}

  const queue = ranked.map((row) => async () => {
    if (row.publisherLane && !/has not been fetched|unknown until the page is inspected/i.test(row.qualificationReason ?? '')) {
      lanes[row.publisherLane] = (lanes[row.publisherLane] ?? 0) + 1
      return
    }
    const preview = assessHhtPxPublisher({
      url: row.url,
      domain: row.domain,
      pageType: row.pageType,
      geographyName: row.geoName,
      bestPosition: row.bestPosition,
      volume: row.volume,
    })
    let assessment = preview
    if (preview.lane === 'needs_review' && preview.signals.includes('not_fetched') && fetchBudget.has(row.id)) {
      const html = await fetchPage(row.url)
      fetched += 1
      if (!html) {
        failed += 1
        assessment = assessHhtPxPublisher({
          url: row.url,
          domain: row.domain,
          pageType: row.pageType,
          geographyName: row.geoName,
          bestPosition: row.bestPosition,
          volume: row.volume,
          inspection: { title: null, headings: [], hrefs: [], text: '' },
        })
        assessment = {
          ...assessment,
          lane: 'needs_review',
          evidence: 'unknown',
          qualification: 'needs_review',
          reason: 'The article URL did not return a readable page.',
          qualificationReason: 'Fetch failed, so this page stays in review.',
        }
      } else {
        assessment = assessHhtPxPublisher({
          url: row.url,
          domain: row.domain,
          pageType: row.pageType,
          geographyName: row.geoName,
          bestPosition: row.bestPosition,
          volume: row.volume,
          inspection: inspectPublisherHtml(html),
        })
      }
    }
    if (assessment.qualification === 'outreach_ready' && row.suggestedHhtUrl) {
      const live = await urlResolves(row.suggestedHhtUrl)
      if (!live) {
        assessment = {
          ...assessment,
          qualification: 'needs_review',
          qualificationReason: `HHT target ${row.suggestedHhtUrl} did not resolve, so this page is not outreach-ready.`,
        }
      }
    }
    lanes[assessment.lane] = (lanes[assessment.lane] ?? 0) + 1
    const current = domainAssessments.get(row.domainId)
    const existingRank = row.domainLane ? LANE_RANK[row.domainLane] : 0
    if (existingRank > LANE_RANK[assessment.lane] && !current) {
      // Keep the domain lane already stored from a stronger page.
    } else if (!current || LANE_RANK[assessment.lane] > LANE_RANK[current.lane]) {
      domainAssessments.set(row.domainId, assessment)
    }
    await database
      .update(hhtPxProspectPages)
      .set({
        publisherLane: assessment.lane,
        qualification: assessment.qualification,
        qualificationReason: assessment.qualificationReason,
        editorialScore: assessment.editorialScore,
        feasibilityScore: assessment.feasibilityScore,
        insertionLocation: assessment.insertionLocation,
        readerBenefit: assessment.readerBenefit,
        evidenceConfidence: assessment.evidence,
        scoreDetail: assessment.scoreDetail,
        updatedAt: new Date(),
      })
      .where(eq(hhtPxProspectPages.id, row.id))
  })

  await runPool(queue, 4)

  for (const [domainId, assessment] of domainAssessments) {
    await database
      .update(hhtPxProspectDomains)
      .set({
        publisherLane: assessment.lane,
        publisherReason: assessment.reason,
        publisherEvidence: assessment.evidence,
        contactUrl: assessment.contactUrl,
        classifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hhtPxProspectDomains.id, domainId))
  }

  return { pages: ranked.length, fetched, failed, lanes }
}

async function attachGeography<T extends { id: number }>(
  pages: T[],
): Promise<Array<T & { geoName: string | null }>> {
  const sqlClient = rawSql()
  const geos = await sqlClient<{ page_id: number; geo_name: string | null }[]>`
    select distinct on (m.page_id) m.page_id, g.name as geo_name
    from hht_px_page_keyword_matches m
    join hht_px_keywords k on k.id = m.keyword_id
    left join hht_px_geographies g on g.id = k.geography_id
    order by m.page_id, m.volume desc nulls last
  `
  const byPage = new Map(geos.map((row) => [row.page_id, row.geo_name]))
  return pages.map((page) => ({ ...page, geoName: byPage.get(page.id) ?? null }))
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      headers: { 'user-agent': 'SERPScoutHhtProspect/1.0' },
    })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('html') && !type.includes('text')) return null
    const text = await response.text()
    return text.slice(0, 400_000)
  } catch {
    return null
  }
}

async function urlResolves(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8_000) })
    if (response.ok) return true
    if (response.status === 405) {
      const get = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8_000) })
      return get.ok
    }
    return false
  } catch {
    return false
  }
}

async function runPool(jobs: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let index = 0
  async function worker(): Promise<void> {
    while (index < jobs.length) {
      const job = jobs[index]
      index += 1
      if (job) await job()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
}
