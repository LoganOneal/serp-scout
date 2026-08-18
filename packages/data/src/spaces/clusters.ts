import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  assessKeyword,
  clusterUsesSupply,
  gateKeywordVerdict,
  supplyShortfall,
  supplyStatusFor,
  type ClusterKind,
  type KeywordVerdict,
} from '@rnr/core'
import type { Database } from '../db.js'
import { keywordClusters, siteKeywordTargets, supplyCoverage } from '../schema.js'
import { loadSiteSpace } from './research.js'
import { coverageKey, loadCoverageMap } from '../supply/coverage.js'

/**
 * Reading and deciding at the level of a page.
 *
 * ==================== QUARANTINE NEVER REACHES A BOARD ====================
 * `data_anomaly` arrives as a cluster label in the source research. It is stored
 * — throwing it away would lose the flag somebody deliberately raised — and it is
 * excluded from every list here, because a note about bad data is not a page and
 * must never take a place in a work queue.
 * =========================================================================
 */

export interface ClusterBoardRow {
  id: number
  slug: string
  kind: ClusterKind
  label: string
  primaryKeywordNorm: string | null
  entitySlug: string | null
  primaryUrl: string | null
  memberCount: number
  /** Lower bound. What the board sorts on. */
  volumeMax: number | null
  /** Upper bound. Shown beside max, never sorted on. */
  volumeSum: number | null
  kdMin: number | null
  kdMedian: number | null
  bestPosition: number | null
  verdict: KeywordVerdict | null
  verdictReason: string | null
  /** Locality clusters only. Null = supply unmeasured for this entity. */
  availableItems: number | null
  /** How many more listings before the locality is credible. See CREDIBLE_SUPPLY_THRESHOLD. */
  staysNeeded: number
}

export async function listClusterBoard(
  db: Database,
  siteId: number,
  opts: { kinds?: string[]; limit?: number } = {},
): Promise<ClusterBoardRow[]> {
  const where = [eq(keywordClusters.siteId, siteId)]
  if (opts.kinds?.length) where.push(inArray(keywordClusters.kind, opts.kinds as ClusterKind[]))
  else where.push(sql`${keywordClusters.kind} <> 'quarantine'`)

  const rows = await db
    .select()
    .from(keywordClusters)
    .where(and(...where))
    /**
     * `desc nulls last`, explicitly. Postgres sorts NULLs FIRST on DESC, so a
     * cluster whose volume was never measured would head a board sorted by
     * demand — the same trap the keyword board already documents.
     */
    .orderBy(sql`${keywordClusters.volumeMax} desc nulls last`)
    .limit(opts.limit ?? 40)

  const coverage = await loadCoverageMap(db, siteId)

  return rows.map((c) => {
    const cov = c.entitySlug ? coverage.get(coverageKey('locality', c.entitySlug)) : null
    const available = clusterUsesSupply(c.kind) && cov ? cov.availableItemCount : null
    return {
      id: c.id,
      slug: c.slug,
      kind: c.kind,
      label: c.label,
      primaryKeywordNorm: c.primaryKeywordNorm,
      entitySlug: c.entitySlug,
      primaryUrl: c.primaryUrl,
      memberCount: c.memberCount,
      volumeMax: c.volumeMax,
      volumeSum: c.volumeSum,
      kdMin: c.kdMin,
      kdMedian: c.kdMedian,
      bestPosition: c.bestPosition,
      verdict: c.verdict,
      verdictReason: c.verdictReason,
      availableItems: available,
      staysNeeded: available === null ? 0 : supplyShortfall(available).needed,
    }
  })
}

export interface ClusterMemberRow {
  keyword: string
  keywordNorm: string
  semrushVolume: number | null
  semrushKd: number | null
  intent: string | null
  volume: number | null
  position: number | null
  verdict: KeywordVerdict | null
}

export async function listClusterMembers(
  db: Database,
  siteId: number,
  slug: string,
): Promise<ClusterMemberRow[]> {
  const [cluster] = await db
    .select({ id: keywordClusters.id })
    .from(keywordClusters)
    .where(and(eq(keywordClusters.siteId, siteId), eq(keywordClusters.slug, slug)))
    .limit(1)

  if (!cluster) return []

  return db
    .select({
      keyword: siteKeywordTargets.keyword,
      keywordNorm: siteKeywordTargets.keywordNorm,
      semrushVolume: siteKeywordTargets.semrushVolume,
      semrushKd: siteKeywordTargets.semrushKd,
      intent: siteKeywordTargets.intent,
      volume: siteKeywordTargets.volume,
      position: siteKeywordTargets.position,
      verdict: siteKeywordTargets.verdict,
    })
    .from(siteKeywordTargets)
    .where(eq(siteKeywordTargets.clusterId, cluster.id))
    .orderBy(sql`${siteKeywordTargets.semrushVolume} desc nulls last`)
    .limit(500)
}

export interface ClusterVerdictResult {
  scored: number
  byVerdict: Record<KeywordVerdict, number>
  supplyGated: number
  notes: string[]
}

/**
 * Decide every cluster.
 *
 * ==================== THE SAME MODEL, ON THE AGGREGATE ====================
 * `assessKeyword` and `gateKeywordVerdict` are reused verbatim rather than
 * reimplemented at cluster scale. If a cluster had its own notion of what BUILD
 * means, the two would drift, and the drill-down from a cluster to its keywords
 * would eventually show a BUILD cluster full of IGNORE keywords with nothing to
 * explain it.
 *
 * What differs is only the INPUT: volume is the cluster's max (a lower bound,
 * never the sum), difficulty is the easiest member's, and position is the best
 * member's — because if any member ranks, the page ranks.
 * =========================================================================
 */
