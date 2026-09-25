import 'server-only'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { buildBacklinkTargets, canonicalPageUrl, type BacklinkProspectRow } from '@rnr/core'
import type { Database } from '../../db.js'
import {
  hhtOppCrawledPages,
  hhtOppDomains,
  hhtPxKeywords,
  hhtPxKeywordVolumes,
  hhtPxPageKeywordMatches,
  hhtPxProspectDomains,
  hhtPxProspectPages,
} from '../../schema.js'

export async function loadBacklinkTargets(database: Database, limit = 5_000) {
  const rows = await database
    .select({
      id: hhtPxProspectPages.id,
      url: hhtPxProspectPages.url,
      normalizedUrl: hhtPxProspectPages.normalizedUrl,
      title: hhtPxProspectPages.title,
      rootDomain: hhtPxProspectDomains.rootDomain,
      pageType: hhtPxProspectPages.pageType,
      isProspectable: hhtPxProspectPages.isProspectable,
      suggestedHhtUrl: hhtPxProspectPages.suggestedHhtUrl,
      whyLink: hhtPxProspectPages.whyLink,
      opportunityScore: hhtPxProspectPages.opportunityScore,
      maxKeywordVolume: hhtPxProspectPages.maxKeywordVolume,
      bestPosition: hhtPxProspectPages.bestPosition,
      authorityScore: hhtPxProspectDomains.authorityScore,
      referringDomains: hhtPxProspectDomains.referringDomains,
    })
    .from(hhtPxProspectPages)
    .innerJoin(hhtPxProspectDomains, eq(hhtPxProspectDomains.id, hhtPxProspectPages.domainId))
    .where(eq(hhtPxProspectPages.isProspectable, true))
    .orderBy(desc(hhtPxProspectPages.maxKeywordVolume), desc(hhtPxProspectPages.opportunityScore))
    .limit(limit)

  const pageIds = rows.map((row) => row.id)
  const bestByPage = new Map<number, { keyword: string; position: number; volume: number | null }>()
  if (pageIds.length) {
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
      .where(inArray(hhtPxPageKeywordMatches.pageId, pageIds))

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

  const outboundByUrl = new Map<string, number>()
  const domains = [...new Set(rows.map((row) => row.rootDomain).filter(Boolean))]
  if (domains.length) {
    const oppDomains = await database
      .select({ id: hhtOppDomains.id, rootDomain: hhtOppDomains.rootDomain })
      .from(hhtOppDomains)
      .where(inArray(hhtOppDomains.rootDomain, domains))
    const oppDomainIds = oppDomains.map((row) => row.id)
    if (oppDomainIds.length) {
      const crawled = await database
        .select({
          url: hhtOppCrawledPages.url,
          externalLinkCount: hhtOppCrawledPages.externalLinkCount,
        })
        .from(hhtOppCrawledPages)
        .where(inArray(hhtOppCrawledPages.domainId, oppDomainIds))
      for (const page of crawled) {
        if (page.externalLinkCount == null) continue
        const key = canonicalPageUrl(page.url)
        if (key) outboundByUrl.set(key, page.externalLinkCount)
      }
    }
  }

  const enriched: BacklinkProspectRow[] = rows.map((row) => {
    const best = bestByPage.get(row.id)
    const url = canonicalPageUrl(row.normalizedUrl || row.url)
    return {
      ...row,
      serpKeyword: best?.keyword ?? null,
      serpPosition: best?.position ?? row.bestPosition ?? null,
      keywordVolume: best?.volume ?? row.maxKeywordVolume ?? null,
      outboundLinks: url ? outboundByUrl.get(url) ?? null : null,
    }
  })

  return buildBacklinkTargets(enriched)
}

export async function backlinkSourceCount(database: Database): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(hhtPxProspectPages)
    .where(eq(hhtPxProspectPages.isProspectable, true))
  return row?.n ?? 0
}
