import { eq } from 'drizzle-orm'
import {
  expansionPriorityScore,
  extractConcepts,
  seedExpansionsFromConcept,
  shouldDeprioritize,
  trendIsGrowing,
} from '@rnr/core'
import type { Database } from '../db.js'
import { omKeywords } from '../schema.js'
import { liveCallsEnabled } from '../providers/index.js'
import { fetchKeywordIdeas } from '../providers/google-ads/keyword-ideas.js'
import { fetchKeywordVolumes, googleAdsConfigured, GOOGLE_ADS_GEO_US } from '../providers/google-ads/keyword-volume.js'
import { materializeSeeds } from './seeds.js'
import { omLog, recordOmEvent } from './log.js'
import { createSemrushClient, semrushApiKey, type KeywordOverview, type SemrushClient } from './semrush/client.js'
import { addEdge, enqueue, persistConcept, upsertKeyword, upsertMonthlyVolumes } from './store.js'

export interface DiscoverOpts {
  country?: string
  maxDepth?: number
  seedFamily?: string
  firstRunOnly?: boolean
  limit?: number
  live?: boolean
  extraSeeds?: string[]
}

export function omLive(env: NodeJS.ProcessEnv = process.env, flag = false): boolean {
  return flag || env['OM_LIVE'] === 'true' || (liveCallsEnabled(env) && Boolean(semrushApiKey(env) || googleAdsConfigured(env)))
}

export async function seedQueue(db: Database, opts: DiscoverOpts = {}): Promise<{ seeded: number; enqueued: number }> {
  const country = opts.country ?? 'us'
  const families = opts.seedFamily ? [opts.seedFamily] : undefined
  const seeds = materializeSeeds({
    ...(families ? { families } : {}),
    firstRunOnly: opts.firstRunOnly !== false && !families,
    extraConcepts: opts.extraSeeds ?? [],
  })
  const cap = opts.limit ?? seeds.length
  let seeded = 0
  let enqueued = 0
  for (const seed of seeds.slice(0, cap)) {
    const row = await upsertKeyword(db, {
      keyword: seed.keyword,
      country,
      sourceType: 'seed',
      sourceId: seed.pattern,
      expansionPriority: seed.priority,
    })
    if (row.created) seeded += 1
    await enqueue(db, {
      jobType: 'discover_keyword',
      priority: seed.priority,
      depth: 0,
      seedFamily: seed.family,
      keywordId: row.id,
    })
    enqueued += 1
  }
  omLog('DISCOVERY', [`Seeded ${seeded} new keywords`, `Enqueued ${enqueued} discover jobs`])
  return { seeded, enqueued }
}

