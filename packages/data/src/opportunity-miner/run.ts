import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { omKeywords, omMarkets, omQueue } from '../schema.js'
import { clusterMarkets } from './cluster.js'
import { analyzeDomain, discoverSerpAndAds } from './domains.js'
import { discoverKeyword, seedQueue, type DiscoverOpts } from './discovery.js'
import { narrateMarket } from './llm.js'
import { finishOmRun, omLog, startOmRun, recordOmEvent } from './log.js'
import { enrichMarketPricing } from './pricing.js'
import { scoreAllMarkets } from './score.js'
import { claimNextJobs, finishJob } from './store.js'

export async function runSeed(db: Database, opts: DiscoverOpts = {}) {
  const runId = await startOmRun(db, 'seed')
  try {
    const r = await seedQueue(db, opts)
    await finishOmRun(db, runId, 'done', `${r.enqueued} jobs`)
    return r
  } catch (e) {
    await finishOmRun(db, runId, 'failed', e instanceof Error ? e.message : String(e))
    throw e
  }
}

export async function drainQueue(
  db: Database,
  opts: DiscoverOpts & { jobs?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const runId = await startOmRun(db, 'discover')
  const max = opts.jobs ?? 25
  let processed = 0
  let failed = 0
  for (let i = 0; i < max; i++) {
    const batch = await claimNextJobs(db, 1)
    const job = batch[0]
    if (!job) break
    try {
      if (job.jobType === 'discover_keyword' || job.jobType === 'expand_keyword') {
        if (job.keywordId) {
          await discoverKeyword(db, job.keywordId, {
            country: opts.country ?? 'us',
            depth: job.depth,
            seedFamily: job.seedFamily,
            live: opts.live,
            maxDepth: opts.maxDepth ?? 3,
          })
          if (opts.live) await discoverSerpAndAds(db, job.keywordId, { live: opts.live, country: opts.country })
        }
      } else if (job.jobType === 'analyze_domain' && job.domainId) {
        await analyzeDomain(db, job.domainId, { live: opts.live, country: opts.country })
      } else if (job.jobType === 'cluster') {
        await clusterMarkets(db, opts.country ?? 'us')
      } else if (job.jobType === 'score') {
        await scoreAllMarkets(db)
      } else if (job.jobType === 'enrich_pricing' && job.payload && typeof job.payload['marketId'] === 'number') {
        await enrichMarketPricing(db, job.payload['marketId'] as number, { live: opts.live })
      }
      await finishJob(db, job.id, 'done')
      processed += 1
    } catch (e) {
      failed += 1
      await finishJob(db, job.id, 'failed', e instanceof Error ? e.message : String(e))
    }
  }
  await finishOmRun(db, runId, failed && !processed ? 'failed' : 'done', `${processed} ok / ${failed} failed`)
  return { processed, failed }
}

export async function runDaily(db: Database, opts: DiscoverOpts = {}) {
  omLog('QUEUE', ['Daily discovery job'])
  if ((opts.firstRunOnly ?? true) && opts.live) {
    const pending = await db.select({ id: omQueue.id }).from(omQueue).where(eq(omQueue.status, 'pending')).limit(1)
    if (!pending[0]) await seedQueue(db, { ...opts, firstRunOnly: true, limit: 80 })
  }
  const drained = await drainQueue(db, { ...opts, jobs: opts.limit ?? 20 })
  const clustered = await clusterMarkets(db, opts.country ?? 'us')
  if (opts.live) {
    const markets = await db.select({ id: omMarkets.id }).from(omMarkets)
    for (const m of markets.slice(0, 8)) {
      await enrichMarketPricing(db, m.id, { live: true })
    }
  }
  const scored = await scoreAllMarkets(db)
  await maybeNarrateTop(db)
  return { drained, clustered, scored }
}

async function maybeNarrateTop(db: Database): Promise<void> {
  const { omMarketScores, omOpportunityEconomics, omMarketKeywords } = await import('../schema.js')
  const { desc } = await import('drizzle-orm')
  const top = await db
    .select({ market: omMarkets, scores: omMarketScores, economics: omOpportunityEconomics })
    .from(omMarkets)
    .leftJoin(omMarketScores, eq(omMarketScores.marketId, omMarkets.id))
    .leftJoin(omOpportunityEconomics, eq(omOpportunityEconomics.marketId, omMarkets.id))
    .orderBy(desc(omMarketScores.totalScore))
    .limit(8)
  for (const row of top) {
    if (row.market.thesis) continue
    const mk = await db.select().from(omMarketKeywords).where(eq(omMarketKeywords.marketId, row.market.id))
    const kws = []
    if (mk.length) {
      const { inArray } = await import('drizzle-orm')
      kws.push(
        ...(await db.select().from(omKeywords).where(inArray(omKeywords.id, mk.map((r) => r.keywordId)))),
      )
    }
    try {
      const narrative = await narrateMarket({
        keywords: kws.map((k) => k.keyword),
        nameHint: row.market.name,
        volume: row.market.adjustedVolume,
        cpc: row.market.weightedCpc,
        kd: row.market.medianKd,
        advertisers: row.market.uniqueAdvertisers,
        price: row.economics?.observedMedianPrice ?? null,
        buyer: row.market.buyerType,
        discoveryPath: row.market.discoveryPath,
      })
      if (!narrative) continue
      await db
        .update(omMarkets)
        .set({
          name: narrative.name || row.market.name,
          thesis: narrative.thesis,
          likelyCustomer: narrative.customer || row.market.likelyCustomer,
          businessIdea: narrative.businessIdea,
          risks: narrative.risks,
          expansionNotes: narrative.expansion,
          discoveryPath: narrative.discoveryPath || row.market.discoveryPath,
          llmConfidence: 'weakly_inferred',
          updatedAt: new Date(),
        })
        .where(eq(omMarkets.id, row.market.id))
    } catch (e) {
      await recordOmEvent(db, {
        channel: 'LLM',
        message: `Narrative skipped: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
}
