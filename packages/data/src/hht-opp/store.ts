import 'server-only'
import { and, eq } from 'drizzle-orm'
import { registrableDomain, type HhtOppStrategy } from '@rnr/core'
import type { Database } from '../db.js'
import {
  hhtOppContacts,
  hhtOppCrawledPages,
  hhtOppDomains,
  hhtOppOpportunities,
  hhtOppPricingOptions,
  hhtOppRequirements,
  hhtOppSeoMetrics,
  hhtOppSources,
} from '../schema.js'
import type { HhtOppCrawlResult } from './crawl.js'

export async function upsertHhtOppDomain(
  db: Database,
  urlOrDomain: string,
): Promise<{ id: number; rootDomain: string }> {
  const rootDomain = registrableDomain(urlOrDomain)?.domain
  if (!rootDomain) throw new Error(`Cannot resolve a registrable domain from ${urlOrDomain}`)
  const existing = await db
    .select({ id: hhtOppDomains.id })
    .from(hhtOppDomains)
    .where(eq(hhtOppDomains.rootDomain, rootDomain))
    .limit(1)
  if (existing[0]) {
    await db
      .update(hhtOppDomains)
      .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(hhtOppDomains.id, existing[0].id))
    return { id: existing[0].id, rootDomain }
  }
  const inserted = await db
    .insert(hhtOppDomains)
    .values({
      rootDomain,
      canonicalUrl: `https://${rootDomain}`,
      lastCheckedAt: new Date(),
    })
    .returning({ id: hhtOppDomains.id })
  return { id: inserted[0]!.id, rootDomain }
}

export async function saveCrawledPage(
  db: Database,
  domainId: number,
  page: HhtOppCrawlResult,
): Promise<void> {
  const url = page.finalUrl ?? page.url
  const existing = await db
    .select({ id: hhtOppCrawledPages.id, contentHash: hhtOppCrawledPages.contentHash })
    .from(hhtOppCrawledPages)
    .where(and(eq(hhtOppCrawledPages.domainId, domainId), eq(hhtOppCrawledPages.url, url)))
    .limit(1)

  const values = {
    domainId,
    url,
    title: page.title,
    httpStatus: page.httpStatus,
    contentHash: page.contentHash,
    pageText: page.pageText,
    rawHtml: page.rawHtml,
    externalLinkCount: page.outbound?.externalLinks ?? null,
    internalLinkCount: page.outbound?.internalLinks ?? null,
    uniqueExternalDomains: page.outbound?.uniqueExternalDomains ?? null,
    commercialLinkCount: page.outbound?.commercialLinks ?? null,
    fetchedAt: new Date(),
    error: page.error,
  }

  if (existing[0]) {
    await db.update(hhtOppCrawledPages).set(values).where(eq(hhtOppCrawledPages.id, existing[0].id))
    return
  }
  await db.insert(hhtOppCrawledPages).values(values)
}

export async function findOpportunity(
  db: Database,
  domainId: number,
  type: string,
  url: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: hhtOppOpportunities.id })
    .from(hhtOppOpportunities)
    .where(
      and(
        eq(hhtOppOpportunities.domainId, domainId),
        eq(hhtOppOpportunities.opportunityType, type as never),
        eq(hhtOppOpportunities.opportunityUrl, url),
      ),
    )
    .limit(1)
  return rows[0]?.id ?? null
}

export async function findOpportunityByType(
  db: Database,
  domainId: number,
  type: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: hhtOppOpportunities.id })
    .from(hhtOppOpportunities)
    .where(
      and(eq(hhtOppOpportunities.domainId, domainId), eq(hhtOppOpportunities.opportunityType, type as never)),
    )
    .limit(1)
  return rows[0]?.id ?? null
}

export async function replaceOpportunityChildren(
  db: Database,
  opportunityId: number,
  args: {
    requirements: Array<{
      groupName: (typeof hhtOppRequirements.$inferInsert)['groupName']
      label: string
      requirementText: string
      sourceUrl: string
      sourceExcerpt: string
      dateChecked: Date
      confidence: (typeof hhtOppRequirements.$inferInsert)['confidence']
    }>
    sources: Array<{ url: string; title: string | null; role: string; excerpt: string | null }>
    pricing: Array<{
      label: string | null
      amount: number | null
      currency: string | null
      pricingModel: (typeof hhtOppPricingOptions.$inferInsert)['pricingModel']
      included: string | null
      linkAttribute: string | null
      evidenceUrl: string
      evidenceText: string | null
    }>
    contacts: Array<{
      email: string | null
      name: string | null
      role: string | null
      formUrl: string | null
      status: (typeof hhtOppContacts.$inferInsert)['status']
      sourceUrl: string
      sourceExcerpt: string | null
    }>
  },
): Promise<void> {
  await db.delete(hhtOppRequirements).where(eq(hhtOppRequirements.opportunityId, opportunityId))
  await db.delete(hhtOppSources).where(eq(hhtOppSources.opportunityId, opportunityId))
  await db.delete(hhtOppPricingOptions).where(eq(hhtOppPricingOptions.opportunityId, opportunityId))
  await db.delete(hhtOppContacts).where(eq(hhtOppContacts.opportunityId, opportunityId))

  if (args.requirements.length) {
    await db.insert(hhtOppRequirements).values(args.requirements.map((row) => ({ ...row, opportunityId })))
  }
  if (args.sources.length) {
    await db.insert(hhtOppSources).values(args.sources.map((row) => ({ ...row, opportunityId })))
  }
  if (args.pricing.length) {
    await db.insert(hhtOppPricingOptions).values(args.pricing.map((row) => ({ ...row, opportunityId })))
  }
  if (args.contacts.length) {
    await db.insert(hhtOppContacts).values(args.contacts.map((row) => ({ ...row, opportunityId })))
  }
}

export async function latestSeoMetrics(
  db: Database,
  domainId: number,
): Promise<Record<string, number | null>> {
  const rows = await db.select().from(hhtOppSeoMetrics).where(eq(hhtOppSeoMetrics.domainId, domainId))
  const latest = new Map<string, { value: number | null; at: Date }>()
  for (const row of rows) {
    const prev = latest.get(row.metric)
    if (!prev || row.retrievedAt > prev.at) latest.set(row.metric, { value: row.value, at: row.retrievedAt })
  }
  return Object.fromEntries([...latest.entries()].map(([metric, row]) => [metric, row.value]))
}

export function strategyLabel(strategy: HhtOppStrategy): string {
  return strategy.replaceAll('_', ' ')
}
