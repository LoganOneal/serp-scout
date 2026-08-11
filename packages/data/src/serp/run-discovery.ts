import 'server-only'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  applyQueryModifier,
  centsToMicros,
  expandServiceIntentKeywords,
  extractRedditHitsFromDfsResult,
  estimateDiscoveryCostMicros,
  extractSerpLayoutMetrics,
  PRICE,
  type Micros,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  discoveryGeos,
  discoveryHits,
  discoveryJobs,
  discoveryNiches,
  discoveryRuns,
  discoverySerpMetrics,
  localities,
  niches,
  type DiscoveryCommentabilityMode,
  type DiscoveryJob,
  type DiscoveryRun,
  type DiscoveryRunSource,
} from '../schema.js'
import type { Providers } from '../providers/index.js'
import { liveCallsEnabled } from '../providers/index.js'
import { AccountIssueError, RateLimitError } from '../providers/dataforseo/errors.js'
import {
  reconcileDiscoverySpend,
  recordDiscoverySpend,
  refundDiscoverySpend,
  reserveDiscoverySpend,
} from './discovery-budget.js'
import { ensureKeywordVolumes } from './keyword-volume-cache.js'
import { findCachedRawSerp } from './raw-serp-cache.js'
import {
  fetchReadyTaskIds,
  getSerpTaskResult,
  postSerpTask,
} from '../providers/dataforseo/serp-queued.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'

/** Max requeues for abort/timeout/transient SE errors before permanent fail. */
export const MAX_DISCOVERY_JOB_RETRIES = 4

export function isRetriableDiscoveryError(err: unknown): boolean {
  if (err == null) return false
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'AbortError' || name === 'TimeoutError') return true
  if (/aborted|abort|timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(message)) {
    return true
  }
  // DataForSEO transient SE blips (not auth 40100 / account 402xx).
  if (/\b40101\b|Internal SE Server Error|502|503|504|429/i.test(message)) return true
  return false
}

