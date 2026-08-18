import 'server-only'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  OCCUPIABLE_SURFACES,
  SERP_SURFACES,
  isOurDomain,
  surfaceForItemType,
  surfaceState,
  tallyCoverage,
  type CoverageTally,
  type SerpSurface,
  type SurfaceObservation,
  type SurfaceState,
  type ControlSummary,
  summariseControl,
  PRICE,
  formatMicrosUsd,
} from '@rnr/core'
import type { Database } from '../db.js'
import { keywordClusters, serpSurfaceObservations, sites } from '../schema.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchOrganicSerpDetailed } from '../providers/dataforseo/serp.js'

/**
 * Turning a purchased SERP into per-surface coverage.
 *
 * ==================== THE DATA WAS ALREADY PAID FOR ====================
 * `runDifficultyPass` already extracts the full layout of every SERP it buys and
 * then persists one boolean of it. Everything here reads the same raw response
 * and keeps the rest, so coverage costs nothing beyond what difficulty already
 * spends.
 * ======================================================================
 */

/** The shape of a DataForSEO advanced SERP item, as far as this module cares. */
interface RawItem {
  type?: unknown
  rank_absolute?: unknown
  domain?: unknown
  url?: unknown
  items?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null

/**
 * Read every surface out of one raw SERP.
 *
 * ==================== NESTED ITEMS ARE WHERE WE LIVE ====================
 * Our slot in a Discussions pack or an images strip is not a top-level item — it
 * is inside the block's own `items` array. Scanning only the top level would
 * report every non-organic surface as THEIRS forever, which is the failure mode
 * that would make this whole feature quietly useless: it would look measured, it
 * would look plausible, and it would always say no.
 * =======================================================================
 */
export interface DetailedSurface extends SurfaceObservation {
  ourUrl: string | null
  holders: string[]
  blockRankAbsolute: number | null
}

export function readSurfacesDetailed(
  raw: Array<Record<string, unknown>>,
  ourDomain: string,
): DetailedSurface[] {
  const found = new Map<
    SerpSurface,
    { ourRank: number | null; ourUrl: string | null; holders: string[]; block: number | null }
  >()

  for (const item of raw) {
    const type = str((item as RawItem).type)
    if (!type) continue
    const surface = surfaceForItemType(type)
    if (!surface) continue

    const blockRank = int((item as RawItem).rank_absolute)
    const existing = found.get(surface) ?? {
      ourRank: null,
      ourUrl: null,
      holders: [] as string[],
      block: blockRank,
    }

    const consider = (domain: string | null, url: string | null, rank: number | null): void => {
      if (!domain) return
      if (existing.holders.length < 12 && !existing.holders.includes(domain)) {
        existing.holders.push(domain)
      }
      if (isOurDomain(domain, ourDomain) && existing.ourRank === null) {
        existing.ourRank = rank ?? 1
        existing.ourUrl = url
      }
    }

    consider(str((item as RawItem).domain), str((item as RawItem).url), blockRank)

    /**
     * ==================== NESTED ITEMS ARE WHERE WE LIVE ====================
     * Our slot in a Discussions pack, an images strip or an AI Overview citation
     * is not a top-level item — it is inside the block's own `items` array.
     * Scanning only the top level would report every non-organic surface as
     * THEIRS forever: measured-looking, plausible, and always no.
     * =======================================================================
     */
    const nested = (item as RawItem).items
    if (Array.isArray(nested)) {
      nested.forEach((child, i) => {
        if (typeof child !== 'object' || child === null) return
        const c = child as Record<string, unknown>
        consider(str(c['domain']), str(c['url']), int(c['rank_absolute']) ?? i + 1)
      })
    }

    if (existing.block === null) existing.block = blockRank
    found.set(surface, existing)
  }

  /**
   * EVERY known surface gets a row, present or not. Writing only what Google
   * returned would make ABSENT and UNMEASURED the same missing row — the two
   * states this whole model exists to keep apart.
   */
  return SERP_SURFACES.map((surface) => {
    const hit = found.get(surface)
    return {
      surface,
      present: Boolean(hit),
      ourRank: hit?.ourRank ?? null,
      holderCount: hit?.holders.length ?? 0,
      ourUrl: hit?.ourUrl ?? null,
      holders: hit?.holders ?? [],
      blockRankAbsolute: hit?.block ?? null,
    }
  })
}

/** The four-state view, without the extra detail. */
export function readSurfaces(
  raw: Array<Record<string, unknown>>,
  ourDomain: string,
): SurfaceObservation[] {
  return readSurfacesDetailed(raw, ourDomain).map(({ surface, present, ourRank, holderCount }) => ({
    surface,
    present,
    ourRank,
    holderCount,
  }))
}

export interface RecordSurfacesArgs {
  siteId: number
  keywordNorm: string
  clusterId?: number | null
  ourDomain: string
  raw: Array<Record<string, unknown>>
  locationCode?: number | null
  device?: string
  source?: string
  now?: Date
}

export async function recordSurfaces(db: Database, args: RecordSurfacesArgs): Promise<number> {
  const now = args.now ?? new Date()
  const device = args.device ?? 'desktop'

  const detailed = readSurfacesDetailed(args.raw, args.ourDomain)
  const rows = detailed.map((d) => ({
    siteId: args.siteId,
    keywordNorm: args.keywordNorm,
    clusterId: args.clusterId ?? null,
    locationCode: args.locationCode ?? null,
    device,
    surface: d.surface,
    present: d.present,
    ourRank: d.ourRank,
    ourUrl: d.ourUrl,
    holderDomains: d.holders.length > 0 ? d.holders : null,
    blockRankAbsolute: d.blockRankAbsolute,
    measuredAt: now,
    source: args.source ?? 'difficulty_pass',
  }))

  await db
    .insert(serpSurfaceObservations)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        serpSurfaceObservations.siteId,
        serpSurfaceObservations.keywordNorm,
        serpSurfaceObservations.surface,
        serpSurfaceObservations.device,
      ],
      set: {
        clusterId: sql`excluded.cluster_id`,
        locationCode: sql`excluded.location_code`,
        present: sql`excluded.present`,
        ourRank: sql`excluded.our_rank`,
        ourUrl: sql`excluded.our_url`,
        holderDomains: sql`excluded.holder_domains`,
        blockRankAbsolute: sql`excluded.block_rank_absolute`,
        measuredAt: sql`excluded.measured_at`,
        source: sql`excluded.source`,
      },
    })

  return rows.length
}

