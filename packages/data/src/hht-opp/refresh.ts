import 'server-only'
import { isRefreshDue, refreshIntervalDays } from '@rnr/core'
import type { Database } from '../db.js'
import { hhtOppOpportunities } from '../schema.js'
import { researchHhtOppSeed, type ResearchSeedResult } from './research.js'

export async function listStaleHhtOppOpportunities(db: Database, now = new Date()) {
  const rows = await db.select().from(hhtOppOpportunities).limit(400)
  return rows.filter((row) =>
    isRefreshDue(
      row.lastCheckedAt,
      refreshIntervalDays({
        status: row.status,
        eligibility: row.eligibility,
        priceStatus: row.priceStatus,
        overallScore: row.overallScore,
      }),
      now,
    ),
  )
}

export async function refreshStaleHhtOppOpportunities(
  db: Database,
  options: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ stale: number; refreshed: ResearchSeedResult[] }> {
  const stale = await listStaleHhtOppOpportunities(db)
  const limit = Math.min(options.limit ?? 8, 20)
  const refreshed: ResearchSeedResult[] = []
  const seen = new Set<string>()
  for (const row of stale) {
    if (refreshed.length >= limit || seen.has(row.opportunityUrl)) continue
    seen.add(row.opportunityUrl)
    refreshed.push(
      await researchHhtOppSeed(db, row.opportunityUrl, {
        strategy: row.discoveredByStrategy,
        fetchImpl: options.fetchImpl,
      }),
    )
  }
  return { stale: stale.length, refreshed }
}