export function discoveryRetryCountFromError(error: string | null | undefined): number {
  if (!error) return 0
  const m = error.match(/\[retry:(\d+)\]/i)
  if (!m?.[1]) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * Put a claimed job back to pending for another attempt. Refunds reserved spend
 * so retries do not double-count the run ledger.
 */
export async function requeueDiscoveryJob(
  db: Database,
  args: {
    jobId: number
    runId: number
    reservedCostMicros: Micros
    reason: string
    previousError?: string | null
  },
): Promise<{ status: 'requeued' | 'failed'; retries: number }> {
  const prev = discoveryRetryCountFromError(args.previousError)
  const retries = prev + 1
  const reason = args.reason.slice(0, 400)

  if (retries > MAX_DISCOVERY_JOB_RETRIES) {
    await db
      .update(discoveryJobs)
      .set({
        status: 'failed',
        error: `[retry:${retries}/${MAX_DISCOVERY_JOB_RETRIES} exhausted] ${reason}`.slice(0, 500),
        finishedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        costMicros: args.reservedCostMicros,
      })
      .where(eq(discoveryJobs.id, args.jobId))
    await rollupDiscoveryRun(db, args.runId)
    return { status: 'failed', retries }
  }

  if (args.reservedCostMicros > 0n) {
    try {
      await refundDiscoverySpend(db, {
        runId: args.runId,
        costMicros: args.reservedCostMicros,
        endpoint: 'serp/discovery',
        note: `requeue after retriable error: ${reason}`,
        jobId: args.jobId,
      })
    } catch {
      // Best-effort refund; still requeue work.
    }
  }

  await db
    .update(discoveryJobs)
    .set({
      status: 'pending',
      error: `[retry:${retries}] ${reason}`.slice(0, 500),
      finishedAt: null,
      claimedAt: null,
      claimedBy: null,
      costMicros: 0n,
    })
    .where(eq(discoveryJobs.id, args.jobId))
  await rollupDiscoveryRun(db, args.runId)
  return { status: 'requeued', retries }
}
import {
  resolveDiscoveryGeos,
  type DiscoveryGeoInput,
  type ResolvedDiscoveryGeo,
} from './resolve-discovery-geos.js'

export type { DiscoveryGeoInput }

/**
 * Reddit SERP discovery runner.
 *
 * Jobs are the queue (FOR UPDATE SKIP LOCKED). Spend is reserved in Postgres
 * before each purchase so concurrent workers cannot overspend.
 */

export const DEFAULT_MAX_JOBS = 5000
export const DEFAULT_DISCOVERY_CAP_CENTS = 500
/**
 * Cron drain budget is ~45s; a hung DFS call leaves jobs `claimed` until redrive.
 * 20 minutes was fine for a laptop worker; on Vercel it makes the UI look stuck.
 * 3 minutes: next few cron ticks can reclaim and retry.
 */
export const STUCK_DISCOVERY_JOB_MINUTES = 3

export interface DiscoveryNicheInput {
  label: string
  slug?: string | null
  keywordPrimary: string
  keywordNearMe: string
  nearMeSynthesised?: boolean
  lineNumber?: number | null
  /** Soft-matched at enqueue if omitted. */
  nicheId?: number | null
  /** Catalog FK threaded into jobs. */
  researchKeywordId?: number | null
}

export interface EnqueuePreview {
  nicheCount: number
  geoResolved: number
  geoUnresolved: number
  geoUnscannableSource: number
  jobCount: number
  estimatedCostMicros: bigint
  budgetCapMicros: bigint
  usedFixtures: boolean
  hardCap: number
  devices?: string[]
  includeNearMe?: boolean
  truncated?: boolean
  selectionNote?: string | null
  requiresLongLivedWorker?: boolean
  filtersSummary?: string
  maxLiveSpendUnderHardCapMicros?: bigint
}

export class DiscoveryEnqueueError extends Error {
  constructor(
    message: string,
    readonly preview?: EnqueuePreview,
  ) {
    super(message)
    this.name = 'DiscoveryEnqueueError'
  }
}

function importBatchId(): string {
  return `disc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Soft-match seed niches by slug / label / keyword noun. Preview only. */
export async function softMatchNicheId(
  db: Database,
  args: { label: string; keywordPrimary: string; slug?: string | null },
): Promise<number | null> {
  const rows = await db
    .select({
      id: niches.id,
      slug: niches.slug,
      label: niches.label,
      keywordNoun: niches.keywordNoun,
    })
    .from(niches)
    .where(eq(niches.active, true))

  const slug = (args.slug ?? '').toLowerCase().trim()
  const label = args.label.toLowerCase().trim()
  const kw = args.keywordPrimary.toLowerCase().trim()

  if (slug) {
    const bySlug = rows.find((r) => r.slug.toLowerCase() === slug)
    if (bySlug) return bySlug.id
  }
  const byLabel = rows.find((r) => r.label.toLowerCase() === label)
  if (byLabel) return byLabel.id
  const byNoun = rows.find(
    (r) =>
      r.keywordNoun.toLowerCase() === kw ||
      r.keywordNoun.toLowerCase() === label ||
      r.label.toLowerCase() === kw,
  )
  return byNoun?.id ?? null
}

/**
 * Every distinct keyword this run will research at one location.
 *
 * This is what makes the volume request batchable: the queue already knows the
 * whole column of work, so the first job to need volume can buy all of it in a
 * single $0.09 request instead of each of the other 49 buying its own.
 *
 * Capped at the endpoint's 1000-keyword ceiling; a bigger run just issues a
 * second request, which is still one per 1000 rather than one per keyword.
 */
export async function keywordsForRunAtLocation(
  db: Database,
  runId: number,
  locationCode: number,
): Promise<string[]> {
  const rows = await db.execute<{ keyword: string }>(sql`
    SELECT DISTINCT j.keyword
      FROM discovery_jobs j
      JOIN discovery_geos g ON g.id = j.discovery_geo_id
     WHERE j.run_id = ${runId}
       AND g.provider_location_code = ${locationCode}
       AND j.keyword IS NOT NULL
       AND btrim(j.keyword) <> ''
     LIMIT 1000
  `)
  return (rows as unknown as Array<{ keyword: string }>)
    .map((r) => r.keyword.trim())
    .filter(Boolean)
}

export async function previewDiscoveryEnqueue(
  db: Database,
  args: {
    niches: DiscoveryNicheInput[]
    geos: DiscoveryGeoInput[]
    budgetCapCents: number
    maxJobs?: number
    usedFixtures?: boolean
    fetchVolume?: boolean
    fetchMaps?: boolean
    /** Queue SERPs at $0.0006 instead of buying live at $0.0020. */
    useQueuedSerp?: boolean
  },
): Promise<{ preview: EnqueuePreview; resolvedGeos: ResolvedDiscoveryGeo[] }> {
  const usedFixtures = args.usedFixtures ?? !liveCallsEnabled()
  const hardCap = args.maxJobs ?? DEFAULT_MAX_JOBS
  const budgetCapMicros = centsToMicros(args.budgetCapCents)
  const resolvedGeos = await resolveDiscoveryGeos(db, args.geos, { usedFixtures })

  const geoResolved = resolvedGeos.filter((g) => g.resolveStatus === 'resolved').length
  const geoUnscannableSource = resolvedGeos.filter(
    (g) => g.resolveStatus === 'unscannable_source',
  ).length
  const geoUnresolved = resolvedGeos.filter((g) => g.resolveStatus === 'unresolved').length

  const jobCount = args.niches.length * 2 * geoResolved
  // One batched volume request per location — see keyword-volume-cache.ts.
  const billExtras = !usedFixtures
  const cost = estimateDiscoveryCostMicros({
    jobCount,
    /**
     * ZERO, not the market count. Keyword volume comes from Google Ads, which
     * is free -- fetchVolumeBatch returns costMicros 0n and billableRequests 0
     * on every path, and the $0.09 DataForSEO endpoint it used to fall back to
     * was removed by policy. Charging for it here inflated every preview by
     * $0.09 per market ($4.50 on a 50-market sweep) against a bill that never
     * arrives. The client-side estimate already prices it at 0; this is the
     * server catching up, not a policy change.
     */
    volumeRequests: 0,
    mapsRequests: billExtras && args.fetchMaps === true ? args.niches.length * geoResolved : 0,
  })
  const preview: EnqueuePreview = {
    nicheCount: args.niches.length,
    geoResolved,
    geoUnresolved,
    geoUnscannableSource,
    jobCount,
    estimatedCostMicros: usedFixtures ? 0n : cost.totalMicros,
    budgetCapMicros,
    usedFixtures,
    hardCap,
  }
  return { preview, resolvedGeos }
}

export type ResearchDevice = 'desktop' | 'mobile'

/**
 * Local SERP research for one market cell.
 *
 * Expands the seed niche into a **buy-intent keyword cluster** (e.g. HVAC → ac repair,
 * furnace repair, emergency ac, installs, near-me heads). Each keyword is purchased at
 * the locality's `provider_location_code` so results match geo-targeted Google SERPs for
 * that market — keywords stay city-free; geo is the location_code parameter.
 *
 * Default: up to 24 keywords × desktop+mobile. source=market_cell for panel loaders.
 */
export async function enqueueMarketDiscovery(
  db: Database,
  args: {
    localityId: number
    nicheId: number
    budgetCapCents?: number
    commentabilityMode?: DiscoveryCommentabilityMode
    devices?: ResearchDevice[]
    /** Override expanded list (tests). */
    keywords?: string[]
  },
): Promise<{ run: DiscoveryRun; preview: EnqueuePreview }> {
  const [loc] = await db.select().from(localities).where(eq(localities.id, args.localityId)).limit(1)
  if (!loc) throw new DiscoveryEnqueueError(`Locality ${args.localityId} not found.`)
  if (loc.providerLocationCode === null) {
    throw new DiscoveryEnqueueError(
      `${loc.name}, ${loc.stateCode} has no provider location code and cannot be searched.`,
    )
  }

  const [niche] = await db.select().from(niches).where(eq(niches.id, args.nicheId)).limit(1)
  if (!niche) throw new DiscoveryEnqueueError(`Niche ${args.nicheId} not found.`)

  const devices = args.devices?.length ? args.devices : (['desktop', 'mobile'] as ResearchDevice[])
  const keywords =
    args.keywords?.length && args.keywords.length > 0
      ? args.keywords
      : expandServiceIntentKeywords({
          slug: niche.slug,
          label: niche.label,
          keywordNoun: niche.keywordNoun,
          category: niche.category,
        })

  if (keywords.length === 0) {
    throw new DiscoveryEnqueueError(`No research keywords for niche ${niche.slug}.`)
  }

  // One discovery_niches row per keyword; includeNearMe=false so we do not double-fan-out
  // (near-me variants are already inside the expanded list when relevant).
  const nicheInputs: DiscoveryNicheInput[] = keywords.map((kw) => ({
    label: niche.label,
    slug: niche.slug,
    keywordPrimary: kw,
    keywordNearMe: kw.endsWith('near me') ? kw : `${kw} near me`,
    nearMeSynthesised: !kw.endsWith('near me'),
    nicheId: niche.id,
  }))

  // ~$0.002 × keywords × devices; HVAC max 24×2 = 48 jobs ≈ $0.10. Cap with headroom.
  const estJobs = keywords.length * devices.length
  const defaultCapCents = Math.max(150, Math.ceil((estJobs * 2) / 10) + 50)

  return enqueueDiscoveryRun(db, {
    niches: nicheInputs,
    geos: [
      {
        name: loc.name,
        state: loc.stateCode,
        population: loc.population,
        kind: loc.kind as 'city' | 'county' | 'metro',
        // Authoritative code for this locality — same SERP geo as local Google users.
        providerLocationCode: loc.providerLocationCode,
        localityId: loc.id,
        locationSource: loc.locationSource ?? 'google_geotargets',
      },
    ],
    budgetCapCents: args.budgetCapCents ?? defaultCapCents,
    commentabilityMode: args.commentabilityMode ?? 'on_promote',
    label: `${loc.name}, ${loc.stateCode} · ${niche.label} · ${keywords.length} kw`,
    devices,
    source: 'market_cell',
    includeNearMe: false,
    selectionNote: `service-intent cluster: ${keywords.length} keywords × ${devices.join('+')} @ location_code=${loc.providerLocationCode}`,
  })
}

export async function enqueueDiscoveryRun(
  db: Database,
  args: {
    niches: DiscoveryNicheInput[]
    geos: DiscoveryGeoInput[]
    budgetCapCents: number
    commentabilityMode?: DiscoveryCommentabilityMode
    label?: string
    maxJobs?: number
    /** Override for tests. Default: !liveCallsEnabled(). */
    usedFixtures?: boolean
    devices?: ResearchDevice[]
    source?: DiscoveryRunSource
    includeNearMe?: boolean
    selectionNote?: string | null
    geoTierFilter?: string | null
    /** Buy per-market keyword volume ($0.09/market). Default off — see schema. */
    fetchVolume?: boolean
    /** Buy the maps pack ($0.002 per niche x market). Default off — see schema. */
    fetchMaps?: boolean
    /**
     * Queue SERPs at $0.0006 instead of buying live at $0.0020 -- a 70% saving,
     * paid for in latency. Default off so a run started to answer a question
     * right now still answers it right now.
     */
    useQueuedSerp?: boolean
    /**
     * Also measure "<keyword> <city>". Default off -- it adds one SERP per
     * keyword x geo x device. See discoveryRuns.includeGeoExplicit.
     */
    includeGeoExplicit?: boolean
  },
): Promise<{ run: DiscoveryRun; preview: EnqueuePreview }> {
  if (args.niches.length === 0) {
    throw new DiscoveryEnqueueError('At least one niche is required.')
  }
  if (args.geos.length === 0) {
    throw new DiscoveryEnqueueError('At least one geography is required.')
  }

  const devices = args.devices?.length ? args.devices : (['desktop'] as ResearchDevice[])
  const includeNearMe = args.includeNearMe !== false
  const includeGeoExplicit = args.includeGeoExplicit === true
  const source = args.source ?? 'legacy_csv'

  const basePreview = await previewDiscoveryEnqueue(db, args)
  /**
   * Device multiplies fan-out (previewDiscoveryEnqueue is keyword×geo only) and
   * the base count assumes TWO variants, so the variant factor is over 2.
   *
   * geo_explicit is an upper bound here: the variant is skipped for any market
   * with no curated modifier, so the real job count can come in under this. An
   * estimate that overshoots is the safe direction for a spend gate.
   */
  const variantsPerKeyword = 1 + (includeNearMe ? 1 : 0) + (includeGeoExplicit ? 1 : 0)
  const jobCount = Math.floor(
    (basePreview.preview.jobCount * devices.length * variantsPerKeyword) / 2,
  )
  const preview: EnqueuePreview = {
    ...basePreview.preview,
    jobCount,
    estimatedCostMicros: basePreview.preview.usedFixtures
      ? 0n
      : BigInt(jobCount) * PRICE.serpOrganicLive,
    devices: [...devices],
    includeNearMe,
    selectionNote: args.selectionNote ?? null,
    requiresLongLivedWorker: jobCount > 50 && !basePreview.preview.usedFixtures,
    maxLiveSpendUnderHardCapMicros: BigInt(basePreview.preview.hardCap) * PRICE.serpOrganicLive,
  }
  const resolvedGeos = basePreview.resolvedGeos

  if (preview.jobCount === 0) {
    const reasons = resolvedGeos
      .filter((g) => g.resolveStatus !== 'resolved')
      .slice(0, 5)
      .map((g) => `${g.rawName}: ${g.unmatchedReason ?? g.resolveStatus}`)
    throw new DiscoveryEnqueueError(
      'No purchasable jobs: every geography failed to resolve to a scannable locality.' +
        (reasons.length ? ` (${reasons.join('; ')})` : ''),
      preview,
    )
  }
  if (preview.jobCount > preview.hardCap) {
    throw new DiscoveryEnqueueError(
      `Job count ${preview.jobCount} exceeds hard cap ${preview.hardCap}. Narrow niches or geos.`,
      preview,
    )
  }
  if (preview.estimatedCostMicros > preview.budgetCapMicros && !preview.usedFixtures) {
    // Live: refuse if estimate exceeds cap (fixtures are $0).
    throw new DiscoveryEnqueueError(
      `Estimated cost exceeds budget cap. Raise budgetCapCents or shrink the grid.`,
      preview,
    )
  }

  const batch = importBatchId()
  const mode = args.commentabilityMode ?? 'on_promote'

  // Soft-match outside the write transaction (read-only against niches seed).
  const nicheIds: Array<number | null> = []
  for (const n of args.niches) {
    if (n.nicheId !== undefined && n.nicheId !== null) {
      nicheIds.push(n.nicheId)
    } else {
      nicheIds.push(
        await softMatchNicheId(db, {
          label: n.label,
          keywordPrimary: n.keywordPrimary,
          slug: n.slug,
        }),
      )
    }
  }

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(discoveryRuns)
      .values({
        status: 'pending',
        phase: 'serp',
        source,
        devices: devices.join(','),
        includeNearMe,
        includeGeoExplicit,
        fetchVolume: args.fetchVolume === true,
        fetchMaps: args.fetchMaps === true,
        useQueuedSerp: args.useQueuedSerp === true,
        geoTierFilter: args.geoTierFilter ?? null,
        estimatedCostMicros: preview.estimatedCostMicros,
        selectionNote: args.selectionNote ?? null,
        budgetCapMicros: preview.budgetCapMicros,
        spendMicros: 0n,
        usedFixtures: preview.usedFixtures,
        nicheCount: preview.nicheCount,
        geoCount: args.geos.length,
        jobCount: preview.jobCount,
        jobsDone: 0,
        jobsFailed: 0,
        jobsSkipped: 0,
        hitCount: 0,
        commentabilityMode: mode,
        label: args.label ?? null,
      })
      .returning()
    if (!run) throw new DiscoveryEnqueueError('Failed to insert discovery run.')

    const nicheRows: Array<{
      id: number
      keywordPrimary: string
      keywordNearMe: string
      researchKeywordId: number | null
    }> = []
    for (let ni = 0; ni < args.niches.length; ni++) {
      const n = args.niches[ni]!
      const [row] = await tx
        .insert(discoveryNiches)
        .values({
          runId: run.id,
          label: n.label,
          slug: n.slug ?? null,
          nicheId: nicheIds[ni] ?? null,
          keywordPrimary: n.keywordPrimary,
          keywordNearMe: n.keywordNearMe,
          nearMeSynthesised: n.nearMeSynthesised ?? false,
          importBatch: batch,
          lineNumber: n.lineNumber ?? null,
        })
        .returning({
          id: discoveryNiches.id,
          keywordPrimary: discoveryNiches.keywordPrimary,
          keywordNearMe: discoveryNiches.keywordNearMe,
        })
      nicheRows.push({
        ...row!,
        researchKeywordId: n.researchKeywordId ?? null,
      })
    }

    const geoIdByIndex: number[] = []
    for (const g of resolvedGeos) {
      const [row] = await tx
        .insert(discoveryGeos)
        .values({
          runId: run.id,
          rawName: g.rawName,
          rawState: g.rawState,
          rawPopulation: g.rawPopulation,
          rawKind: g.rawKind,
          localityId: g.localityId,
          providerLocationCode: g.providerLocationCode,
          locationSource: g.locationSource,
          resolveStatus: g.resolveStatus,
          unmatchedReason: g.unmatchedReason,
          candidateCount: g.candidateCount,
          importBatch: batch,
          lineNumber: g.lineNumber,
        })
        .returning({ id: discoveryGeos.id })
      geoIdByIndex.push(row!.id)
    }

    const jobValues: Array<{
      runId: number
      discoveryNicheId: number
      discoveryGeoId: number
      localityId: number | null
      kind: 'serp'
      keyword: string
      keywordVariant: string
      device: string
      os: string
      depth: number
      status: 'pending'
      researchKeywordId: number | null
      researchGeoId: number | null
    }> = []

    for (const n of nicheRows) {
      for (let gi = 0; gi < resolvedGeos.length; gi++) {
        const g = resolvedGeos[gi]!
        // Purchasable if resolved with a location code (locality optional).
        if (g.resolveStatus !== 'resolved' || g.providerLocationCode === null) continue
        const geoId = geoIdByIndex[gi]!
        const variants: Array<[string, string]> = [[n.keywordPrimary, 'primary']]
        if (includeNearMe) variants.push([n.keywordNearMe, 'near_me'])
        if (includeGeoExplicit) {
          /**
           * "plumber new york city" -- the string a searcher actually types,
           * which returns a different page than the city-free keyword at the
           * same location_code. applyQueryModifier declines to build one when
           * the keyword is already geo-bearing or is a "near me" query, and
           * returns the keyword unchanged; comparing catches that so the run
           * does not buy the same SERP twice under two variant names.
           */
          const explicit = applyQueryModifier(n.keywordPrimary, g.queryModifier)
          if (explicit !== n.keywordPrimary) variants.push([explicit, 'geo_explicit'])
        }
        for (const [keyword, variant] of variants) {
          for (const device of devices) {
            jobValues.push({
              runId: run.id,
              discoveryNicheId: n.id,
              discoveryGeoId: geoId,
              localityId: g.localityId,
              kind: 'serp',
              keyword,
              keywordVariant: variant,
              device,
              os: device === 'mobile' ? 'android' : 'windows',
              depth: 10,
              status: 'pending',
              researchKeywordId: n.researchKeywordId,
              researchGeoId: g.researchGeoId,
            })
          }
        }
      }
    }

    if (jobValues.length > 0) {
      // Batch insert in chunks to avoid huge statements.
      const CHUNK = 200
      for (let i = 0; i < jobValues.length; i += CHUNK) {
        await tx.insert(discoveryJobs).values(jobValues.slice(i, i + CHUNK))
      }
    }

    return { run, preview }
  })
}

// ---------------------------------------------------------------------------
// Claim / redrive
// ---------------------------------------------------------------------------

export async function claimNextDiscoveryJob(
  db: Database,
  workerId: string,
  /**
   * Confine the claim to one run. Omit for "any pending job", which is what the
   * cron and the always-on worker want -- they are general consumers. A caller
   * that was dispatched FOR a specific run (Trigger.dev) must pass it, or a
   * task triggered to drain run 18 silently drains someone else's backlog and
   * bills it to whoever is watching run 18.
   */
  opts?: { runId?: number },
): Promise<DiscoveryJob | null> {
  const runFilter = opts?.runId === undefined ? sql`` : sql`AND j2.run_id = ${opts.runId}`
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE discovery_jobs j
       SET status = 'claimed',
           claimed_at = now(),
           claimed_by = ${workerId}
     WHERE j.id = (
       SELECT j2.id
         FROM discovery_jobs j2
         INNER JOIN discovery_runs r ON r.id = j2.run_id
        WHERE j2.status = 'pending'
          AND r.status IN ('pending', 'running')
          ${runFilter}
        ORDER BY j2.id ASC
        LIMIT 1
        FOR UPDATE OF j2 SKIP LOCKED
     )
       AND j.status = 'pending'
    RETURNING j.id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null

  const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id))
  if (!job) return null

  // First claim flips run to running.
  await db.execute(sql`
    UPDATE discovery_runs
       SET status = 'running',
           started_at = COALESCE(started_at, now())
     WHERE id = ${job.runId}
       AND status = 'pending'
  `)

  return job
}

export function stuckDiscoveryJobMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['STUCK_DISCOVERY_JOB_MINUTES'])
  return Number.isFinite(raw) && raw > 0 ? raw : STUCK_DISCOVERY_JOB_MINUTES
}

export async function redriveStuckDiscoveryJobs(
  db: Database,
  minutes: number = stuckDiscoveryJobMinutes(),
): Promise<number> {
  /**
   * Terminal runs → skip abandoned claims.
   *
   * The read of `error` is QUALIFIED as j.error. Both discovery_jobs and discovery_runs
   * carry an `error` column, so a bare reference is "column reference is ambiguous" -- and
   * because this redrive runs before any job is claimed, that error failed the WHOLE drain
   * route, taking recording fetches and lead alerts down with it.
   *
   * The SET target stays unqualified; Postgres requires that. Only the read needs the alias.
   */
  const skipped = await db.execute<{ id: number }>(sql`
    UPDATE discovery_jobs j
       SET status = 'skipped',
           finished_at = now(),
           claimed_at = NULL,
           claimed_by = NULL,
           error = COALESCE(j.error, '') || 'Skipped: redriven while run terminal. '
      FROM discovery_runs r
     WHERE j.run_id = r.id
       AND j.status = 'claimed'
       AND j.claimed_at < now() - (${minutes} || ' minutes')::interval
       AND r.status NOT IN ('pending', 'running')
    RETURNING j.id
  `)

  // Active runs → return to pending once. Jobs already re-driven still stuck in claimed
  // after another timeout → fail them (stop infinite claim loops when DFS is down).
  const redriven = await db.execute<{ id: number }>(sql`
    UPDATE discovery_jobs j
       SET status = 'pending',
           claimed_at = NULL,
           claimed_by = NULL,
           error = COALESCE(j.error, '') || 'Re-driven after stuck claim. '
      FROM discovery_runs r
     WHERE j.run_id = r.id
       AND j.status = 'claimed'
       AND j.claimed_at < now() - (${minutes} || ' minutes')::interval
       AND r.status IN ('pending', 'running')
       AND COALESCE(j.error, '') NOT LIKE '%Re-driven after stuck claim.%'
    RETURNING j.id
  `)

  const failedStuck = await db.execute<{ id: number; run_id: number }>(sql`
    UPDATE discovery_jobs j
       SET status = 'failed',
           finished_at = now(),
           claimed_at = NULL,
           claimed_by = NULL,
           error = COALESCE(j.error, '') || 'Failed: stuck in claimed after redrive (provider hang or account pause). '
      FROM discovery_runs r
     WHERE j.run_id = r.id
       AND j.status = 'claimed'
       AND j.claimed_at < now() - (${minutes} || ' minutes')::interval
       AND r.status IN ('pending', 'running')
       AND COALESCE(j.error, '') LIKE '%Re-driven after stuck claim.%'
    RETURNING j.id, j.run_id
  `)

  const failedRows = failedStuck as unknown as Array<{ id: number; run_id: number }>
  const runIds = [...new Set(failedRows.map((r) => r.run_id))]
  for (const runId of runIds) {
    await rollupDiscoveryRun(db, runId)
  }

  return (
    (skipped as unknown as { id: number }[]).length +
    (redriven as unknown as { id: number }[]).length +
    failedRows.length
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function finalizeRunBudgetExceeded(db: Database, runId: number): Promise<void> {
  await db.execute(sql`
    UPDATE discovery_runs
       SET status = 'budget_exceeded',
           phase = 'complete',
           finished_at = COALESCE(finished_at, now()),
           error = COALESCE(error, '') || 'Budget cap reached. '
     WHERE id = ${runId}
       AND status IN ('pending', 'running')
  `)
  await db.execute(sql`
    UPDATE discovery_jobs
       SET status = 'skipped',
           finished_at = now(),
           error = 'Skipped: run budget exceeded.'
     WHERE run_id = ${runId}
       AND status = 'pending'
  `)
  await rollupDiscoveryRun(db, runId)
}

export async function cancelDiscoveryRun(db: Database, runId: number): Promise<void> {
  await db.execute(sql`
    UPDATE discovery_runs
       SET status = 'cancelled',
           phase = 'complete',
           finished_at = COALESCE(finished_at, now())
     WHERE id = ${runId}
       AND status IN ('pending', 'running')
  `)
  await db.execute(sql`
    UPDATE discovery_jobs
       SET status = 'skipped',
           finished_at = now(),
           error = 'Skipped: run cancelled.'
     WHERE run_id = ${runId}
       AND status = 'pending'
  `)
  await rollupDiscoveryRun(db, runId)
}

export async function rollupDiscoveryRun(db: Database, runId: number): Promise<void> {
  const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId))
  if (!run) return

  // Sticky terminal statuses stay put except counter refresh.
  const counts = await db
    .select({
      status: discoveryJobs.status,
      n: sql<number>`count(*)::int`,
    })
    .from(discoveryJobs)
    .where(eq(discoveryJobs.runId, runId))
    .groupBy(discoveryJobs.status)

  let done = 0
  let failed = 0
  let skipped = 0
  let pending = 0
  /**
   * Queued SERPs that are bought and not yet collected.
   *
   * ==================== NOT COUNTING THIS COMPLETED RUNS EARLY ====================
   * This rollup knew about done / failed / skipped / pending / claimed and
   * nothing else. A queued run posts every SERP and parks it at `awaiting`, so
   * within seconds pending and claimed both hit zero -- and the branch below
   * read that as "no work left" and marked the whole run DONE before a single
   * result had been collected.
   *
   * Everything afterwards then hit the run-status guard in runDiscoveryJob and
   * was skipped as `run_cancelled_or_done`. Run 35 finished "done" with 1 job
   * of 32 completed and the other 31 skipped, which is how this was found.
   *
   * An awaiting job is the most committed state in the system: already billed,
   * result waiting on the provider. It has to hold the run open.
   * ==============================================================================
   */
  let awaiting = 0
  let claimed = 0
  for (const c of counts) {
    if (c.status === 'done') done = c.n
    else if (c.status === 'failed') failed = c.n
    else if (c.status === 'skipped') skipped = c.n
    else if (c.status === 'pending') pending = c.n
    else if (c.status === 'claimed') claimed = c.n
    else if (c.status === 'awaiting') awaiting = c.n
  }

  const [hitRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discoveryHits)
    .where(eq(discoveryHits.runId, runId))

  await db
    .update(discoveryRuns)
    .set({
      jobsDone: done,
      jobsFailed: failed,
      jobsSkipped: skipped,
      hitCount: hitRow?.n ?? 0,
    })
    .where(eq(discoveryRuns.id, runId))

  if (['cancelled', 'budget_exceeded', 'failed', 'done'].includes(run.status)) {
    // Ensure phase complete on sticky terminals.
    if (run.phase !== 'complete') {
      await db
        .update(discoveryRuns)
        .set({ phase: 'complete', finishedAt: run.finishedAt ?? new Date() })
        .where(eq(discoveryRuns.id, runId))
    }
    return
  }

  if (pending > 0 || claimed > 0 || awaiting > 0) {
    // Still working (serp, queued collection, or future commentability).
    if (run.status === 'pending' && (done > 0 || failed > 0 || claimed > 0 || awaiting > 0)) {
      await db
        .update(discoveryRuns)
        .set({ status: 'running', startedAt: run.startedAt ?? new Date() })
        .where(eq(discoveryRuns.id, runId))
    }
    return
  }

  // No pending/claimed/awaiting. MVP: SERP-only → complete.
  let finalStatus: DiscoveryRun['status'] = 'done'
  if (done === 0 && failed > 0) finalStatus = 'failed'
  if (done === 0 && failed === 0 && skipped > 0 && run.status === 'cancelled') {
    finalStatus = 'cancelled'
  }

  await db
    .update(discoveryRuns)
    .set({
      status: finalStatus,
      phase: 'complete',
      finishedAt: new Date(),
      jobsDone: done,
      jobsFailed: failed,
      jobsSkipped: skipped,
      hitCount: hitRow?.n ?? 0,
    })
    .where(and(eq(discoveryRuns.id, runId), inArray(discoveryRuns.status, ['pending', 'running'])))
}

// ---------------------------------------------------------------------------
// Run one job
// ---------------------------------------------------------------------------

export interface DiscoveryJobOutcome {
  jobId: number
  status: 'done' | 'failed' | 'skipped' | 'requeued' | 'awaiting'
  hitCount: number
  costMicros: Micros
  error: string | null
}

async function markJob(
  db: Database,
  jobId: number,
  patch: {
    status: 'done' | 'failed' | 'skipped'
    error?: string | null
    costMicros?: Micros
    redditHitCount?: number
    measuredVia?: string | null
    rawItems?: Array<Record<string, unknown>> | null
  },
): Promise<void> {
  await db
    .update(discoveryJobs)
    .set({
      status: patch.status,
      error: patch.error ?? null,
      costMicros: patch.costMicros ?? 0n,
      redditHitCount: patch.redditHitCount ?? 0,
      measuredVia: patch.measuredVia ?? null,
      rawItems: patch.rawItems ?? null,
      finishedAt: new Date(),
      claimedAt: null,
      claimedBy: null,
    })
    .where(eq(discoveryJobs.id, jobId))
}

/**
 * Live account preflight once per run (when no SERP jobs done yet).
 * Empty SERPs under a paused account look like zero Reddit opportunities.
 */
async function maybeAccountPreflight(
  db: Database,
  providers: Providers,
  run: DiscoveryRun,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!providers.live) return { ok: true }
  if (run.jobsDone > 0) return { ok: true }

  let status: Awaited<ReturnType<Providers['accountStatus']>>
  try {
    status = await providers.accountStatus()
  } catch (e) {
    /**
     * A rate-limited preflight is INCONCLUSIVE, not a verdict.
     *
     * ==================== THIS FAILED WHOLE RUNS ====================
     * The client already retries a 40202 three times over ~7s. If it still
     * refuses, the account has told us nothing about itself -- only that we
     * asked too fast. Failing the run here marked every pending job failed for
     * a condition that clears on its own within the minute.
     *
     * Letting the run continue is safe because the preflight is not the only
     * guard: the SERP call that follows goes through the same client, so a
     * genuinely paused account still raises AccountIssueError and still aborts
     * before anything is scored. What is lost by proceeding is a slightly later
     * abort; what was lost by failing was the entire run.
     * ===============================================================
     */
    if (e instanceof RateLimitError) return { ok: true }

    // Bad credentials (401), network, etc. Must not throw after claim — that left
    // jobs stuck in `claimed` until the 3‑min redrive (UI shows 0 done for ages).
    const message = (e as Error).message ?? String(e)
    const error = `DataForSEO preflight failed: ${message}`.slice(0, 500)
    await db.execute(sql`
      UPDATE discovery_runs
         SET status = 'failed',
             phase = 'complete',
             finished_at = now(),
             error = ${error}
       WHERE id = ${run.id}
         AND status IN ('pending', 'running')
    `)
    await db.execute(sql`
      UPDATE discovery_jobs
         SET status = 'failed',
             finished_at = now(),
             claimed_at = null,
             claimed_by = null,
             error = ${error}
       WHERE run_id = ${run.id}
         AND status IN ('pending', 'claimed')
    `)
    return { ok: false, error }
  }

  if (status && !status.canMakeRequests) {
    const error =
      `DataForSEO balance is $${status.balanceUsd.toFixed(2)}. ` +
      `Refusing discovery — empty SERPs would look like zero Reddit hits.`
    await db.execute(sql`
      UPDATE discovery_runs
         SET status = 'failed',
             phase = 'complete',
             finished_at = now(),
             error = ${error}
       WHERE id = ${run.id}
         AND status IN ('pending', 'running')
    `)
    await db.execute(sql`
      UPDATE discovery_jobs
         SET status = 'skipped',
             finished_at = now(),
             claimed_at = null,
             claimed_by = null,
             error = 'Skipped: account preflight failed.'
       WHERE run_id = ${run.id}
         AND status IN ('pending', 'claimed')
    `)
    return { ok: false, error }
  }
  return { ok: true }
}

export async function runDiscoveryJob(
  db: Database,
  args: {
    job: DiscoveryJob
    providers: Providers
    /**
     * A payload obtained elsewhere -- the queued collector hands over a result
     * it already fetched and paid for. Supplying this skips the cache lookup,
     * the queue branch and the live purchase, so the job runs the identical
     * downstream processing with no second charge.
     */
    preFetched?: { rawItems: Array<Record<string, unknown>>; paidMicros: Micros }
  },
): Promise<DiscoveryJobOutcome> {
  const { job, providers, preFetched } = args

  if (job.kind !== 'serp') {
    // Commentability jobs land in PR 9; skip safely if present.
    await markJob(db, job.id, {
      status: 'skipped',
      error: 'commentability jobs not enabled in this build (PR 9).',
    })
    await rollupDiscoveryRun(db, job.runId)
    return {
      jobId: job.id,
      status: 'skipped',
      hitCount: 0,
      costMicros: 0n,
      error: 'commentability deferred',
    }
  }

  const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, job.runId))
  if (!run || (run.status !== 'pending' && run.status !== 'running')) {
    await markJob(db, job.id, {
      status: 'skipped',
      error: 'run_cancelled_or_done',
    })
    return {
      jobId: job.id,
      status: 'skipped',
      hitCount: 0,
      costMicros: 0n,
      error: 'run_cancelled_or_done',
    }
  }

  const pre = await maybeAccountPreflight(db, providers, run)
  if (!pre.ok) {
    await markJob(db, job.id, { status: 'skipped', error: pre.error })
    await rollupDiscoveryRun(db, job.runId)
    return {
      jobId: job.id,
      status: 'skipped',
      hitCount: 0,
      costMicros: 0n,
      error: pre.error,
    }
  }

  const reserveCost: Micros = providers.live ? PRICE.serpOrganicLive : 0n
  /**
   * Secondary API calls this job makes beyond the organic SERP (keyword volume,
   * maps). Reserved cost only covers the SERP; without this the per-job cost in
   * the UI is the SERP price and nothing else, which is how an $0.09 volume
   * request hid behind a $0.002 label.
   */
  let extraCostMicros: Micros = 0n
  /**
   * What this job actually cost for its SERP. Starts at the reserved price and
   * drops to zero when the payload came from cache. Hoisted out of the try
   * because the failure paths report cost too.
   */
  let serpCost: Micros = reserveCost
  const reserved = await reserveDiscoverySpend(db, {
    runId: job.runId,
    costMicros: reserveCost,
    endpoint: 'serp/discovery',
    note: `keyword=${job.keyword ?? ''}`,
    jobId: job.id,
  })

  if (reserved === 'budget_exceeded') {
    await markJob(db, job.id, { status: 'skipped', error: 'budget_exceeded' })
    await finalizeRunBudgetExceeded(db, job.runId)
    return {
      jobId: job.id,
      status: 'skipped',
      hitCount: 0,
      costMicros: 0n,
      error: 'budget_exceeded',
    }
  }
  if (reserved === 'run_terminal') {
    await markJob(db, job.id, { status: 'skipped', error: 'run_cancelled_or_done' })
    return {
      jobId: job.id,
      status: 'skipped',
      hitCount: 0,
      costMicros: 0n,
      error: 'run_cancelled_or_done',
    }
  }

  // Locality context for fixture archetype generator.
  const [loc] = job.localityId
    ? await db.select().from(localities).where(eq(localities.id, job.localityId))
    : []
  const [dn] = job.discoveryNicheId
    ? await db.select().from(discoveryNiches).where(eq(discoveryNiches.id, job.discoveryNicheId))
    : []

  const locationCode =
    (
      await db
        .select({ code: discoveryGeos.providerLocationCode })
        .from(discoveryGeos)
        .where(eq(discoveryGeos.id, job.discoveryGeoId!))
    )[0]?.code ?? loc?.providerLocationCode

  if (locationCode === null || locationCode === undefined) {
    await markJob(db, job.id, {
      status: 'failed',
      error: 'No provider location code on geo.',
      costMicros: reserveCost,
      measuredVia: providers.live ? 'dataforseo' : 'fixture',
    })
    await rollupDiscoveryRun(db, job.runId)
    return {
      jobId: job.id,
      status: 'failed',
      hitCount: 0,
      costMicros: reserveCost,
      error: 'No provider location code',
    }
  }

  try {
    const device = (job.device as 'desktop' | 'mobile') || 'desktop'
    const os =
      (job.os as 'windows' | 'android' | 'ios') ||
      (device === 'mobile' ? 'android' : 'windows')
    const depth = job.depth ?? 10

    /**
     * ============ REUSE BEFORE BUYING ============
     * discovery_jobs.raw_items already holds every SERP this project has
     * bought, and until now nothing read it back -- so re-sweeping a market
     * re-purchased every cell. Measured at 5.6% of all SERPs, two of them
     * bought the SAME DAY.
     *
     * A hit costs nothing and yields the identical payload, so everything
     * downstream (layout metrics, Reddit hits, winnability) is unchanged.
     * =============================================
     */
    const cached =
      providers.live && !preFetched
        ? await findCachedRawSerp(db, {
            keyword: job.keyword ?? '',
            locationCode,
            device,
            depth,
          })
        : null

    /**
     * The SERP price was reserved before the location was even resolved, so a
     * cache hit has to hand it back rather than quietly keep it. Refunding
     * restores the run budget AND writes a compensating ledger line, so the
     * books show the reuse instead of a purchase that never happened.
     */
    if (cached) {
      await refundDiscoverySpend(db, {
        runId: job.runId,
        costMicros: reserveCost,
        endpoint: 'serp/discovery',
        note: `cache hit: reused job ${cached.jobId} (${cached.ageDays}d old)`,
        jobId: job.id,
      })
    }
    if (cached) serpCost = 0n

    /**
     * ============ QUEUE INSTEAD OF BUYING LIVE ============
     * $0.0006 rather than $0.0020. The job stops here: a posted task takes
     * minutes, far longer than a worker should hold a slot, so the result is
     * collected later by collectQueuedSerpJobs.
     *
     * The reservation covered the LIVE price, so the difference is handed back
     * -- the run budget and the ledger both record what was actually spent.
     * ======================================================
     */
    if (!cached && !preFetched && providers.live && run.useQueuedSerp) {
      const client = createDfsClientFromEnv()
      if (client) {
        const posted = await postSerpTask(client, {
          keyword: job.keyword ?? '',
          locationCode,
          device,
          os,
          depth,
        })
        await refundDiscoverySpend(db, {
          runId: job.runId,
          costMicros: reserveCost - posted.costMicros,
          endpoint: 'serp/discovery',
          note: `queued instead of live (task ${posted.taskId})`,
          jobId: job.id,
        })
        await db
          .update(discoveryJobs)
          .set({
            status: 'awaiting',
            queuedTaskId: posted.taskId,
            queuedPostedAt: new Date(),
            costMicros: posted.costMicros,
          })
          .where(eq(discoveryJobs.id, job.id))
        return {
          jobId: job.id,
          status: 'awaiting',
          hitCount: 0,
          costMicros: posted.costMicros,
          error: null,
        }
      }
    }

    if (preFetched) serpCost = preFetched.paidMicros

    const detailed = preFetched
      ? { snapshot: null, rawItems: preFetched.rawItems }
      : cached
      ? { snapshot: null, rawItems: cached.rawItems }
      : await providers.fetchOrganicSerpDetailed(
          {
            keyword: job.keyword ?? '',
            locationCode,
            localityName: loc?.name ?? 'Unknown',
            stateCode: loc?.stateCode ?? 'XX',
            nicheNoun: dn?.keywordPrimary ?? job.keyword ?? 'service',
            nicheEmdToken: (dn?.keywordPrimary ?? 'service')
              .replace(/[^a-z0-9]/gi, '')
              .toLowerCase(),
          },
          { depth, device, os },
        )

    const hits = extractRedditHitsFromDfsResult({ items: detailed.rawItems })
    const layout = extractSerpLayoutMetrics(detailed.rawItems)
    const nicheId = dn?.nicheId ?? null
    const exactQuery = (job.keyword ?? '').trim()

    // Local search volume via DataForSEO Keywords Data (Google Ads metrics),
    // scoped to the same location_code as this SERP / map-pack market.
    // Reuse volume from a sibling job in this run when already fetched for this keyword+geo.
    let avgMonthlySearches: number | null = null
    let volumeSource: string | null = null
    let volumeGeoTarget: string | null = null
    let monthlySearches: Array<{ year: number; month: number; searchVolume: number }> = []
    let serpCompetitionIndex: number | null = null
    let serpCompetition: string | null = null
    let cpcMicros: bigint | null = null
    let lowTopOfPageBidMicros: bigint | null = null
    let highTopOfPageBidMicros: bigint | null = null

    if (exactQuery) {
      const [prior] = await db
        .select({
          avgMonthlySearches: discoverySerpMetrics.avgMonthlySearches,
          volumeSource: discoverySerpMetrics.volumeSource,
          volumeGeoTarget: discoverySerpMetrics.volumeGeoTarget,
          monthlySearches: discoverySerpMetrics.monthlySearches,
          serpCompetitionIndex: discoverySerpMetrics.serpCompetitionIndex,
          serpCompetition: discoverySerpMetrics.serpCompetition,
          cpcMicros: discoverySerpMetrics.cpcMicros,
          lowTopOfPageBidMicros: discoverySerpMetrics.lowTopOfPageBidMicros,
          highTopOfPageBidMicros: discoverySerpMetrics.highTopOfPageBidMicros,
        })
        .from(discoverySerpMetrics)
        .where(
          and(
            eq(discoverySerpMetrics.runId, job.runId),
            eq(discoverySerpMetrics.keyword, exactQuery),
            eq(discoverySerpMetrics.locationCode, locationCode),
            sql`${discoverySerpMetrics.volumeSource} IS NOT NULL`,
          ),
        )
        .limit(1)

      if (!run.fetchVolume) {
        // Switched off for this run: no request, no cost, columns stay null.
        // National Google Ads volume on `niches` is what the Screen list shows.
        volumeSource = null
      } else if (prior) {
        avgMonthlySearches = prior.avgMonthlySearches
        volumeSource = prior.volumeSource
        volumeGeoTarget = prior.volumeGeoTarget
        monthlySearches = prior.monthlySearches ?? []
        serpCompetitionIndex = prior.serpCompetitionIndex
        serpCompetition = prior.serpCompetition
        cpcMicros = prior.cpcMicros
        lowTopOfPageBidMicros = prior.lowTopOfPageBidMicros
        highTopOfPageBidMicros = prior.highTopOfPageBidMicros
      } else {
        // Volume must never fail the organic job (timeouts are common on Vercel).
        try {
          /**
           * Fetch volume for EVERY keyword this run still needs at this
           * location, not just ours. search_volume is $0.09 per request and
           * takes 1000 keywords, so the first job at a location buys the whole
           * column in one request and the rest read the cache for free. Asking
           * per keyword is what turned a 50x50 run into $225 of volume.
           */
          const runKeywords = await keywordsForRunAtLocation(db, job.runId, locationCode)
          const ensured = await ensureKeywordVolumes(db, {
            keywords: runKeywords.length > 0 ? runKeywords : [exactQuery],
            locationCode,
            live: providers.live,
            runId: job.runId,
            jobId: job.id,
          })
          extraCostMicros += ensured.costMicros

          const row = ensured.volumes.get(exactQuery.trim().toLowerCase())
          avgMonthlySearches = row?.avgMonthlySearches ?? null
          volumeSource = row?.source ?? 'skipped'
          volumeGeoTarget = row?.geoTarget ?? null
          monthlySearches = row?.monthlySearches ?? []
          serpCompetitionIndex = row?.competitionIndex ?? null
          serpCompetition = row?.competition ?? null
          cpcMicros = row?.cpcMicros ?? null
          lowTopOfPageBidMicros = row?.lowTopOfPageBidMicros ?? null
          highTopOfPageBidMicros = row?.highTopOfPageBidMicros ?? null
        } catch (volErr) {
          volumeSource = 'skipped'
          volumeGeoTarget = null
          avgMonthlySearches = null
          // leave other volume fields null
          void volErr
        }
      }
    }

    // Maps SERP once per research geo × niche (or locality) in this run — not every keyword.
    let mapsEntryCount: number | null = null
    let mapsDomains: string[] | null = null
    let mapsKeyword: string | null = null
    if (run.fetchMaps) {
      const mapsPriorConds = [
        eq(discoverySerpMetrics.runId, job.runId),
        sql`${discoverySerpMetrics.mapsEntryCount} IS NOT NULL`,
      ]
      if (job.researchGeoId != null) {
        mapsPriorConds.push(eq(discoverySerpMetrics.researchGeoId, job.researchGeoId))
      } else if (job.localityId != null) {
        mapsPriorConds.push(eq(discoverySerpMetrics.localityId, job.localityId))
      }
      if (nicheId != null) {
        mapsPriorConds.push(eq(discoverySerpMetrics.nicheId, nicheId))
      }
      const canScopeMaps = job.researchGeoId != null || job.localityId != null
      if (canScopeMaps) {
        const [mapsPrior] = await db
          .select({
            mapsEntryCount: discoverySerpMetrics.mapsEntryCount,
            mapsDomains: discoverySerpMetrics.mapsDomains,
            mapsKeyword: discoverySerpMetrics.mapsKeyword,
          })
          .from(discoverySerpMetrics)
          .where(and(...mapsPriorConds))
          .limit(1)

        if (mapsPrior?.mapsEntryCount != null) {
          mapsEntryCount = mapsPrior.mapsEntryCount
          mapsDomains = mapsPrior.mapsDomains
          mapsKeyword = mapsPrior.mapsKeyword
        } else {
          try {
            const mapsKw =
              (dn?.keywordPrimary ?? exactQuery ?? job.keyword ?? 'service').trim() || 'service'
            const pack = await providers.fetchMapPack({
              keyword: mapsKw,
              locationCode,
              localityName: loc?.name ?? 'Unknown',
              stateCode: loc?.stateCode ?? 'XX',
              nicheNoun: mapsKw,
              nicheEmdToken: mapsKw.replace(/[^a-z0-9]/gi, '').toLowerCase(),
            })
            mapsEntryCount = pack.snapshot.entryCount
            mapsDomains = pack.snapshot.domains
            mapsKeyword = mapsKw
            // Also previously invisible to the ledger. Cheap per call, but it is
            // still real money and the run total should say so.
            if (providers.live) {
              extraCostMicros += PRICE.serpMapsLive
              await recordDiscoverySpend(db, {
                runId: job.runId,
                costMicros: PRICE.serpMapsLive,
                endpoint: 'serp/google/maps/live/advanced',
                note: `maps ${mapsKw} @ ${locationCode}`,
                jobId: job.id,
              })
            }
          } catch {
            // Maps is optional decision data — don't fail the organic job.
            mapsEntryCount = null
            mapsDomains = null
            mapsKeyword = null
          }
        }
      }
    }

    for (const h of hits) {
      await db
        .insert(discoveryHits)
        .values({
          jobId: job.id,
          runId: job.runId,
          localityId: job.localityId,
          discoveryNicheId: job.discoveryNicheId,
          nicheId,
          keyword: exactQuery,
          redditUrl: h.url,
          redditPostId: h.postId,
          subreddit: h.subreddit,
          title: h.title,
          sourceKind: h.sourceKind,
          organicPosition: h.organicPosition,
          rankAbsolute: h.rankAbsolute,
          packPosition: h.packPosition,
          domain: h.domain,
          commentable: null,
        })
        .onConflictDoNothing({
          target: [discoveryHits.jobId, discoveryHits.redditPostId, discoveryHits.sourceKind],
        })
    }

    const bestRedditRankAbsolute =
      hits.reduce<number | null>((best, h) => {
        if (h.rankAbsolute == null) return best
        if (best == null || h.rankAbsolute < best) return h.rankAbsolute
        return best
      }, null)

    await db.insert(discoverySerpMetrics).values({
      jobId: job.id,
      runId: job.runId,
      localityId: job.localityId,
      nicheId,
      researchKeywordId: job.researchKeywordId,
      researchGeoId: job.researchGeoId,
      keyword: exactQuery,
      keywordVariant: job.keywordVariant,
      device,
      os,
      locationCode,
      firstOrganicRankAbsolute: layout.firstOrganicRankAbsolute,
      adsAboveOrganicCount: layout.adsAboveOrganicCount,
      localProfilesAboveOrganicCount: layout.localProfilesAboveOrganicCount,
      organicCount: layout.organicCount,
      paidCount: layout.paidCount,
      localPackCount: layout.localPackCount,
      discussionsPackPresent: layout.discussionsPackPresent,
      redditHitCount: hits.length,
      relatedSearches: layout.relatedSearches,
      itemTypes: layout.itemTypes,
      mapPresent: layout.mapPresent,
      mapRankAbsolute: layout.mapRankAbsolute,
      lsaCount: layout.lsaCount,
      lsaAboveOrganicCount: layout.lsaAboveOrganicCount,
      lsaRankAbsolute: layout.lsaRankAbsolute,
      localBusinessCount: layout.localBusinessCount,
      localBusinessAboveOrganicCount: layout.localBusinessAboveOrganicCount,
      localPackRankAbsolute: layout.localPackRankAbsolute,
      forumsCount: layout.forumsCount,
      forumsRankAbsolute: layout.forumsRankAbsolute,
      bestRedditRankAbsolute,
      sponsoredAboveOrganicCount: layout.sponsoredAboveOrganicCount,
      avgMonthlySearches,
      volumeSource,
      volumeGeoTarget,
      monthlySearches: monthlySearches.length > 0 ? monthlySearches : null,
      serpCompetitionIndex,
      serpCompetition,
      cpcMicros,
      lowTopOfPageBidMicros,
      highTopOfPageBidMicros,
      topOrganicDomains: layout.topOrganicDomains,
      gbpLeaders: layout.gbpLeaders,
      hasAiOverview: layout.hasAiOverview,
      hasPeopleAlsoAsk: layout.hasPeopleAlsoAsk,
      mapsEntryCount,
      mapsDomains,
      mapsKeyword,
    })

    await markJob(db, job.id, {
      status: 'done',
      costMicros: serpCost + extraCostMicros,
      redditHitCount: hits.length,
      measuredVia: providers.live ? 'dataforseo' : 'fixture',
      rawItems: detailed.rawItems,
    })
    await rollupDiscoveryRun(db, job.runId)
    return {
      jobId: job.id,
      status: 'done',
      hitCount: hits.length,
      costMicros: serpCost + extraCostMicros,
      error: null,
    }
  } catch (e) {
    const message = ((e as Error).message ?? String(e)).slice(0, 500)

    // Account pause (40201) will fail every remaining purchase.
    if (e instanceof AccountIssueError || /40201|account.*paused|unusual activity/i.test(message)) {
      await markJob(db, job.id, {
        status: 'failed',
        error: message,
        costMicros: serpCost + extraCostMicros,
        measuredVia: providers.live ? 'dataforseo' : 'fixture',
      })
      await failRemainingDiscoveryJobs(db, job.runId, message)
      await db
        .update(discoveryRuns)
        .set({
          status: 'failed',
          phase: 'complete',
          finishedAt: new Date(),
          error: message.slice(0, 500),
        })
        .where(and(eq(discoveryRuns.id, job.runId), inArray(discoveryRuns.status, ['pending', 'running'])))
      await rollupDiscoveryRun(db, job.runId)
      return {
        jobId: job.id,
        status: 'failed',
        hitCount: 0,
        costMicros: serpCost + extraCostMicros,
        error: message,
      }
    }

    // Timeouts / SE blips: requeue — permanent fail is very bad for board research.
    if (isRetriableDiscoveryError(e)) {
      const rq = await requeueDiscoveryJob(db, {
        jobId: job.id,
        runId: job.runId,
        reservedCostMicros: reserveCost,
        reason: message,
        previousError: job.error,
      })
      return {
        jobId: job.id,
        status: rq.status === 'requeued' ? 'requeued' : 'failed',
        hitCount: 0,
        costMicros: rq.status === 'requeued' ? 0n : serpCost,
        error: message,
      }
    }

    await markJob(db, job.id, {
      status: 'failed',
      error: message,
      costMicros: serpCost + extraCostMicros,
      measuredVia: providers.live ? 'dataforseo' : 'fixture',
    })
    await rollupDiscoveryRun(db, job.runId)
    return {
      jobId: job.id,
      status: 'failed',
      hitCount: 0,
      costMicros: serpCost + extraCostMicros,
      error: message,
    }
  }
}

/** Mark pending/claimed siblings failed so a run cannot stick on "running". */
async function failRemainingDiscoveryJobs(
  db: Database,
  runId: number,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE discovery_jobs
       SET status = 'failed',
           finished_at = now(),
           claimed_at = null,
           claimed_by = null,
           error = ${reason.slice(0, 500)}
     WHERE run_id = ${runId}
       AND status IN ('pending', 'claimed')
  `)
}