export async function runClusterVerdicts(
  db: Database,
  siteId: number,
  opts: { buildDifficultyCeiling?: number } = {},
): Promise<ClusterVerdictResult> {
  const site = await loadSiteSpace(db, siteId)
  const space = site.keywordSpace
  const volumeFloor = space?.volumeFloor ?? 0
  const notes: string[] = []

  const rows = await db
    .select()
    .from(keywordClusters)
    .where(and(eq(keywordClusters.siteId, siteId), sql`${keywordClusters.kind} <> 'quarantine'`))

  const coverage = await loadCoverageMap(db, siteId)
  const nowIso = new Date().toISOString()
  const byVerdict: Record<KeywordVerdict, number> = {
    DEFEND: 0,
    IMPROVE: 0,
    BUILD: 0,
    IGNORE: 0,
    UNKNOWN: 0,
  }
  let supplyGated = 0
  const now = new Date()

  for (const c of rows) {
    /**
     * ==================== TWO DIFFICULTY SCALES, NOT SILENTLY MIXED ==========
     * `kdMin` is Semrush's KD. `DEFAULT_BUILD_DIFFICULTY_CEILING` was set for
     * scoreDifficulty, which is calibrated against local SERPs on this repo's
     * own model. They are both 0-100 and they are not the same number.
     *
     * The ceiling is explicitly POLICY — "a starting position to be moved once
     * outcomes exist" — so using it here is defensible as a first cut. Passing
     * it silently is not: every verdict decided this way says so in its reason,
     * so a BUILD that rests on a vendor's scale can never be mistaken for one
     * that rests on a SERP we bought.
     * ========================================================================
     */
    const usedVendorKd = c.kdMin !== null

    const demand = assessKeyword(
      {
        position: c.bestPosition,
        /**
         * From the stored column, NOT from `bestPosition !== null`. Derived, it
         * would conflate "checked and nothing ranks" with "never checked" — and
         * the first of those is precisely what turns UNKNOWN into BUILD.
         */
        positionMeasured: c.positionMeasured,
        volume: c.volumeMax,
        difficulty: c.kdMin,
        volumeFloor,
      },
      opts,
    )

    /**
     * Supply gates locality clusters ONLY. A `chain_hilton` cluster has no
     * locality, so asking whether we hold inventory for it is a category error
     * — and an unmeasured 'unknown' would be the honest answer anyway, which
     * changes nothing.
     */
    const cov =
      clusterUsesSupply(c.kind) && c.entitySlug
        ? coverage.get(coverageKey('locality', c.entitySlug))
        : null
    const gated = clusterUsesSupply(c.kind)
      ? gateKeywordVerdict(demand, supplyStatusFor(cov ?? null, { now: nowIso }))
      : { ...demand, gated: false }

    if ('gated' in gated && gated.gated) supplyGated += 1
    byVerdict[gated.verdict] += 1

    const reason =
      usedVendorKd && (gated.verdict === 'BUILD' || gated.verdict === 'IGNORE')
        ? `${gated.reason} (difficulty is Semrush KD ${c.kdMin}, not a SERP we bought — the ` +
          `ceiling was calibrated on scoreDifficulty)`
        : gated.reason

    await db
      .update(keywordClusters)
      .set({
        verdict: gated.verdict,
        verdictReason: reason,
        verdictMissing: gated.missing,
        updatedAt: now,
      })
      .where(eq(keywordClusters.id, c.id))
  }

  const vendorDecided = rows.filter((r) => r.kdMin !== null).length
  if (vendorDecided > 0) {
    notes.push(
      `${vendorDecided} cluster(s) used Semrush KD as difficulty. That is a different scale from ` +
        `scoreDifficulty, which the build ceiling was calibrated on — buy SERPs for the ones you ` +
        `intend to act on before trusting a borderline verdict.`,
    )
  }
  if (supplyGated > 0) {
    notes.push(
      `${supplyGated} cluster(s) downgraded for having no available supply. Each was a PAGE we ` +
        `would have written for inventory we do not hold.`,
    )
  }
  if (rows.length > 0 && byVerdict.UNKNOWN === rows.length) {
    notes.push(
      `Every cluster is UNKNOWN. Clusters inherit their signals from members, so the free ` +
        `volume and rankings passes are what move them — not a re-run here.`,
    )
  }

  return { scored: rows.length, byVerdict, supplyGated, notes }
}

/** Clusters whose locality is short of the credibility threshold. */
export async function listSupplyShortfalls(
  db: Database,
  siteId: number,
  limit = 40,
): Promise<Array<{ slug: string; entitySlug: string; volumeMax: number | null; have: number; needed: number }>> {
  const rows = await db
    .select({
      slug: keywordClusters.slug,
      entitySlug: keywordClusters.entitySlug,
      volumeMax: keywordClusters.volumeMax,
      available: supplyCoverage.availableItemCount,
    })
    .from(keywordClusters)
    .innerJoin(
      supplyCoverage,
      and(
        eq(supplyCoverage.siteId, keywordClusters.siteId),
        eq(supplyCoverage.entitySlug, keywordClusters.entitySlug),
      ),
    )
    .where(and(eq(keywordClusters.siteId, siteId), eq(keywordClusters.kind, 'locality')))
    .orderBy(desc(keywordClusters.volumeMax))
    .limit(limit * 3)

  return rows
    .map((r) => {
      const s = supplyShortfall(r.available)
      return {
        slug: r.slug,
        entitySlug: r.entitySlug!,
        volumeMax: r.volumeMax,
        have: s.have,
        needed: s.needed,
      }
    })
    .filter((r) => r.needed > 0)
    .slice(0, limit)
}