// --- Reading ----------------------------------------------------------------

export interface CoverageRow {
  clusterId: number | null
  slug: string
  label: string
  /** The head term. What a page title would target — shown on hover. */
  primaryKeywordNorm: string | null
  kind: string
  volumeMax: number | null
  memberCount: number
  states: Record<SerpSurface, SurfaceState>
  /** Our rank per surface, so the board can grade control rather than binarise it. */
  ranks: Partial<Record<SerpSurface, number>>
  tally: CoverageTally
  control: ControlSummary
  measuredAt: Date | null
}

/**
 * The coverage matrix, one row per cluster.
 *
 * Clusters rather than keywords by default: a cluster is one page, so the page's
 * SERP is the one that matters — and at 2,363 keywords versus 228 clusters it is
 * also the difference between a $7 sweep and a $70 one.
 */
export async function loadCoverageMatrix(
  db: Database,
  siteId: number,
  opts: { limit?: number } = {},
): Promise<CoverageRow[]> {
  const clusters = await db
    .select({
      id: keywordClusters.id,
      slug: keywordClusters.slug,
      label: keywordClusters.label,
      kind: keywordClusters.kind,
      volumeMax: keywordClusters.volumeMax,
      memberCount: keywordClusters.memberCount,
      primaryKeywordNorm: keywordClusters.primaryKeywordNorm,
    })
    .from(keywordClusters)
    .where(and(eq(keywordClusters.siteId, siteId), sql`${keywordClusters.kind} <> 'quarantine'`))
    .orderBy(sql`${keywordClusters.volumeMax} desc nulls last`)
    .limit(opts.limit ?? 60)

  if (clusters.length === 0) return []

  const norms = clusters
    .map((c) => c.primaryKeywordNorm)
    .filter((n): n is string => Boolean(n))

  const obs =
    norms.length === 0
      ? []
      : await db
          .select()
          .from(serpSurfaceObservations)
          .where(
            and(
              eq(serpSurfaceObservations.siteId, siteId),
              inArray(serpSurfaceObservations.keywordNorm, norms),
            ),
          )

  const byKeyword = new Map<string, typeof obs>()
  for (const o of obs) {
    const list = byKeyword.get(o.keywordNorm) ?? []
    list.push(o)
    byKeyword.set(o.keywordNorm, list)
  }

  return clusters.map((c) => {
    const mine = c.primaryKeywordNorm ? (byKeyword.get(c.primaryKeywordNorm) ?? []) : []
    const asObs: SurfaceObservation[] = mine.map((m) => ({
      surface: m.surface,
      present: m.present,
      ourRank: m.ourRank,
      holderCount: m.holderDomains?.length ?? 0,
    }))
    const byS = new Map(asObs.map((o) => [o.surface, o]))

    const states = {} as Record<SerpSurface, SurfaceState>
    for (const s of SERP_SURFACES) states[s] = surfaceState(byS.get(s))

    return {
      clusterId: c.id,
      slug: c.slug,
      label: c.label,
      primaryKeywordNorm: c.primaryKeywordNorm,
      kind: c.kind,
      volumeMax: c.volumeMax,
      memberCount: c.memberCount,
      states,
      ranks: Object.fromEntries(
        asObs.filter((o) => o.ourRank !== null).map((o) => [o.surface, o.ourRank as number]),
      ) as Partial<Record<SerpSurface, number>>,
      tally: tallyCoverage(asObs, OCCUPIABLE_SURFACES),
      control: summariseControl(asObs, OCCUPIABLE_SURFACES),
      measuredAt: mine[0]?.measuredAt ?? null,
    }
  })
}

