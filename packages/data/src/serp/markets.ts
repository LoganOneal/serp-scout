import 'server-only'
import { desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { localities, niches, scanTargets, shortlistItems, sites } from '../schema.js'
import { countRegressions } from './targets.js'
import { getSiteRealisedValue } from '../voice/outcomes.js'

/**
 * The unified markets list: one row per targeted cell, research and revenue side by side.
 *
 * This is the view the split between /shortlist and /sites made impossible -- the frozen
 * prediction and the realised result were on different pages, so the one comparison the whole
 * system exists to make was never on screen together.
 */
export interface MarketRow {
  siteId: number
  localitySlug: string
  localityName: string
  stateCode: string
  nicheSlug: string
  nicheLabel: string
  domain: string | null
  status: string
  firstWebhookAt: Date | null
  trackingNumber: string | null
  /** Frozen at shortlist time. NULL when the cell was targeted without a scan. */
  difficultyAtSave: number | null
  verdictAtSave: string | null
  /** Modelled monthly rent from the scan behind the shortlist row, micros as a string. */
  modelledRentMicros: string | null
  calls30d: number
  leads30d: number
  /** NULL below the minimum sample, never 0 -- see closeRate. */
  closeRate: number | null
  realisedMonthlyMicros: string | null
  keywords: number
  serpTargets: number
  regressions: number
}

const THIRTY = sql`now() - interval '30 days'`

export async function listMarkets(db: Database): Promise<MarketRow[]> {
  const rows = await db
    .select({
      siteId: sites.id,
      localitySlug: localities.slug,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheSlug: niches.slug,
      nicheLabel: niches.label,
      domain: sites.domain,
      status: sites.status,
      firstWebhookAt: sites.firstWebhookAt,
      trackingNumber: sites.trackingNumber,
      difficultyAtSave: shortlistItems.difficultyAtSave,
      verdictAtSave: shortlistItems.verdictAtSave,
      modelledRentMicros: scanTargets.rentMicros,
      calls30d: sql<number>`(
        SELECT count(*)::int FROM calls WHERE calls.site_id = ${sites}.id AND calls.created_at >= ${THIRTY}
      )`,
      leads30d: sql<number>`(
        SELECT count(*)::int FROM leads WHERE leads.site_id = ${sites}.id AND leads.created_at >= ${THIRTY}
      )`,
      keywords: sql<number>`(
        SELECT count(*)::int FROM serp_keywords WHERE serp_keywords.site_id = ${sites}.id
      )`,
      serpTargets: sql<number>`(
        SELECT count(*)::int FROM serp_targets t
          JOIN serp_keywords k ON k.id = t.keyword_id
         WHERE k.site_id = ${sites}.id AND t.active
      )`,
    })
    .from(sites)
    .innerJoin(localities, eq(sites.localityId, localities.id))
    .innerJoin(niches, eq(sites.nicheId, niches.id))
    .leftJoin(shortlistItems, eq(sites.shortlistItemId, shortlistItems.id))
    .leftJoin(scanTargets, eq(shortlistItems.scanTargetId, scanTargets.id))
    .where(sql`${sites.status} <> 'dropped'`)
    .orderBy(desc(sites.createdAt))

  // Per-row follow-ups: close rate and regressions both need multi-row reasoning that does
  // not compress into the query above without becoming unreadable.
  const out: MarketRow[] = []
  for (const r of rows) {
    const realised = await getSiteRealisedValue(db, r.siteId).catch(() => null)
    const regressions = await countRegressions(db, r.siteId).catch(() => 0)
    out.push({
      ...r,
      modelledRentMicros: r.modelledRentMicros?.toString() ?? null,
      closeRate: realised?.rate ?? null,
      realisedMonthlyMicros: realised?.monthlyValueMicros?.toString() ?? null,
      regressions,
    })
  }
  return out
}