export async function discoverKeyword(
  db: Database,
  keywordId: number,
  opts: { country?: string; depth?: number; seedFamily?: string | null; live?: boolean; maxDepth?: number } = {},
): Promise<{ found: number; created: number; commercial: number }> {
  const country = opts.country ?? 'us'
  const depth = opts.depth ?? 0
  const maxDepth = opts.maxDepth ?? 3
  const [kw] = await db.select().from(omKeywords).where(eq(omKeywords.id, keywordId)).limit(1)
  if (!kw) return { found: 0, created: 0, commercial: 0 }

  const live = opts.live !== false
  const client = semrushApiKey() && live ? createSemrushClient(db, process.env, true) : null

  let foundRows: KeywordOverview[] = []
  const relationBuckets: Array<{ rows: KeywordOverview[]; relation: 'related' | 'broad' | 'question' | 'google_ads_idea' }> = []

  if (client) {
    const [self, related, broad, questions] = await Promise.all([
      client.keywordOverview(kw.keyword, country),
      client.keywordRelated(kw.keyword, { database: country, limit: 40 }),
      client.keywordBroadMatch(kw.keyword, { database: country, limit: 40 }),
      client.keywordQuestions(kw.keyword, { database: country, limit: 20 }),
    ])
    if (self) {
      await upsertKeyword(db, {
        keyword: kw.keyword,
        country,
        sourceType: kw.sourceType,
        metrics: { ...self, metricsSource: 'semrush' },
      })
    }
    relationBuckets.push({ rows: related, relation: 'related' })
    relationBuckets.push({ rows: broad, relation: 'broad' })
    relationBuckets.push({ rows: questions, relation: 'question' })
    foundRows = [...related, ...broad, ...questions]
  }

  if (live && googleAdsConfigured() && liveCallsEnabled()) {
    try {
      const ideas = await fetchKeywordIdeas([kw.keyword], {
        geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US],
        env: process.env,
      })
      const gads: KeywordOverview[] = ideas.ideas.map((i) => ({
        keyword: i.keyword,
        volume: i.avgMonthlySearches,
        cpc: i.highTopOfPageBidMicros != null ? Number(i.highTopOfPageBidMicros) / 1_000_000 : null,
        competition: i.competitionIndex != null ? i.competitionIndex / 100 : null,
        keywordDifficulty: null,
        intent: 'unknown',
        results: null,
        trend: null,
      }))
      relationBuckets.push({ rows: gads, relation: 'google_ads_idea' })
      foundRows = [...foundRows, ...gads]

      const volumes = await fetchKeywordVolumes([kw.keyword], {
        env: process.env,
        geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US],
        live: true,
      })
      const vol = volumes.rows[0]
      if (vol) {
        await upsertMonthlyVolumes(
          db,
          keywordId,
          vol.monthlySearches.map((m) => ({ year: m.year, month: m.month, volume: m.searchVolume })),
          'google_ads',
        )
        if (kw.volume == null && vol.avgMonthlySearches != null) {
          await upsertKeyword(db, {
            keyword: kw.keyword,
            country,
            sourceType: kw.sourceType,
            metrics: {
              keyword: kw.keyword,
              volume: vol.avgMonthlySearches,
              cpc: vol.highTopOfPageBidMicros != null ? Number(vol.highTopOfPageBidMicros) / 1_000_000 : null,
              competition: vol.competitionIndex != null ? vol.competitionIndex / 100 : null,
              keywordDifficulty: kw.keywordDifficulty,
              intent: kw.intent,
              results: kw.results,
              trend: kw.trend,
              metricsSource: 'google_ads',
            },
          })
        }
      }
    } catch (err) {
      await recordOmEvent(db, {
        channel: 'DISCOVERY',
        message: `Google Ads lookup failed for "${kw.keyword}": ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  let created = 0
  let commercial = 0
  const known = new Set<string>()
  for (const bucket of relationBuckets) {
    for (const row of bucket.rows) {
      if (!row.keyword) continue
      if (shouldDeprioritize(row.keyword, row.intent)) continue
      const child = await upsertKeyword(db, {
        keyword: row.keyword,
        country,
        sourceType: bucket.relation === 'google_ads_idea' ? 'google_ads_idea' : bucket.relation,
        sourceId: String(keywordId),
        metrics: { ...row, metricsSource: bucket.relation === 'google_ads_idea' ? 'google_ads' : 'semrush' },
      })
      if (child.created) created += 1
      await addEdge(db, {
        sourceKeywordId: keywordId,
        targetKeywordId: child.id,
        relationType: bucket.relation,
        depth: depth + 1,
        seedFamily: opts.seedFamily ?? null,
      })
      const concept = extractConcepts(row.keyword)
      if (concept.commercialIntent >= 4 || (row.cpc ?? 0) >= 2 || (row.volume ?? 0) >= 500) commercial += 1
      if (concept.industry) known.add(concept.industry)
      if (concept.persona) known.add(concept.persona)
      if (concept.workflow) known.add(concept.workflow)

      const priority = expansionPriorityScore({
        keyword: row.keyword,
        volume: row.volume,
        cpc: row.cpc,
        intent: row.intent,
        hasAdvertisers: (row.cpc ?? 0) >= 1.5,
        growing: trendIsGrowing(row.trend),
        semanticallyNovel: Boolean(concept.industry || concept.persona || concept.workflow),
        depth: depth + 1,
      })
      await db.update(omKeywords).set({ expansionPriority: priority, updatedAt: new Date() }).where(eq(omKeywords.id, child.id))

      if (depth + 1 < maxDepth && priority >= 25) {
        await enqueue(db, {
          jobType: 'expand_keyword',
          priority,
          depth: depth + 1,
          seedFamily: opts.seedFamily ?? null,
          keywordId: child.id,
        })
      }
    }
  }

  await persistConcept(db, keywordId, kw.keyword)
  const expansions = seedExpansionsFromConcept(extractConcepts(kw.keyword))
  for (const phrase of expansions.slice(0, 12)) {
    const child = await upsertKeyword(db, {
      keyword: phrase,
      country,
      sourceType: 'semantic_expansion',
      sourceId: String(keywordId),
    })
    await addEdge(db, {
      sourceKeywordId: keywordId,
      targetKeywordId: child.id,
      relationType: 'semantic_expansion',
      depth: depth + 1,
      seedFamily: opts.seedFamily ?? null,
    })
    if (child.created && depth + 1 < maxDepth) {
      await enqueue(db, {
        jobType: 'discover_keyword',
        priority: 40,
        depth: depth + 1,
        seedFamily: opts.seedFamily ?? null,
        keywordId: child.id,
      })
    }
  }

  await db.update(omKeywords).set({ expandedAt: new Date(), updatedAt: new Date() }).where(eq(omKeywords.id, keywordId))

  omLog('DISCOVERY', [
    `Seed: ${kw.keyword}`,
    `Found: ${foundRows.length.toLocaleString('en-US')} keywords`,
    `New: ${created.toLocaleString('en-US')}`,
    `Commercial candidates: ${commercial.toLocaleString('en-US')}`,
  ])

  return { found: foundRows.length, created, commercial }
}

export async function expandNamedKeyword(
  db: Database,
  keyword: string,
  opts: DiscoverOpts = {},
): Promise<{ keywordId: number; result: Awaited<ReturnType<typeof discoverKeyword>> }> {
  const country = opts.country ?? 'us'
  const row = await upsertKeyword(db, { keyword, country, sourceType: 'manual' })
  const result = await discoverKeyword(db, row.id, {
    country,
    depth: 0,
    live: opts.live,
    maxDepth: opts.maxDepth ?? 3,
  })
  return { keywordId: row.id, result }
}

export function maybeClient(db: Database, live: boolean): SemrushClient | null {
  if (!live || !semrushApiKey()) return null
  return createSemrushClient(db, process.env, true)
}