/**
 * Portfolio-level counts for the stat row above the matrix.
 *
 * Named `summariseSurfaceCoverage`, not `summariseCoverage` — the supply module
 * already exports the latter, and two functions with one name in a barrel export
 * is a collision waiting for whichever one is imported second.
 */
export async function summariseSurfaceCoverage(
  db: Database,
  siteId: number,
): Promise<{
  clusters: number
  clustersMeasured: number
  clustersHoldingSomething: number
  surfacesHeld: number
  keywordsMeasured: number
}> {
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(keywordClusters)
    .where(and(eq(keywordClusters.siteId, siteId), sql`${keywordClusters.kind} <> 'quarantine'`))

  /**
   * ==================== COUNT WHAT THE GRID SHOWS ====================
   * This first counted distinct measured keywords, which produced a header
   * reading "2 of 228 clusters measured" above a grid where every cell was
   * unmeasured — both true, about different things. The grid joins observations
   * to a cluster's PRIMARY keyword, so the stat has to as well, or the two
   * disagree in the one place a reader checks the other.
   *
   * `keywordsMeasured` stays alongside, named for what it actually is: SERPs
   * bought for any keyword, primary or not.
   * ===================================================================
   */
  const [m] = await db
    .select({
      measured: sql<number>`count(distinct ${keywordClusters.id})::int`,
      holding: sql<number>`count(distinct ${keywordClusters.id}) filter (where ${serpSurfaceObservations.ourRank} is not null)::int`,
      surfacesHeld: sql<number>`count(*) filter (where ${serpSurfaceObservations.ourRank} is not null)::int`,
    })
    .from(keywordClusters)
    .innerJoin(
      serpSurfaceObservations,
      and(
        eq(serpSurfaceObservations.siteId, keywordClusters.siteId),
        eq(serpSurfaceObservations.keywordNorm, keywordClusters.primaryKeywordNorm),
      ),
    )
    .where(and(eq(keywordClusters.siteId, siteId), sql`${keywordClusters.kind} <> 'quarantine'`))

  const [k] = await db
    .select({ n: sql<number>`count(distinct ${serpSurfaceObservations.keywordNorm})::int` })
    .from(serpSurfaceObservations)
    .where(eq(serpSurfaceObservations.siteId, siteId))

  return {
    clusters: c?.n ?? 0,
    clustersMeasured: m?.measured ?? 0,
    clustersHoldingSomething: m?.holding ?? 0,
    surfacesHeld: m?.surfacesHeld ?? 0,
    keywordsMeasured: k?.n ?? 0,
  }
}

// --- Scouting ---------------------------------------------------------------

export interface ScoutResult {
  eligible: number
  scouted: number
  serpsBought: number
  costMicros: bigint
  held: number
  notes: string[]
}

export interface ScoutArgs {
  siteId: number
  /** Clusters to measure, highest demand first. */
  limit?: number
  live?: boolean
  /** Hard ceiling on spend, in micros. */
  budgetMicros?: bigint
  /** Re-scout clusters measured before this. Default: skip anything already measured. */
  staleBefore?: Date
}

