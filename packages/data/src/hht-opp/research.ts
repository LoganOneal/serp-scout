import 'server-only'
import {
  classifyCorporateEligibility,
  classifyLinkType,
  classifyOpportunityTypes,
  classifySeoRisk,
  classifySpam,
  collapseClassifiedOpportunities,
  defaultPitchAngle,
  extractContacts,
  extractPricing,
  extractRequirements,
  HHT_OPP_SINGLETON_TYPES,
  HHT_SITE_DOMAIN,
  looksLikeOpportunityPath,
  normalizeHhtBlUrl,
  pickPrimaryContact,
  registrableDomain,
  scoreOpportunity,
  summarizeRequirements,
  topicalRelevanceFor,
  type HhtOppStrategy,
  type HhtOppType,
} from '@rnr/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppDomains, hhtOppOpportunities } from '../schema.js'
import { commonPathUrls, crawlHhtOppPage, HHT_OPP_CRAWL, type HhtOppCrawlResult } from './crawl.js'
import { getHhtOppScoreWeights } from './settings.js'
import {
  findOpportunity,
  findOpportunityByType,
  replaceOpportunityChildren,
  saveCrawledPage,
  upsertHhtOppDomain,
} from './store.js'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface ResearchSeedResult {
  domain: string
  domainId: number
  pagesCrawled: number
  opportunities: number
  created: number
  updated: number
  error: string | null
}

