import 'server-only'
import { excludeDiscoveryDomain } from '@rnr/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppCrawledPages, hhtOppOpportunities } from '../schema.js'
import { listOutboundLinks } from './crawl.js'
import { researchHhtOppSeed, type ResearchSeedResult } from './research.js'

export async function mineHhtOppDirectories(
  db: Database,
  options: { domainLimit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ directories: number; researched: ResearchSeedResult[] }> {
  const directoryOpps = await db
    .select()
    .from(hhtOppOpportunities)
    .where(eq(hhtOppOpportunities.discoveredByStrategy, 'directory_mining'))
    .limit(20)
  const pages = await db.select().from(hhtOppCrawledPages).limit(80)
  const directoryPages = pages.filter((page) =>
    directoryOpps.some((opp) => opp.domainId === page.domainId || opp.opportunityUrl === page.url),
  )
  const fallback = directoryPages.length ? directoryPages : pages.filter((page) => /director|list of .*blog|best travel (blogs|sites)/i.test(`${page.title ?? ''} ${page.url}`))
  const seen = new Set<string>()
  const researched: ResearchSeedResult[] = []
  const domainLimit = Math.min(options.domainLimit ?? 6, 10)

  for (const page of fallback) {
    if (!page.rawHtml) continue
    for (const link of listOutboundLinks(page.rawHtml, page.url)) {
      if (seen.has(link.domain) || excludeDiscoveryDomain(link.domain).excluded) continue
      seen.add(link.domain)
      if (researched.length >= domainLimit) continue
      researched.push(await researchHhtOppSeed(db, `https://${link.domain}`, { strategy: 'directory_mining', fetchImpl: options.fetchImpl }))
    }
  }

  return { directories: fallback.length, researched }
}

export async function expandHhtOppGraph(
  db: Database,
  options: { domainId?: number; domainLimit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ sources: number; researched: ResearchSeedResult[] }> {
  const pages = options.domainId
    ? await db.select().from(hhtOppCrawledPages).where(eq(hhtOppCrawledPages.domainId, options.domainId))
    : await db.select().from(hhtOppCrawledPages).limit(40)
  const passDomains = new Set(
    (
      await db
        .select({ domainId: hhtOppOpportunities.domainId })
        .from(hhtOppOpportunities)
        .where(eq(hhtOppOpportunities.eligibility, 'PASS'))
    ).map((row) => row.domainId),
  )
  const sources = pages.filter((page) => !options.domainId || passDomains.has(page.domainId) || passDomains.size === 0)
  const seen = new Set<string>()
  const researched: ResearchSeedResult[] = []
  const domainLimit = Math.min(options.domainLimit ?? 5, 8)

  for (const page of sources) {
    if (!page.rawHtml) continue
    for (const link of listOutboundLinks(page.rawHtml, page.url).slice(0, 12)) {
      if (seen.has(link.domain) || excludeDiscoveryDomain(link.domain).excluded) continue
      seen.add(link.domain)
      if (researched.length >= domainLimit) continue
      researched.push(await researchHhtOppSeed(db, `https://${link.domain}`, { strategy: 'backlink_graph', fetchImpl: options.fetchImpl }))
    }
  }

  return { sources: sources.length, researched }
}
