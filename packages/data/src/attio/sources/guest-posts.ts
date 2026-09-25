import 'server-only'
import { eq, inArray, sql } from 'drizzle-orm'
import { buildGuestPostTargets, canonicalPageUrl, parseCsv, type GuestPostOpportunityRow } from '@rnr/core'
import { readFile } from 'node:fs/promises'
import type { Database } from '../../db.js'
import {
  hhtOppContacts,
  hhtOppCrawledPages,
  hhtOppDomains,
  hhtOppOpportunities,
  hhtOppSeoMetrics,
  hhtPxKeywords,
  hhtPxKeywordVolumes,
  hhtPxPageKeywordMatches,
  hhtPxProspectPages,
} from '../../schema.js'

const GUEST_TYPES = ['editorial_guest', 'paid_guest_post'] as const

export async function loadGuestPostTargets(database: Database, csvPath?: string) {
  const rows = await database
    .select({
      id: hhtOppOpportunities.id,
      domainId: hhtOppDomains.id,
      rootDomain: hhtOppDomains.rootDomain,
      displayName: hhtOppDomains.displayName,
      opportunityType: hhtOppOpportunities.opportunityType,
      eligibility: hhtOppOpportunities.eligibility,
      opportunityUrl: hhtOppOpportunities.opportunityUrl,
      relevantArticleUrl: hhtOppOpportunities.relevantArticleUrl,
      pitchAngle: hhtOppOpportunities.pitchAngle,
      whyItMatters: hhtOppOpportunities.whyItMatters,
      priceAmount: hhtOppOpportunities.priceAmount,
      priceStatus: hhtOppOpportunities.priceStatus,
      linkType: hhtOppOpportunities.linkType,
      avgExternalLinks: hhtOppDomains.avgExternalLinks,
    })
    .from(hhtOppOpportunities)
    .innerJoin(hhtOppDomains, eq(hhtOppDomains.id, hhtOppOpportunities.domainId))
    .where(inArray(hhtOppOpportunities.opportunityType, [...GUEST_TYPES]))

  const ids = rows.map((row) => row.id)
  const domainIds = [...new Set(rows.map((row) => row.domainId))]
  const contacts = ids.length
    ? await database
        .select()
        .from(hhtOppContacts)
        .where(inArray(hhtOppContacts.opportunityId, ids))
    : []
  const contactByOpp = new Map<number, (typeof contacts)[number]>()
  for (const contact of contacts) {
    const prev = contactByOpp.get(contact.opportunityId)
    const better =
      !prev ||
      (contact.email && !prev.email) ||
      (contact.status === 'VERIFIED_PUBLIC' && prev.status !== 'VERIFIED_PUBLIC')
    if (better) contactByOpp.set(contact.opportunityId, contact)
  }

  const authorityByDomain = new Map<number, number>()
  if (domainIds.length) {
    const authorityRows = await database
      .select({
        domainId: hhtOppSeoMetrics.domainId,
        metric: hhtOppSeoMetrics.metric,
        value: hhtOppSeoMetrics.value,
      })
      .from(hhtOppSeoMetrics)
      .where(inArray(hhtOppSeoMetrics.domainId, domainIds))
    for (const row of authorityRows) {
      if (row.metric !== 'authority_score' || row.value == null) continue
      authorityByDomain.set(row.domainId, row.value)
    }
  }

  const outboundByUrl = new Map<string, number>()
  if (domainIds.length) {
    const crawled = await database
      .select({
        url: hhtOppCrawledPages.url,
        externalLinkCount: hhtOppCrawledPages.externalLinkCount,
      })
      .from(hhtOppCrawledPages)
      .where(inArray(hhtOppCrawledPages.domainId, domainIds))
    for (const page of crawled) {
      if (page.externalLinkCount == null) continue
      const key = canonicalPageUrl(page.url)
      if (key) outboundByUrl.set(key, page.externalLinkCount)
    }
  }

  const pageUrls = [
    ...new Set(
      rows
        .flatMap((row) => [canonicalPageUrl(row.relevantArticleUrl), canonicalPageUrl(row.opportunityUrl)])
        .filter((url): url is string => Boolean(url)),
    ),
  ]
  const serpByUrl = new Map<string, { keyword: string | null; position: number | null; volume: number | null }>()
  if (pageUrls.length) {
    const pxPages = await database
      .select({
        id: hhtPxProspectPages.id,
        normalizedUrl: hhtPxProspectPages.normalizedUrl,
        bestPosition: hhtPxProspectPages.bestPosition,
        maxKeywordVolume: hhtPxProspectPages.maxKeywordVolume,
      })
      .from(hhtPxProspectPages)
      .where(inArray(hhtPxProspectPages.normalizedUrl, pageUrls))
    const pxIds = pxPages.map((page) => page.id)
    const bestByPage = new Map<number, { keyword: string; position: number; volume: number | null }>()
    if (pxIds.length) {
      const matches = await database
        .select({
          pageId: hhtPxPageKeywordMatches.pageId,
          keyword: hhtPxKeywords.keyword,
          position: hhtPxPageKeywordMatches.position,
          volume: sql<number | null>`coalesce(${hhtPxPageKeywordMatches.volume}, ${hhtPxKeywordVolumes.nationalDestinationVolume})`,
        })
        .from(hhtPxPageKeywordMatches)
        .innerJoin(hhtPxKeywords, eq(hhtPxKeywords.id, hhtPxPageKeywordMatches.keywordId))
        .leftJoin(hhtPxKeywordVolumes, eq(hhtPxKeywordVolumes.keywordId, hhtPxKeywords.id))
        .where(inArray(hhtPxPageKeywordMatches.pageId, pxIds))
      for (const match of matches) {
        const current = bestByPage.get(match.pageId)
        const volume = match.volume ?? -1
        const better =
          !current ||
          volume > (current.volume ?? -1) ||
          (volume === (current.volume ?? -1) && match.position < current.position)
        if (better) {
          bestByPage.set(match.pageId, {
            keyword: match.keyword,
            position: match.position,
            volume: match.volume,
          })
        }
      }
    }
    for (const page of pxPages) {
      const best = bestByPage.get(page.id)
      serpByUrl.set(page.normalizedUrl, {
        keyword: best?.keyword ?? null,
        position: best?.position ?? page.bestPosition ?? null,
        volume: best?.volume ?? page.maxKeywordVolume ?? null,
      })
    }
  }

  const opportunities: GuestPostOpportunityRow[] = rows.map((row) => {
    const contact = contactByOpp.get(row.id)
    const pageUrl = canonicalPageUrl(row.relevantArticleUrl) ?? canonicalPageUrl(row.opportunityUrl)
    const serp = pageUrl ? serpByUrl.get(pageUrl) : undefined
    return {
      ...row,
      contactEmail: contact?.email ?? null,
      contactName: contact?.name ?? null,
      contactRole: contact?.role ?? null,
      authorityScore: authorityByDomain.get(row.domainId) ?? null,
      outboundLinks: (pageUrl ? outboundByUrl.get(pageUrl) : undefined) ?? (row.avgExternalLinks != null ? Math.round(row.avgExternalLinks) : null),
      serpKeyword: serp?.keyword ?? null,
      serpPosition: serp?.position ?? null,
      keywordVolume: serp?.volume ?? null,
    }
  })

  let csvRows: Array<Record<string, string>> = []
  if (csvPath) {
    csvRows = parseCsv(await readFile(csvPath, 'utf8'))
  }

  return buildGuestPostTargets({ opportunities, csvRows })
}