export async function researchHhtOppSeed(
  db: Database,
  rawUrl: string,
  options: {
    strategy?: HhtOppStrategy
    fetchImpl?: typeof fetch
    maxPages?: number
  } = {},
): Promise<ResearchSeedResult> {
  const seedUrl = normalizeHhtBlUrl(rawUrl) ?? rawUrl.trim()
  const root = registrableDomain(seedUrl)?.domain
  if (!root) throw new Error(`Not a usable URL: ${rawUrl}`)
  if (root === HHT_SITE_DOMAIN) {
    return { domain: root, domainId: 0, pagesCrawled: 0, opportunities: 0, created: 0, updated: 0, error: 'Refusing to research HotelHotTubs.com itself.' }
  }

  const { id: domainId } = await upsertHhtOppDomain(db, seedUrl)
  const maxPages = options.maxPages ?? HHT_OPP_CRAWL.maxRelatedPages + 1
  const seen = new Set<string>()
  const pages: HhtOppCrawlResult[] = []
  const queue = [seedUrl, ...commonPathUrls(seedUrl)]

  for (const url of queue) {
    if (pages.length >= maxPages) break
    const normalized = normalizeHhtBlUrl(url) ?? url
    if (seen.has(normalized)) continue
    if (registrableDomain(normalized)?.domain !== root) continue
    seen.add(normalized)

    const page = await crawlHhtOppPage(normalized, { fetchImpl: options.fetchImpl })
    pages.push(page)
    await saveCrawledPage(db, domainId, page)
    if (page.relatedUrls.length) queue.push(...page.relatedUrls)
    await wait(HHT_OPP_CRAWL.perDomainDelayMs)
  }

  const usable = pages.filter((page) => page.pageText && !page.error)
  const classifiable = pages.length > 0 ? pages : []
  if (usable.length === 0 && classifiable.every((page) => !looksLikeOpportunityPath(page.url))) {
    await db
      .update(hhtOppDomains)
      .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(hhtOppDomains.id, domainId))
    return {
      domain: root,
      domainId,
      pagesCrawled: pages.length,
      opportunities: 0,
      created: 0,
      updated: 0,
      error: pages[0]?.error ?? 'No pages returned text.',
    }
  }

  const combinedText = usable.map((page) => `${page.title ?? ''}\n${page.pageText}`).join('\n')
  const outbound = summarizeOutbound(usable)
  const spam = classifySpam({
    title: usable[0]?.title ?? null,
    text: combinedText.slice(0, 20_000),
    avgExternalLinks: outbound.avgExternal,
    uniqueExternalDomains: outbound.uniqueExternal,
    organicTraffic: null,
    authorityScore: null,
    hasAuthor: /byline|written by|author/i.test(combinedText),
    paidLinkLanguageCount: (combinedText.match(/sponsored|paid guest|link insertion|buy .*link/gi) ?? []).length,
  })

  await db
    .update(hhtOppDomains)
    .set({
      displayName: usable[0]?.title ?? root,
      canonicalUrl: `https://${root}`,
      quality: spam.quality,
      qualityReasons: spam.reasons,
      avgExternalLinks: outbound.avgExternal,
      uniqueExternalDomains: outbound.uniqueExternal,
      avgInternalLinks: outbound.avgInternal,
      externalToInternalRatio: outbound.ratio,
      commercialLinkDensity: outbound.commercialDensity,
      outboundSampleSize: usable.length,
      alreadyLinksToHht: usable.some((page) => page.linksToHht),
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(hhtOppDomains.id, domainId))

  const classified: Array<{
    type: HhtOppType
    url: string
    why: string
    inventedType: Record<string, string> | null
  }> = []
  const seenOpp = new Set<string>()
  for (const page of pages) {
    const isSeed = page.url === seedUrl || page.finalUrl === seedUrl
    if (page.error && !isSeed) continue
    const pageUrls = [...new Set([page.url, page.finalUrl].filter((url): url is string => Boolean(url)))]
    const types = pageUrls.flatMap((url) =>
      classifyOpportunityTypes({
        url,
        title: page.title,
        text: page.pageText ?? '',
        html: page.rawHtml,
      }),
    )
    for (const row of types) {
      if (row.type === 'unlinked_mention' && page.linksToHht) continue
      const key = `${row.type}:${row.opportunityUrl}`
      if (seenOpp.has(key)) continue
      seenOpp.add(key)
      classified.push({
        type: row.type,
        url: row.opportunityUrl,
        why: row.why,
        inventedType: row.inventedType
          ? {
              name: row.inventedType.name,
              definition: row.inventedType.definition,
              whyBacklink: row.inventedType.whyBacklink,
              discoveryMethod: row.inventedType.discoveryMethod,
              outreachMethod: row.inventedType.outreachMethod,
            }
          : null,
      })
    }
  }

  const collapsed = collapseClassifiedOpportunities(classified, { seedUrl })
  classified.length = 0
  classified.push(...collapsed)

  if (classified.length === 0) {
    classified.push({
      type: 'other',
      url: usable[0]?.finalUrl ?? pages[0]?.finalUrl ?? seedUrl,
      why: 'Seeded domain with no explicit contribution, advertising, or resource language. Kept for human review.',
      inventedType: {
        name: 'Unclassified publisher review',
        definition: 'A travel-adjacent domain that was seeded but did not match a known opportunity pattern.',
        whyBacklink: 'The site may still have a partnership, resource, or citation path that was not labeled in crawled copy.',
        discoveryMethod: 'manual_seed',
        outreachMethod: 'Human review of about/contact/advertise pages before outreach.',
      },
    })
  }

  const weights = await getHhtOppScoreWeights(db)
  let created = 0
  let updated = 0

  for (const item of classified) {
    const page =
      usable.find((row) => (row.finalUrl ?? row.url) === item.url) ??
      pages.find((row) => row.url === item.url || row.finalUrl === item.url) ??
      usable[0] ??
      pages[0]
    const text = `${page?.title ?? ''}\n${page?.pageText ?? ''}`
    const eligibility = classifyCorporateEligibility(item.url, text)
    const link = classifyLinkType(text)
    const risk = classifySeoRisk({
      text,
      title: page?.title ?? null,
      outboundCommercialDensity: outbound.commercialDensity,
    })
    const price = extractPricing(item.url, text)
    const requirements = extractRequirements(item.url, text)
    const contacts = extractContacts(item.url, text, page?.rawHtml)
    const topical = topicalRelevanceFor(item.type, combinedText)
    const scores = scoreOpportunity({
      feasibility: {
        eligibility: eligibility.eligibility,
        hasSubmissionRoute: Boolean(pickPrimaryContact(contacts) || /submit|pitch|form|email/i.test(text)),
        linkType: link.linkType,
        topicalFit: topical,
        pitchClarity: requirements.length > 0 ? 70 : 35,
        evidenceConfidence: eligibility.confidence === 'HIGH' ? 85 : eligibility.confidence === 'MEDIUM' ? 55 : 25,
        freshnessDays: 0,
        mentionPriority: item.type === 'unlinked_mention',
      },
      seo: {
        authorityScore: null,
        referringDomains: null,
        organicTraffic: null,
        topicalRelevance: topical,
        usTrafficShare: null,
        linkType: link.linkType,
        avgExternalLinks: outbound.avgExternal,
        seoRisk: risk.risk,
        quality: spam.quality,
      },
      cost: {
        priceAmount: price.amount,
        seoValue: 0,
        isPaid: price.status === 'FIXED' || price.status === 'QUOTE_REQUIRED',
      },
      editorial: {
        hasAuthors: /author|byline|written by/i.test(combinedText),
        hasDates: /\b(20\d{2}|updated|published)\b/i.test(combinedText),
        avgExternalLinks: outbound.avgExternal,
        quality: spam.quality,
      },
      freshnessDays: 0,
      weights,
    })

    const status: typeof hhtOppOpportunities.$inferInsert['status'] =
      eligibility.eligibility === 'PASS' ? 'PASS' : eligibility.eligibility === 'FAIL' ? 'FAIL' : 'REVIEW'
    const relevantArticle =
      item.type === 'existing_article' || item.type === 'paid_link_insertion' || item.type === 'resource_page'
        ? item.url
        : null

    const values = {
      domainId,
      opportunityType: item.type,
      inventedType: item.inventedType,
      opportunityUrl: item.url,
      status,
      eligibility: eligibility.eligibility,
      eligibilityReason: eligibility.reason,
      eligibilityConfidence: eligibility.confidence,
      eligibilitySourceUrl: eligibility.evidence?.sourceUrl ?? null,
      eligibilityExcerpt: eligibility.evidence?.sourceExcerpt ?? null,
      eligibilityCheckedAt: new Date(),
      linkType: link.linkType,
      seoRisk: risk.risk,
      seoRiskReasons: risk.reasons,
      priceStatus: price.status,
      priceAmount: price.amount,
      priceCurrency: price.currency,
      pricingModel: price.pricingModel,
      priceEvidenceUrl: price.evidence?.sourceUrl ?? null,
      priceEvidenceText: price.evidence?.sourceExcerpt ?? null,
      priceCheckedAt: price.evidence ? new Date() : null,
      requirementsSummary: summarizeRequirements(requirements),
      whyItMatters: item.why,
      pitchAngle: defaultPitchAngle(item.type),
      relevantArticleUrl: relevantArticle,
      discoveredByStrategy: options.strategy ?? 'manual_seed',
      feasibilityScore: scores.feasibility,
      seoValueScore: scores.seoValue,
      topicalRelevanceScore: scores.topicalRelevance,
      editorialQualityScore: scores.editorialQuality,
      costEfficiencyScore: scores.costEfficiency,
      freshnessScore: scores.freshness,
      overallScore: scores.overall,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    }

    const existingId = HHT_OPP_SINGLETON_TYPES.has(item.type)
      ? ((await findOpportunityByType(db, domainId, item.type)) ?? (await findOpportunity(db, domainId, item.type, item.url)))
      : await findOpportunity(db, domainId, item.type, item.url)
    let opportunityId: number
    if (existingId) {
      const previous = await db
        .select({
          eligibilityExcerpt: hhtOppOpportunities.eligibilityExcerpt,
          priceEvidenceText: hhtOppOpportunities.priceEvidenceText,
        })
        .from(hhtOppOpportunities)
        .where(eq(hhtOppOpportunities.id, existingId))
        .limit(1)
      const changed =
        (previous[0]?.eligibilityExcerpt && previous[0].eligibilityExcerpt !== values.eligibilityExcerpt) ||
        (previous[0]?.priceEvidenceText && previous[0].priceEvidenceText !== values.priceEvidenceText)
      await db
        .update(hhtOppOpportunities)
        .set({ ...values, requirementsChanged: Boolean(changed) })
        .where(eq(hhtOppOpportunities.id, existingId))
      opportunityId = existingId
      updated += 1
    } else {
      const inserted = await db.insert(hhtOppOpportunities).values(values).returning({ id: hhtOppOpportunities.id })
      opportunityId = inserted[0]!.id
      created += 1
    }

    await replaceOpportunityChildren(db, opportunityId, {
      requirements: requirements.map((row) => ({
        groupName: row.group,
        label: row.label,
        requirementText: row.requirementText,
        sourceUrl: row.sourceUrl,
        sourceExcerpt: row.sourceExcerpt,
        dateChecked: new Date(row.dateChecked),
        confidence: row.confidence,
      })),
      sources: usable.map((row) => ({
        url: row.finalUrl ?? row.url,
        title: row.title,
        role: (row.finalUrl ?? row.url) === item.url ? 'opportunity_page' : 'supporting_page',
        excerpt: (row.pageText ?? '').slice(0, 280),
      })),
      pricing:
        price.evidence || price.status !== 'UNKNOWN'
          ? [
              {
                label: price.status === 'FIXED' ? 'Public price' : price.status,
                amount: price.amount,
                currency: price.currency,
                pricingModel: price.pricingModel,
                included: price.included,
                linkAttribute: link.linkType,
                evidenceUrl: price.evidence?.sourceUrl ?? item.url,
                evidenceText: price.evidence?.sourceExcerpt ?? null,
              },
            ]
          : [],
      contacts: contacts.map((row) => ({
        email: row.email,
        name: row.name,
        role: row.role,
        formUrl: row.formUrl,
        status: row.status,
        sourceUrl: row.sourceUrl,
        sourceExcerpt: row.sourceExcerpt,
      })),
    })
  }

  return {
    domain: root,
    domainId,
    pagesCrawled: pages.length,
    opportunities: classified.length,
    created,
    updated,
    error: null,
  }
}

