import { eq } from 'drizzle-orm'
import { classifySearchDomain, hostFromDomain } from '@rnr/core'
import type { Database } from '../db.js'
import { omAds, omKeywordDomains, omKeywords } from '../schema.js'
import { omLog } from './log.js'
import { createSemrushClient, semrushApiKey } from './semrush/client.js'
import { addEdge, enqueue, upsertDomain, upsertKeyword } from './store.js'

export async function discoverSerpAndAds(
  db: Database,
  keywordId: number,
  opts: { country?: string; live?: boolean } = {},
): Promise<void> {
  if (!opts.live || !semrushApiKey()) return
  const [kw] = await db.select().from(omKeywords).where(eq(omKeywords.id, keywordId)).limit(1)
  if (!kw) return
  const client = createSemrushClient(db, process.env, true)
  const country = opts.country ?? kw.country

  const [organic, ads, history] = await Promise.all([
    client.keywordSerp(kw.keyword, { database: country, limit: 15 }),
    client.keywordAds(kw.keyword, { database: country, limit: 15 }),
    client.keywordAdsHistory(kw.keyword, { database: country, limit: 30 }),
  ])

  for (const row of organic) {
    const domainId = await upsertDomain(db, row.domain, { classification: classifySearchDomain(row.domain) })
    await db
      .insert(omKeywordDomains)
      .values({
        keywordId,
        domainId,
        rankingType: 'organic',
        position: row.position,
        url: row.url,
      })
      .onConflictDoUpdate({
        target: [omKeywordDomains.keywordId, omKeywordDomains.domainId, omKeywordDomains.rankingType],
        set: { position: row.position, url: row.url, lastSeen: new Date() },
      })
  }

  for (const row of ads) {
    const domainId = await upsertDomain(db, row.domain, { classification: classifySearchDomain(row.domain) })
    await db
      .insert(omKeywordDomains)
      .values({
        keywordId,
        domainId,
        rankingType: 'paid',
        position: null,
        url: row.url,
      })
      .onConflictDoUpdate({
        target: [omKeywordDomains.keywordId, omKeywordDomains.domainId, omKeywordDomains.rankingType],
        set: { lastSeen: new Date() },
      })
  }
  for (const row of history) {
    const domainId = await upsertDomain(db, row.domain, { classification: classifySearchDomain(row.domain) })
    await db
      .insert(omKeywordDomains)
      .values({
        keywordId,
        domainId,
        rankingType: 'paid',
        position: row.position,
        url: row.url,
      })
      .onConflictDoUpdate({
        target: [omKeywordDomains.keywordId, omKeywordDomains.domainId, omKeywordDomains.rankingType],
        set: { lastSeen: new Date() },
      })
    if (row.adTitle || row.adText) {
      await db.insert(omAds).values({
        domainId,
        keywordId,
        adTitle: row.adTitle,
        adText: row.adText,
        visibleUrl: row.visibleUrl,
        dateSeen: row.date,
      })
    }
  }

  const interesting = [...organic.slice(0, 5), ...ads.slice(0, 5)]
  for (const row of interesting) {
    const host = hostFromDomain(row.domain)
    if (classifySearchDomain(host) === 'major_platform') continue
    const domainId = await upsertDomain(db, host)
    await enqueue(db, { jobType: 'analyze_domain', priority: 55, domainId })
  }
}

export async function analyzeDomain(
  db: Database,
  domainId: number,
  opts: { country?: string; live?: boolean } = {},
): Promise<{ paid: number; organic: number; adjacent: number }> {
  const { omDomains } = await import('../schema.js')
  const [domain] = await db.select().from(omDomains).where(eq(omDomains.id, domainId)).limit(1)
  if (!domain) return { paid: 0, organic: 0, adjacent: 0 }
  if (!opts.live || !semrushApiKey()) return { paid: 0, organic: 0, adjacent: 0 }

  const client = createSemrushClient(db, process.env, true)
  const country = opts.country ?? 'us'

  const [overview, backlinks, organic, paid, orgComp, paidComp] = await Promise.all([
    client.domainOverview(domain.domain, country),
    client.domainBacklinks(domain.domain),
    client.domainOrganicKeywords(domain.domain, { database: country, limit: 40 }),
    client.domainPaidKeywords(domain.domain, { database: country, limit: 30 }),
    client.domainOrganicCompetitors(domain.domain, { database: country, limit: 10 }),
    client.domainPaidCompetitors(domain.domain, { database: country, limit: 10 }),
  ])

  await upsertDomain(db, domain.domain, {
    classification: classifySearchDomain(domain.domain),
    estimatedOrganicTraffic: overview?.organicTraffic ?? null,
    estimatedPaidTraffic: overview?.paidTraffic ?? null,
    organicKeywords: overview?.organicKeywords ?? null,
    paidKeywords: overview?.paidKeywords ?? null,
    authorityScore: backlinks?.authorityScore ?? null,
    referringDomains: backlinks?.referringDomains ?? null,
  })
  await db.update(omDomains).set({ overviewFetchedAt: new Date(), reverseMinedAt: new Date(), updatedAt: new Date() }).where(eq(omDomains.id, domainId))

  let adjacent = 0
  for (const row of [...organic, ...paid]) {
    if (!row.keyword) continue
    const child = await upsertKeyword(db, {
      keyword: row.keyword,
      country,
      sourceType: paid.includes(row) ? 'paid_keyword' : 'competitor_keyword',
      sourceId: domain.domain,
      metrics: { ...row, metricsSource: 'semrush' },
    })
    if (child.created) adjacent += 1
    await enqueue(db, {
      jobType: 'discover_keyword',
      priority: 35,
      depth: 1,
      keywordId: child.id,
    })
    const seed = await db
      .select({ id: omKeywords.id })
      .from(omKeywords)
      .where(eq(omKeywords.normalizedKeyword, domain.domain.replace(/\./g, ' ')))
      .limit(1)
    if (seed[0]) {
      await addEdge(db, {
        sourceKeywordId: seed[0].id,
        targetKeywordId: child.id,
        relationType: paid.includes(row) ? 'paid_keyword' : 'competitor_keyword',
        depth: 1,
      })
    }
  }

  for (const comp of [...orgComp, ...paidComp]) {
    const id = await upsertDomain(db, comp.domain, {
      classification: classifySearchDomain(comp.domain),
      estimatedOrganicTraffic: comp.organicTraffic,
    })
    await enqueue(db, { jobType: 'analyze_domain', priority: 30, domainId: id })
  }

  omLog('DOMAIN', [
    `Discovered advertiser: ${domain.domain}`,
    `Paid keywords: ${paid.length.toLocaleString('en-US')}`,
    `Organic keywords: ${organic.length.toLocaleString('en-US')}`,
    `New adjacent markets: ${adjacent.toLocaleString('en-US')}`,
  ])

  return { paid: paid.length, organic: organic.length, adjacent }
}
