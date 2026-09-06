import 'server-only'
import {
  brokenLinkRelevance,
  defaultHhtReplacementUrl,
  isBrokenLinkTarget,
  isFailedFetchStatus,
  shouldCreateBrokenLinkOpportunity,
} from '@rnr/core'
import { eq, inArray } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppCrawledPages, hhtOppOpportunities } from '../schema.js'
import { crawlHhtOppPage, listOutboundLinks } from './crawl.js'
import { suggestHhtAssets } from './assets.js'
import { findOpportunity, findOpportunityByType, replaceOpportunityChildren } from './store.js'

export interface BrokenScanResult {
  pages: number
  checked: number
  created: number
  updated: number
}

export async function scanHhtOppBrokenLinks(
  db: Database,
  options: { domainId?: number; fetchImpl?: typeof fetch; maxChecks?: number } = {},
): Promise<BrokenScanResult> {
  const pages = options.domainId
    ? await db.select().from(hhtOppCrawledPages).where(eq(hhtOppCrawledPages.domainId, options.domainId))
    : await db.select().from(hhtOppCrawledPages).limit(80)
  const result: BrokenScanResult = { pages: pages.length, checked: 0, created: 0, updated: 0 }
  const maxChecks = Math.min(options.maxChecks ?? 12, 24)
  const seen = new Set<string>()

  for (const page of pages) {
    if (result.checked >= maxChecks || !page.rawHtml) continue
    const links = listOutboundLinks(page.rawHtml, page.url).filter((link) => isBrokenLinkTarget(link.url, link.anchor))
    for (const link of links.slice(0, 4)) {
      if (result.checked >= maxChecks || seen.has(link.url)) continue
      seen.add(link.url)
      const fetched = await crawlHhtOppPage(link.url, { fetchImpl: options.fetchImpl, maxAttempts: 1 })
      result.checked += 1
      if (!isFailedFetchStatus(fetched.httpStatus, fetched.error)) continue
      const relevance = brokenLinkRelevance(page.pageText ?? page.title ?? '', link.url, link.anchor)
      if (!shouldCreateBrokenLinkOpportunity(relevance)) continue

      const assets = await suggestHhtAssets(db, {
        text: `${page.title ?? ''} ${page.pageText ?? ''} ${link.anchor}`,
        opportunityUrl: page.url,
      })
      const replacement = assets[0]?.url ?? defaultHhtReplacementUrl()
      const existingId =
        (await findOpportunity(db, page.domainId, 'broken_link', page.url)) ??
        (await findOpportunityByType(db, page.domainId, 'broken_link'))
      const values = {
        domainId: page.domainId,
        opportunityType: 'broken_link' as const,
        opportunityUrl: page.url,
        status: 'REVIEW' as const,
        eligibility: 'REVIEW' as const,
        eligibilityReason: 'Broken outbound travel link found. Human must confirm HHT is a legitimate substitute.',
        eligibilityConfidence: 'MEDIUM' as const,
        eligibilitySourceUrl: page.url,
        eligibilityExcerpt: link.url,
        eligibilityCheckedAt: new Date(),
        whyItMatters: `Broken ${link.url} on a travel page. Proposed HHT replacement: ${replacement}.`,
        pitchAngle: 'Broken-link replacement with a verified hotel-amenity resource.',
        relevantArticleUrl: page.url,
        brokenUrl: link.url,
        replacementUrl: replacement,
        discoveredByStrategy: 'broken_links' as const,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      }
      if (existingId) {
        await db.update(hhtOppOpportunities).set(values).where(eq(hhtOppOpportunities.id, existingId))
        result.updated += 1
      } else {
        const inserted = await db.insert(hhtOppOpportunities).values(values).returning({ id: hhtOppOpportunities.id })
        await replaceOpportunityChildren(db, inserted[0]!.id, {
          requirements: [],
          sources: [{ url: page.url, title: page.title, role: 'opportunity_page', excerpt: link.anchor || link.url }],
          pricing: [],
          contacts: [],
        })
        result.created += 1
      }
    }
  }

  return result
}

export async function listBrokenOpportunities(db: Database) {
  return db
    .select()
    .from(hhtOppOpportunities)
    .where(inArray(hhtOppOpportunities.opportunityType, ['broken_link']))
    .limit(50)
}