export async function researchHhtOppSeeds(
  db: Database,
  urls: string[],
  options: { strategy?: HhtOppStrategy; fetchImpl?: typeof fetch } = {},
): Promise<ResearchSeedResult[]> {
  const results: ResearchSeedResult[] = []
  for (const url of urls) {
    results.push(await researchHhtOppSeed(db, url, options))
  }
  return results
}

function summarizeOutbound(pages: HhtOppCrawlResult[]) {
  const samples = pages.map((page) => page.outbound).filter((row): row is NonNullable<typeof row> => Boolean(row))
  const n = samples.length || 1
  const avgExternal = samples.reduce((sum, row) => sum + row.externalLinks, 0) / n
  const avgInternal = samples.reduce((sum, row) => sum + row.internalLinks, 0) / n
  let commercial = 0
  let external = 0
  for (const page of pages) {
    if (!page.outbound) continue
    commercial += page.outbound.commercialLinks
    external += page.outbound.externalLinks
  }
  return {
    avgExternal,
    avgInternal,
    uniqueExternal: samples.reduce((sum, row) => sum + row.uniqueExternalDomains, 0),
    ratio: avgInternal > 0 ? avgExternal / avgInternal : avgExternal,
    commercialDensity: external > 0 ? commercial / external : 0,
  }
}
