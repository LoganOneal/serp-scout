import 'server-only'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { domainCandidates, domainEnrichRuns, researchGeos } from '../schema.js'

/** Read models for the ENRICH MODE screens. */

export interface EnrichRunSummary {
  id: number
  status: string
  niche: string
  locality: string
  locationCode: number
  businessesFound: number
  uniqueDomains: number
  skippedPlatform: number
  skippedNoDomain: number
  costMicros: bigint
  error: string | null
  createdAt: Date
  completedAt: Date | null
  /** Rows that are not LIVE — the acquisition shortlist size. */
  candidateCount: number
  bestScore: number | null
}

export async function listEnrichRuns(
  db: Database,
  opts: { limit?: number } = {},
): Promise<EnrichRunSummary[]> {
  const rows = await db
    .select({
      id: domainEnrichRuns.id,
      status: domainEnrichRuns.status,
      niche: domainEnrichRuns.niche,
      locality: domainEnrichRuns.locality,
      locationCode: domainEnrichRuns.locationCode,
      businessesFound: domainEnrichRuns.businessesFound,
      uniqueDomains: domainEnrichRuns.uniqueDomains,
      skippedPlatform: domainEnrichRuns.skippedPlatform,
      skippedNoDomain: domainEnrichRuns.skippedNoDomain,
      costMicros: domainEnrichRuns.costMicros,
      error: domainEnrichRuns.error,
      createdAt: domainEnrichRuns.createdAt,
      completedAt: domainEnrichRuns.completedAt,
      candidateCount: sql<number>`(
        SELECT count(*)::int FROM ${domainCandidates} dc
         WHERE dc.run_id = ${domainEnrichRuns.id}
           AND dc.status NOT IN ('LIVE', 'BROKEN', 'UNKNOWN')
      )`,
      bestScore: sql<number | null>`(
        SELECT max(dc.score) FROM ${domainCandidates} dc
         WHERE dc.run_id = ${domainEnrichRuns.id}
           AND dc.status NOT IN ('LIVE', 'BROKEN', 'UNKNOWN')
      )`,
    })
    .from(domainEnrichRuns)
    .orderBy(desc(domainEnrichRuns.createdAt))
    .limit(opts.limit ?? 100)

  return rows.map((r) => ({ ...r, bestScore: r.bestScore == null ? null : Number(r.bestScore) }))
}

export async function getEnrichRun(
  db: Database,
  runId: number,
): Promise<EnrichRunSummary | null> {
  const rows = await listEnrichRuns(db, { limit: 1000 })
  return rows.find((r) => r.id === runId) ?? null
}

export type DomainCandidateView = typeof domainCandidates.$inferSelect

/**
 * One run's rows, best-first.
 *
 * LIVE rows are included by default and filtered in the UI rather than dropped
 * here: "we checked 200 domains and 180 were live businesses" is the context
 * that makes 20 candidates meaningful, and a query that silently hides it makes
 * the run look thinner than it was.
 */
export async function listDomainCandidates(
  db: Database,
  args: { runId: number; includeLive?: boolean; limit?: number },
): Promise<DomainCandidateView[]> {
  const where =
    args.includeLive === false
      ? and(
          eq(domainCandidates.runId, args.runId),
          sql`${domainCandidates.status} NOT IN ('LIVE', 'BROKEN', 'UNKNOWN')`,
        )
      : eq(domainCandidates.runId, args.runId)

  return db
    .select()
    .from(domainCandidates)
    .where(where)
    .orderBy(desc(domainCandidates.score), domainCandidates.domain)
    .limit(args.limit ?? 1000)
}

export interface EnrichGeoOption {
  locationCode: number
  label: string
}

/** Markets that carry a DataForSEO location code, for the run form. */
export async function listEnrichGeoOptions(db: Database): Promise<EnrichGeoOption[]> {
  const rows = await db
    .selectDistinct({
      locationCode: researchGeos.dataforseoLocationCode,
      market: researchGeos.market,
      stateAbbr: researchGeos.stateAbbr,
      rank: researchGeos.selectedRank,
    })
    .from(researchGeos)
    .where(isNotNull(researchGeos.dataforseoLocationCode))
    .orderBy(researchGeos.selectedRank, researchGeos.market)
    .limit(500)

  const seen = new Set<number>()
  const out: EnrichGeoOption[] = []
  for (const r of rows) {
    const code = r.locationCode
    if (code == null || seen.has(code)) continue
    seen.add(code)
    out.push({ locationCode: code, label: r.stateAbbr ? `${r.market}, ${r.stateAbbr}` : r.market })
  }
  return out
}

/**
 * Mutations the web layer needs without reaching for drizzle itself.
 *
 * `apps/web` does not depend on drizzle-orm, and should not: keeping query
 * builders out of server actions is what stops schema details leaking into the
 * UI layer.
 */
export async function deleteEnrichRunById(db: Database, runId: number): Promise<void> {
  // Candidates cascade. The spend_ledger line carries the run id in `note`
  // rather than a foreign key, so deleting a run never erases its spend.
  await db.delete(domainEnrichRuns).where(eq(domainEnrichRuns.id, runId))
}

export async function failEnrichRun(
  db: Database,
  runId: number,
  message: string,
): Promise<void> {
  await db
    .update(domainEnrichRuns)
    .set({ status: 'failed', error: message, completedAt: new Date() })
    .where(eq(domainEnrichRuns.id, runId))
}

/**
 * The DataForSEO location code to run a market's domain search against.
 *
 * `localities` carries lat/lon but no location code — the code lives on
 * `research_geos`, which references the locality. This is that hop, and it is
 * why a market page can offer the search at all.
 *
 * Returns null when the locality was never part of a research import. The UI
 * must say so rather than silently falling back to a different market.
 */
export async function resolveMarketLocationCode(
  db: Database,
  localityId: number,
): Promise<{ locationCode: number; locationName: string | null } | null> {
  const rows = await db
    .select({
      locationCode: researchGeos.dataforseoLocationCode,
      locationName: researchGeos.dataforseoLocationName,
    })
    .from(researchGeos)
    .where(
      and(eq(researchGeos.localityId, localityId), isNotNull(researchGeos.dataforseoLocationCode)),
    )
    .limit(1)

  const row = rows[0]
  if (!row?.locationCode) return null
  return { locationCode: row.locationCode, locationName: row.locationName }
}

/** Prior domain searches for one niche in one market, newest first. */
export async function listEnrichRunsForMarket(
  db: Database,
  args: { locationCode: number; niche: string; limit?: number },
): Promise<EnrichRunSummary[]> {
  const all = await listEnrichRuns(db, { limit: 500 })
  const niche = args.niche.trim().toLowerCase()
  return all
    .filter((r) => r.locationCode === args.locationCode && r.niche.trim().toLowerCase() === niche)
    .slice(0, args.limit ?? 10)
}
