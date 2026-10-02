import { and, eq, gte, sql } from 'drizzle-orm'
import type { EngineDatabase } from './db.js'
import { sendNotification } from './run-job.js'
import {
  hhtEngineCrmOutbox,
  hhtEngineDomains,
  hhtEngineGoogleAdsUsage,
  hhtEngineJobs,
  hhtEngineKeywords,
  hhtEngineNotifications,
  hhtEngineOpportunities,
  hhtEngineRuns,
  hhtEngineSemrushUsage,
  hhtEngineSerpScans,
  hhtEngineSystemState,
} from './schema.js'

export async function maybeSendDailyDigest(db: EngineDatabase, now = new Date()): Promise<boolean> {
  const eastern = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(eastern.find((part) => part.type === 'hour')?.value ?? -1)
  if (hour !== 8) return false
  const since = new Date(now.getTime() - 24 * 60 * 60_000)
  const [already] = await db.select().from(hhtEngineNotifications).where(and(
    eq(hhtEngineNotifications.eventType, 'daily_digest'),
    gte(hhtEngineNotifications.createdAt, since),
  )).limit(1)
  if (already) return false
  const [
    semrush,
    gads,
    keywords,
    serps,
    domains,
    opportunities,
    outbox,
    review,
    dead,
    runs,
    stateRows,
  ] = await Promise.all([
    countSum(db, hhtEngineSemrushUsage, hhtEngineSemrushUsage.createdAt, hhtEngineSemrushUsage.units),
    countRows(db, hhtEngineGoogleAdsUsage, hhtEngineGoogleAdsUsage.createdAt, since),
    countRows(db, hhtEngineKeywords, hhtEngineKeywords.createdAt, since),
    countRows(db, hhtEngineSerpScans, hhtEngineSerpScans.observedAt, since),
    countRows(db, hhtEngineDomains, hhtEngineDomains.firstDiscoveredAt, since),
    db.select({
      type: hhtEngineOpportunities.type,
      count: sql<number>`count(*)`,
    }).from(hhtEngineOpportunities)
      .where(gte(hhtEngineOpportunities.discoveredAt, since))
      .groupBy(hhtEngineOpportunities.type),
    countRows(db, hhtEngineCrmOutbox, hhtEngineCrmOutbox.createdAt, since),
    db.select({ count: sql<number>`count(*)` }).from(hhtEngineOpportunities)
      .where(eq(hhtEngineOpportunities.filterStatus, 'REVIEW')),
    db.select({ count: sql<number>`count(*)` }).from(hhtEngineJobs)
      .where(eq(hhtEngineJobs.status, 'dead')),
    db.select({
      total: sql<number>`count(*)`,
      success: sql<number>`count(*) filter (where ${hhtEngineRuns.status} = 'success')`,
    }).from(hhtEngineRuns).where(gte(hhtEngineRuns.startedAt, since)),
    db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1)),
  ])
  const state = stateRows[0]
  const runCounts = runs[0]
  const body = [
    'HHT backlink engine — last 24 hours',
    `Semrush units used: ${semrush}; remaining: ${state?.semrushRemainingUnits ?? 'unavailable'}`,
    `Google Ads calls: ${gads}`,
    `New keywords: ${keywords}`,
    `SERP pulls: ${serps}`,
    `New domains: ${domains}`,
    `Opportunities: ${opportunities.map((row) => `${row.type}=${Number(row.count)}`).join(', ') || 'none'}`,
    `Outbox rows added: ${outbox}`,
    `REVIEW leads: ${Number(review[0]?.count ?? 0)}`,
    `Dead-letter jobs: ${Number(dead[0]?.count ?? 0)}`,
    `Run success rate: ${Number(runCounts?.success ?? 0)}/${Number(runCounts?.total ?? 0)}`,
  ].join('\n')
  await sendNotification(db, body, {
    subject: 'HHT engine: daily digest',
    eventType: 'daily_digest',
  })
  return true
}

async function countRows(
  db: EngineDatabase,
  table: Parameters<EngineDatabase['select']>[0] extends never ? never : any,
  column: any,
  since: Date,
): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(table).where(gte(column, since))
  return Number(rows[0]?.count ?? 0)
}

async function countSum(
  db: EngineDatabase,
  table: Parameters<EngineDatabase['select']>[0] extends never ? never : any,
  createdAt: any,
  units: any,
): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const rows = await db.select({ total: sql<number>`coalesce(sum(${units}), 0)` }).from(table).where(gte(createdAt, since))
  return Number(rows[0]?.total ?? 0)
}