export { reconcileDiscoverySpend }

/**
 * Collect queued SERPs whose results DataForSEO says are ready.
 *
 * ==================== THE DANGEROUS HALF ====================
 * Every job here has ALREADY BEEN PAID FOR. A bug that drops a task id, or
 * fetches before `tasks_ready` lists it, destroys a purchased result silently:
 * task_get on an unready task answers 40601 "Task Handed" and the payload is
 * gone, with no exception raised. That was reproduced, not theorised.
 *
 * So: ask tasks_ready first, fetch each id exactly once, and only mark a job
 * failed when DataForSEO returns an empty result for a task it declared ready.
 * A task that has not appeared yet is simply left alone for the next pass.
 * ============================================================
 */
export async function collectQueuedSerpJobs(
  db: Database,
  args: { providers: Providers; maxJobs?: number },
): Promise<{ collected: number; stillWaiting: number; failed: number }> {
  const client = createDfsClientFromEnv()
  if (!client) return { collected: 0, stillWaiting: 0, failed: 0 }

  const awaiting = await db
    .select()
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.status, 'awaiting'), isNotNull(discoveryJobs.queuedTaskId)))
    .orderBy(discoveryJobs.queuedPostedAt)
    .limit(args.maxJobs ?? 500)

  if (awaiting.length === 0) return { collected: 0, stillWaiting: 0, failed: 0 }

  const ready = await fetchReadyTaskIds(client)
  let collected = 0
  let failed = 0
  let stillWaiting = 0

  for (const job of awaiting) {
    const taskId = job.queuedTaskId
    if (!taskId || !ready.has(taskId)) {
      stillWaiting += 1
      continue
    }

    /**
     * ==================== CLAIM BEFORE FETCHING, OR COLLECT TWICE ====================
     * The awaiting rows above are read WITHOUT a lock, so two overlapping
     * collectors saw the same job and both processed it. Observed on run 36:
     * four jobs failed with
     *
     *   duplicate key value violates unique constraint
     *   "discovery_serp_metrics_job_uq"
     *
     * -- the second pass inserting metrics for a job the first had already
     * recorded. The jobs were then marked failed even though their data had
     * landed, and their raw_items were lost in the collision.
     *
     * Worse than the bookkeeping: the second pass calls task_get on an id the
     * first pass already consumed, and this file's own warning says what that
     * does -- 40601 "Task Handed", result gone, no exception. Double collection
     * is a way to destroy a purchased SERP.
     *
     * This conditional UPDATE is the gate. Exactly one collector transitions a
     * job out of `awaiting`; anyone else gets no row back and moves on. The
     * claim happens only for tasks tasks_ready has listed, so an unready job is
     * still simply left alone.
     * ================================================================================
     */
    const claimed = await db
      .update(discoveryJobs)
      .set({ status: 'claimed', claimedAt: new Date(), claimedBy: 'queued-collector' })
      .where(and(eq(discoveryJobs.id, job.id), eq(discoveryJobs.status, 'awaiting')))
      .returning({ id: discoveryJobs.id })
    if (claimed.length === 0) {
      // Another collector got there first. Not an error, and not still-waiting.
      continue
    }

    try {
      const result = await getSerpTaskResult(client, taskId)
      if (result.rawItems.length === 0) {
        // Declared ready and returned nothing. Recording it as failed is
        // honest; retrying would re-post and pay a second time.
        await markJob(db, job.id, {
          status: 'failed',
          error: `Queued task ${taskId} was ready but returned no items.`,
          costMicros: job.costMicros,
        })
        failed += 1
        continue
      }

      /**
       * Hand the payload back to the ordinary path so layout metrics, Reddit
       * extraction, volume, maps and everything else run identically. The cost
       * travels with it because it was paid at post time.
       */
      await runDiscoveryJob(db, {
        job: { ...job, status: 'claimed' } as DiscoveryJob,
        providers: args.providers,
        preFetched: { rawItems: result.rawItems, paidMicros: job.costMicros },
      })
      collected += 1
    } catch (err) {
      /**
       * Put the job BACK to awaiting. It was claimed a few lines up, and a job
       * left `claimed` here would be invisible to the next collection pass --
       * which only looks at `awaiting` -- and stranded until the redrive.
       * Failing it outright would discard a result we own.
       */
      await db
        .update(discoveryJobs)
        .set({ status: 'awaiting', claimedAt: null, claimedBy: null })
        .where(and(eq(discoveryJobs.id, job.id), eq(discoveryJobs.status, 'claimed')))
      stillWaiting += 1
      void err
    }
  }

  return { collected, stillWaiting, failed }
}
