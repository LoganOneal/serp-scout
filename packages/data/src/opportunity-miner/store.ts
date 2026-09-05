import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  extractConcepts,
  hostFromDomain,
  normalizeKeyword,
  type KeywordIntent,
  type KeywordRelationType,
  type KeywordSourceType,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  omDomains,
  omKeywordConcepts,
  omKeywordEdges,
  omKeywordMonthlyVolume,
  omKeywords,
  omQueue,
} from '../schema.js'
import type { KeywordOverview } from './semrush/client.js'

export async function upsertKeyword(
  db: Database,
  args: {
    keyword: string
    country?: string
    sourceType: KeywordSourceType
    sourceId?: string | null
    metrics?: Partial<KeywordOverview> & { metricsSource?: string }
    expansionPriority?: number | null
  },
): Promise<{ id: number; created: boolean }> {
  const country = args.country ?? 'us'
  const normalized = normalizeKeyword(args.keyword)
  const existing = await db
    .select({ id: omKeywords.id })
    .from(omKeywords)
    .where(and(eq(omKeywords.normalizedKeyword, normalized), eq(omKeywords.country, country)))
    .limit(1)

  const metrics = args.metrics
  if (existing[0]) {
    if (metrics) {
      await db
        .update(omKeywords)
        .set({
          volume: metrics.volume ?? undefined,
          cpc: metrics.cpc ?? undefined,
          competition: metrics.competition ?? undefined,
          keywordDifficulty: metrics.keywordDifficulty ?? undefined,
          intent: metrics.intent ?? undefined,
          results: metrics.results ?? undefined,
          trend: metrics.trend ?? undefined,
          metricsSource: metrics.metricsSource ?? 'semrush',
          metricsFetchedAt: new Date(),
          expansionPriority: args.expansionPriority ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(omKeywords.id, existing[0].id))
    } else if (args.expansionPriority != null) {
      await db
        .update(omKeywords)
        .set({ expansionPriority: args.expansionPriority, updatedAt: new Date() })
        .where(eq(omKeywords.id, existing[0].id))
    }
    return { id: existing[0].id, created: false }
  }

  const rows = await db
    .insert(omKeywords)
    .values({
      keyword: args.keyword,
      normalizedKeyword: normalized,
      country,
      sourceType: args.sourceType,
      sourceId: args.sourceId ?? null,
      volume: metrics?.volume ?? null,
      cpc: metrics?.cpc ?? null,
      competition: metrics?.competition ?? null,
      keywordDifficulty: metrics?.keywordDifficulty ?? null,
      intent: (metrics?.intent ?? 'unknown') as KeywordIntent,
      results: metrics?.results ?? null,
      trend: metrics?.trend ?? null,
      metricsSource: metrics?.metricsSource ?? 'unknown',
      metricsFetchedAt: metrics ? new Date() : null,
      expansionPriority: args.expansionPriority ?? null,
    })
    .returning({ id: omKeywords.id })

  const id = rows[0]!.id
  await persistConcept(db, id, args.keyword)
  return { id, created: true }
}

export async function persistConcept(db: Database, keywordId: number, keyword: string): Promise<void> {
  const c = extractConcepts(keyword)
  await db
    .insert(omKeywordConcepts)
    .values({
      keywordId,
      workflow: c.workflow,
      industry: c.industry,
      persona: c.persona,
      object: c.object,
      productArchetype: c.productArchetype,
      commercialIntent: c.commercialIntent,
      recurringUsageLikelihood: c.recurringUsageLikelihood,
      confidence: c.confidence,
      source: 'rules',
    })
    .onConflictDoUpdate({
      target: omKeywordConcepts.keywordId,
      set: {
        workflow: c.workflow,
        industry: c.industry,
        persona: c.persona,
        object: c.object,
        productArchetype: c.productArchetype,
        commercialIntent: c.commercialIntent,
        recurringUsageLikelihood: c.recurringUsageLikelihood,
        confidence: c.confidence,
        updatedAt: new Date(),
      },
    })
}

export async function addEdge(
  db: Database,
  args: {
    sourceKeywordId: number
    targetKeywordId: number
    relationType: KeywordRelationType
    depth: number
    seedFamily?: string | null
  },
): Promise<void> {
  if (args.sourceKeywordId === args.targetKeywordId) return
  await db
    .insert(omKeywordEdges)
    .values({
      sourceKeywordId: args.sourceKeywordId,
      targetKeywordId: args.targetKeywordId,
      relationType: args.relationType,
      depth: args.depth,
      seedFamily: args.seedFamily ?? null,
    })
    .onConflictDoNothing()
}

export async function upsertMonthlyVolumes(
  db: Database,
  keywordId: number,
  series: Array<{ year: number; month: number; volume: number }>,
  source: string,
): Promise<void> {
  if (series.length === 0) return
  await db
    .insert(omKeywordMonthlyVolume)
    .values(series.map((s) => ({ keywordId, year: s.year, month: s.month, volume: s.volume, source })))
    .onConflictDoUpdate({
      target: [omKeywordMonthlyVolume.keywordId, omKeywordMonthlyVolume.year, omKeywordMonthlyVolume.month, omKeywordMonthlyVolume.source],
      set: { volume: sql`excluded.volume` },
    })
}

export async function upsertDomain(
  db: Database,
  domain: string,
  extra?: {
    authorityScore?: number | null
    estimatedOrganicTraffic?: number | null
    estimatedPaidTraffic?: number | null
    referringDomains?: number | null
    classification?: string
    organicKeywords?: number | null
    paidKeywords?: number | null
  },
): Promise<number> {
  const host = hostFromDomain(domain)
  const existing = await db.select({ id: omDomains.id }).from(omDomains).where(eq(omDomains.domain, host)).limit(1)
  if (existing[0]) {
    if (extra) {
      await db
        .update(omDomains)
        .set({
          authorityScore: extra.authorityScore ?? undefined,
          estimatedOrganicTraffic: extra.estimatedOrganicTraffic ?? undefined,
          estimatedPaidTraffic: extra.estimatedPaidTraffic ?? undefined,
          referringDomains: extra.referringDomains ?? undefined,
          classification: extra.classification as never,
          organicKeywords: extra.organicKeywords ?? undefined,
          paidKeywords: extra.paidKeywords ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(omDomains.id, existing[0].id))
    }
    return existing[0].id
  }
  const rows = await db
    .insert(omDomains)
    .values({
      domain: host,
      authorityScore: extra?.authorityScore ?? null,
      estimatedOrganicTraffic: extra?.estimatedOrganicTraffic ?? null,
      estimatedPaidTraffic: extra?.estimatedPaidTraffic ?? null,
      referringDomains: extra?.referringDomains ?? null,
      classification: (extra?.classification ?? 'unknown') as never,
      organicKeywords: extra?.organicKeywords ?? null,
      paidKeywords: extra?.paidKeywords ?? null,
    })
    .returning({ id: omDomains.id })
  return rows[0]!.id
}

export async function enqueue(
  db: Database,
  args: {
    jobType: 'discover_keyword' | 'expand_keyword' | 'analyze_domain' | 'cluster' | 'score' | 'enrich_pricing'
    priority: number
    depth?: number
    seedFamily?: string | null
    keywordId?: number | null
    domainId?: number | null
    payload?: Record<string, unknown>
  },
): Promise<void> {
  const dup = await db
    .select({ id: omQueue.id })
    .from(omQueue)
    .where(
      and(
        eq(omQueue.jobType, args.jobType),
        eq(omQueue.status, 'pending'),
        args.keywordId ? eq(omQueue.keywordId, args.keywordId) : sql`${omQueue.keywordId} is null`,
        args.domainId ? eq(omQueue.domainId, args.domainId) : sql`${omQueue.domainId} is null`,
      ),
    )
    .limit(1)
  if (dup[0]) return
  await db.insert(omQueue).values({
    jobType: args.jobType,
    priority: args.priority,
    depth: args.depth ?? 0,
    seedFamily: args.seedFamily ?? null,
    keywordId: args.keywordId ?? null,
    domainId: args.domainId ?? null,
    payload: args.payload ?? {},
  })
}

export async function claimNextJobs(db: Database, limit: number) {
  const rows = await db
    .select()
    .from(omQueue)
    .where(eq(omQueue.status, 'pending'))
    .orderBy(desc(omQueue.priority), omQueue.id)
    .limit(limit)
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  await db
    .update(omQueue)
    .set({ status: 'running', claimedAt: new Date(), attempts: sql`${omQueue.attempts} + 1` })
    .where(inArray(omQueue.id, ids))
  return rows
}

export async function finishJob(db: Database, id: number, status: 'done' | 'failed' | 'skipped', error?: string): Promise<void> {
  await db
    .update(omQueue)
    .set({ status, finishedAt: new Date(), error: error ?? null })
    .where(eq(omQueue.id, id))
}

export async function findKeywordId(db: Database, keyword: string, country = 'us'): Promise<number | null> {
  const rows = await db
    .select({ id: omKeywords.id })
    .from(omKeywords)
    .where(and(eq(omKeywords.normalizedKeyword, normalizeKeyword(keyword)), eq(omKeywords.country, country)))
    .limit(1)
  return rows[0]?.id ?? null
}
