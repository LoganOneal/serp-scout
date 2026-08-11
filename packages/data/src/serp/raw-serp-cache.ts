import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { discoveryJobs, discoverySerpMetrics } from '../schema.js'

/**
 * Reuse a SERP this project already bought.
 *
 * ==================== NO NEW TABLE, ON PURPOSE ====================
 * `discovery_jobs.raw_items` already holds the complete raw payload of every
 * completed sweep SERP, keyed by keyword + location + device on the job row.
 * That IS the cache; it simply was never read. The scan pipeline has
 * `serp_snapshots`, but that stores only the normalised organic snapshot, which
 * would throw away everything the layout metrics and winnability scoring need.
 *
 * Measured before this existed: 5.6% of purchased SERPs were repeats of a cell
 * already owned, two of them bought the same day. That is small today and grows
 * with every overlapping market swept.
 * ==================================================================
 */

/**
 * How long a page-1 SERP stays good enough to screen from.
 *
 * Deliberately shorter than the scan pipeline's 45-day snapshot TTL: this feeds
 * a "who holds the slots" judgement, and a month-old page can have a different
 * top five. Two weeks keeps a re-sweep of last week's market free while still
 * re-buying anything that has had time to move.
 */
export const RAW_SERP_TTL_DAYS = 14

export interface RawSerpCacheHit {
  rawItems: Array<Record<string, unknown>>
  jobId: number
  ageDays: number
}

/**
 * The newest usable raw SERP for this exact cell, or null.
 *
 * Matched on keyword + location + device + depth. Depth matters: a depth-10 job
 * cannot serve a request that wanted 100 results, and silently returning the
 * short one would under-report every defender below position 10.
 */
export async function findCachedRawSerp(
  db: Database,
  args: {
    keyword: string
    locationCode: number
    device: string
    depth: number
    ttlDays?: number
  },
): Promise<RawSerpCacheHit | null> {
  const ttl = args.ttlDays ?? RAW_SERP_TTL_DAYS
  const keyword = args.keyword.trim()
  if (!keyword) return null

  /**
   * Joined through the metrics row because the location code lives there, not
   * on the job -- a job only knows its geo id, and two geo rows can resolve to
   * the same Google location.
   */
  const rows = await db
    .select({
      id: discoveryJobs.id,
      rawItems: discoveryJobs.rawItems,
      finishedAt: discoveryJobs.finishedAt,
    })
    .from(discoverySerpMetrics)
    .innerJoin(discoveryJobs, eq(discoveryJobs.id, discoverySerpMetrics.jobId))
    .where(
      and(
        eq(discoveryJobs.status, 'done'),
        eq(discoverySerpMetrics.keyword, keyword),
        eq(discoverySerpMetrics.locationCode, args.locationCode),
        eq(discoverySerpMetrics.device, args.device),
        eq(discoveryJobs.depth, args.depth),
        sql`${discoveryJobs.rawItems} IS NOT NULL`,
        sql`${discoveryJobs.finishedAt} > now() - (${ttl} || ' days')::interval`,
      ),
    )
    .orderBy(desc(discoveryJobs.finishedAt))
    .limit(1)

  const row = rows[0]
  if (!row?.rawItems || row.rawItems.length === 0) return null

  const ageDays = row.finishedAt
    ? Math.floor((Date.now() - new Date(row.finishedAt).getTime()) / 86_400_000)
    : 0

  return { rawItems: row.rawItems, jobId: row.id, ageDays }
}