/**
 * Buy a SERP for each unscouted cluster's PRIMARY keyword and record its surfaces.
 *
 * ==================== CLUSTERS, NOT KEYWORDS ====================
 * A cluster is one page, so the page's SERP is the one that matters. At 3,295
 * keywords versus 229 clusters that is also the difference between a ~$7 sweep
 * and a ~$0.50 one, which is what makes this runnable at all.
 * ================================================================
 *
 * Priced, capped, and dry by default — the same shape as every other paid step
 * here. A pass that stops at its budget says how many clusters it did NOT
 * measure, because those stay UNSCOUTED rather than becoming "nothing there".
 */
export async function scoutClusters(db: Database, args: ScoutArgs): Promise<ScoutResult> {
  const notes: string[] = []
  const limit = args.limit ?? 25

  const [site] = await db
    .select({ domain: sites.domain, keywordSpace: sites.keywordSpace })
    .from(sites)
    .where(eq(sites.id, args.siteId))
    .limit(1)

  if (!site?.domain) throw new Error(`site ${args.siteId} has no domain`)
  const locationCode = (site.keywordSpace as { serpLocationCode?: number } | null)?.serpLocationCode ?? 2840

  const candidates = await db
    .select({
      id: keywordClusters.id,
      slug: keywordClusters.slug,
      primary: keywordClusters.primaryKeywordNorm,
      volumeMax: keywordClusters.volumeMax,
    })
    .from(keywordClusters)
    .where(
      and(
        eq(keywordClusters.siteId, args.siteId),
        sql`${keywordClusters.kind} <> 'quarantine'`,
        isNotNull(keywordClusters.primaryKeywordNorm),
      ),
    )
    .orderBy(sql`${keywordClusters.volumeMax} desc nulls last`)
    .limit(limit * 3)

  const already = await db
    .selectDistinct({ keywordNorm: serpSurfaceObservations.keywordNorm })
    .from(serpSurfaceObservations)
    .where(eq(serpSurfaceObservations.siteId, args.siteId))
  const measured = new Set(already.map((a) => a.keywordNorm))

  const todo = candidates
    .filter((c) => args.staleBefore || !measured.has(c.primary!))
    .slice(0, limit)

  const budget = args.budgetMicros ?? PRICE.serpOrganicLive * BigInt(limit)
  const estimate = PRICE.serpOrganicLive * BigInt(todo.length)

  if (!args.live) {
    return {
      eligible: todo.length,
      scouted: 0,
      serpsBought: 0,
      costMicros: 0n,
      held: 0,
      notes: [
        `${todo.length} unscouted cluster(s). This BUYS SERPs — about ` +
          `${formatMicrosUsd(estimate)} at ${formatMicrosUsd(PRICE.serpOrganicLive)} each. Pass --live to spend.`,
      ],
    }
  }

  const client = createDfsClientFromEnv()
  if (!client) {
    return {
      eligible: todo.length,
      scouted: 0,
      serpsBought: 0,
      costMicros: 0n,
      held: 0,
      notes: ['DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set.'],
    }
  }

  let costMicros = 0n
  let serpsBought = 0
  let scouted = 0
  let held = 0
  const now = new Date()

  for (const c of todo) {
    if (costMicros + PRICE.serpOrganicLive > budget) {
      notes.push(
        `Budget cap reached at ${formatMicrosUsd(costMicros)} after ${serpsBought} SERP(s). ` +
          `${todo.length - serpsBought} cluster(s) were NOT scouted — they stay UNSCOUTED, not empty.`,
      )
      break
    }
    try {
      const serp = await fetchOrganicSerpDetailed(client, {
        keyword: c.primary!,
        locationCode,
      })
      costMicros += PRICE.serpOrganicLive
      serpsBought += 1

      const detailed = readSurfacesDetailed(serp.rawItems, site.domain)
      if (detailed.some((d) => d.ourRank !== null)) held += 1

      await recordSurfaces(db, {
        siteId: args.siteId,
        keywordNorm: c.primary!,
        clusterId: c.id,
        ourDomain: site.domain,
        raw: serp.rawItems,
        locationCode,
        source: 'cluster_scout',
        now,
      })
      scouted += 1
    } catch (e) {
      /** One vendor failure must not lose the SERPs already bought and recorded. */
      notes.push(`${c.slug}: ${(e as Error).message}`)
    }
  }

  notes.push(
    `${scouted} cluster(s) scouted for ${formatMicrosUsd(costMicros)}. ` +
      `${held} hold at least one surface.`,
  )

  return { eligible: todo.length, scouted, serpsBought, costMicros, held, notes }
}
