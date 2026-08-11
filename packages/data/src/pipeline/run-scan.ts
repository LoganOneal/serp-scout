import 'server-only'
import { and, eq } from 'drizzle-orm'
import pLimit from 'p-limit'
import {
  assessEmd,
  buildMatchContext,
  classifyResult,
  estimateDemand,
  modelRent,
  normaliseDomain,
  scoreDifficulty,
  type ClassifiedResult,
  type DomainAuthority,
  type MapPackSnapshot,
  type Micros,
  type SerpSnapshot,
} from '@rnr/core'
import type { Database } from '../db.js'
import { BudgetGuard } from '../budget.js'
import {
  readAuthorityCache,
  readAvailabilityCache,
  readSerpCache,
  writeAuthorityCache,
  writeAvailabilityCache,
  writeSerpCache,
} from '../cache.js'
import { localities, niches, scanTargets } from '../schema.js'
import type { Providers } from '../providers/index.js'
import { checkAvailabilityBatch, emdDomain, type AvailabilityResult } from '../providers/rdap.js'
import { AccountIssueError, BudgetExceededError } from '../providers/dataforseo/errors.js'
import { markRunStatus, touchRun } from '../queue.js'

/**
 * One scan: one locality, every active niche, three phases.
 *
 * ==================== NO TWO-STAGE FUNNEL ====================
 * An earlier version scored cheaply first and only bought full data for
 * survivors. At 40 niches, scoring EVERYTHING at full fidelity costs about
 * $0.24. The funnel added a cheap-scoring path, a promotion rule, and a score
 * gate that silently dropped most rows from the results table -- all to save
 * roughly twenty cents, and it made the output worse. Every niche is scored at
 * full fidelity here.
 * =============================================================
 */

/** PRIOR. Concurrency for phase 1. Enough to be quick, low enough to stay polite. */
export const SERP_CONCURRENCY = 6

export interface RunScanResult {
  runId: number
  localitySlug: string
  nicheCount: number
  scored: number
  spendMicros: Micros
  usedFixtures: boolean
  status: 'done' | 'failed' | 'budget_exceeded'
  error?: string
}

interface NicheWork {
  nicheId: number
  slug: string
  label: string
  keyword: string
  keywordNoun: string
  emdToken: string
  domainStems: string[]
  demandPerCapitaPer1k: number
  valuePerSearchMicros: bigint
  rentFloorMicros: bigint
  rentCeilingMicros: bigint
  serp: SerpSnapshot | null
  mapPack: MapPackSnapshot | null
  fetchError: string | null
}

export async function runScan(args: {
  db: Database
  providers: Providers
  runId: number
  localityId: number
  budgetCapMicros: Micros
  startingSpendMicros?: Micros
  log?: (msg: string) => void
}): Promise<RunScanResult> {
  const { db, providers, runId } = args
  const log = args.log ?? (() => {})
  const budget = new BudgetGuard(db, runId, args.budgetCapMicros, args.startingSpendMicros ?? 0n)

  const [locality] = await db.select().from(localities).where(eq(localities.id, args.localityId))
  if (!locality) throw new Error(`Locality ${args.localityId} not found`)
  if (locality.providerLocationCode === null) {
    // Unresolved localities are excluded from scanning by design -- scanning one
    // would require widening to a broader location code, which returns a
    // well-formed SERP for the wrong place.
    const error = `${locality.name}, ${locality.stateCode} has no provider location code (${locality.unmatchedReason ?? 'unresolved'}). Cannot scan.`
    await markRunStatus(db, runId, 'failed', { error })
    return {
      runId,
      localitySlug: locality.slug,
      nicheCount: 0,
      scored: 0,
      spendMicros: 0n,
      usedFixtures: !providers.live,
      status: 'failed',
      error,
    }
  }
  /**
   * Live scan needs a location code. Corpus ingest labels most US cities
   * `google_geotargets` (complete free file); those IDs match DataForSEO for the
   * bulk of US places. Still refuse when there is no code at all (handled above).
   */
  if (providers.live && locality.providerLocationCode === null) {
    const error =
      `${locality.name}, ${locality.stateCode} has no provider location code. ` +
      'Re-run `pnpm ingest:geo` to attach codes.'
    await markRunStatus(db, runId, 'failed', { error })
    return {
      runId,
      localitySlug: locality.slug,
      nicheCount: 0,
      scored: 0,
      spendMicros: 0n,
      usedFixtures: false,
      status: 'failed',
      error,
    }
  }

  const locationCode = locality.providerLocationCode

  const activeNiches = await db.select().from(niches).where(eq(niches.active, true))
  await markRunStatus(db, runId, 'running', { nicheCount: activeNiches.length })
  log(`Scanning ${locality.name}, ${locality.stateCode} across ${activeNiches.length} niches.`)

  // --- Preflight: is the account usable at all? ---------------------------
  if (providers.live) {
    const status = await providers.accountStatus()
    if (status && !status.canMakeRequests) {
      const error = `DataForSEO balance is $${status.balanceUsd.toFixed(4)}. Refusing to scan -- an unusable account returns empty SERPs, which score as wide-open markets.`
      await markRunStatus(db, runId, 'failed', { error })
      return {
        runId,
        localitySlug: locality.slug,
        nicheCount: activeNiches.length,
        scored: 0,
        spendMicros: 0n,
        usedFixtures: false,
        status: 'failed',
        error,
      }
    }
    log(`Account balance $${status?.balanceUsd.toFixed(4) ?? '?'}, cap ${budget.describe()}.`)
  }

  const work: NicheWork[] = activeNiches.map((n) => ({
    nicheId: n.id,
    slug: n.slug,
    label: n.label,
    keyword: `${locality.name.toLowerCase()} ${n.keywordNoun}`,
    keywordNoun: n.keywordNoun,
    emdToken: n.emdToken,
    domainStems: n.domainStems,
    demandPerCapitaPer1k: n.demandPerCapitaPer1k,
    valuePerSearchMicros: n.valuePerSearchMicros,
    rentFloorMicros: n.rentFloorMicros,
    rentCeilingMicros: n.rentCeilingMicros,
    serp: null,
    mapPack: null,
    fetchError: null,
  }))

  // =======================================================================
  // PHASE 1 -- SERP + map pack per niche, cache-first
  // =======================================================================
  const limit = pLimit(SERP_CONCURRENCY)
  // An array rather than a mutable `Error | null`: TypeScript's control-flow
  // analysis does not track assignments made inside the closures below, so a
  // scalar would narrow to `never` at the check after this block.
  const fatalErrors: Error[] = []

  await Promise.all(
    work.map((w) =>
      limit(async () => {
        if (fatalErrors.length > 0) return
        try {
          w.serp = await fetchSerpCached(db, providers, budget, {
            keyword: w.keyword,
            locationCode,
            seType: 'organic',
            localityName: locality.name,
            stateCode: locality.stateCode,
            nicheNoun: w.keywordNoun,
            nicheEmdToken: w.emdToken,
          })
          w.mapPack = await fetchMapPackCached(db, providers, budget, {
            keyword: w.keyword,
            locationCode,
            localityName: locality.name,
            stateCode: locality.stateCode,
            nicheNoun: w.keywordNoun,
            nicheEmdToken: w.emdToken,
          })
        } catch (e) {
          if (e instanceof AccountIssueError || e instanceof BudgetExceededError) {
            // Fatal. Must not be recorded as "this niche had no competitors".
            fatalErrors.push(e)
            return
          }
          w.fetchError = (e as Error).message
        }
      }),
    ),
  )

  const fatalError = fatalErrors[0]
  if (fatalError) {
    const status = fatalError instanceof BudgetExceededError ? 'budget_exceeded' : 'failed'
    await markRunStatus(db, runId, status, { error: fatalError.message })
    return {
      runId,
      localitySlug: locality.slug,
      nicheCount: work.length,
      scored: 0,
      spendMicros: budget.spentMicros,
      usedFixtures: !providers.live,
      status,
      error: fatalError.message,
    }
  }
  await touchRun(db, runId)
  log(`Phase 1 done. ${work.filter((w) => w.serp).length}/${work.length} SERPs, ${budget.describe()}.`)

  // =======================================================================
  // PHASE 2 -- THE BARRIER
  //
  // Collect every unique domain across ALL niches and buy link data in ONE
  // batched call set. This is the single most cost-sensitive decision in the
  // codebase: the bulk endpoints charge $0.024 PER REQUEST plus $0.000036 per
  // row, so 40 per-niche lookups pay the request fee 40 times for identical
  // rows -- roughly 10x the batched cost for exactly the same data.
  //
  // It is a genuine barrier: scoring cannot start until link data for the whole
  // locality is in hand, because a domain appearing on six SERPs must be bought
  // once, not six times.
  // =======================================================================
  const allDomains = new Set<string>()
  for (const w of work) {
    for (const item of w.serp?.items ?? []) allDomains.add(normaliseDomain(item.domain))
  }
  const domainList = [...allDomains].filter(Boolean)

  const cached = await readAuthorityCache(db, domainList)
  log(
    `Phase 2: ${domainList.length} unique domains -- ${cached.hits.size} cached, ` +
      `${cached.knownUnresolved.size} negative-cached, ${cached.misses.length} to buy.`,
  )

  const authorities = new Map<string, DomainAuthority>(cached.hits)
  if (cached.misses.length > 0) {
    try {
      const estimate = estimateBacklinksCost(cached.misses.length, providers.live)
      budget.assertCanSpend(estimate)
      const fetched = await providers.fetchBulkBacklinks(cached.misses)
      await budget.record({
        endpoint: 'backlinks/bulk_* (x3, batched)',
        costMicros: fetched.costMicros,
        rows: cached.misses.length,
        note: `one batched call set for ${cached.misses.length} domains across ${work.length} niches`,
      })
      await writeAuthorityCache(db, {
        authorities: fetched.authorities,
        unresolved: fetched.unresolved,
      })
      for (const [k, v] of fetched.authorities) authorities.set(k, v)
    } catch (e) {
      if (e instanceof AccountIssueError || e instanceof BudgetExceededError) {
        const status = e instanceof BudgetExceededError ? 'budget_exceeded' : 'failed'
        await markRunStatus(db, runId, status, { error: e.message })
        return {
          runId,
          localitySlug: locality.slug,
          nicheCount: work.length,
          scored: 0,
          spendMicros: budget.spentMicros,
          usedFixtures: !providers.live,
          status,
          error: e.message,
        }
      }
      // A non-fatal link-data failure leaves authorities partially populated.
      // The scorer omits what is missing and reports reduced coverage; it does
      // NOT treat these domains as having zero links.
      log(`Link data fetch failed (non-fatal): ${(e as Error).message}`)
    }
  }
  await touchRun(db, runId)

  // =======================================================================
  // PHASE 3 -- score, assess, check availability, persist
  // =======================================================================

  // Availability for every candidate EMD. RDAP is free, so there is no funnel
  // here either -- checking all 40 costs nothing and a missing check would
  // silently block the 30-day band.
  const emdDomains = work.map((w) => emdDomain(locality.name, w.emdToken))
  const availabilityCache = await readAvailabilityCache(db, emdDomains)
  const toCheck = emdDomains.filter((d) => !availabilityCache.has(d))
  if (toCheck.length > 0) {
    const fresh = await checkAvailabilityBatch(toCheck)
    await writeAvailabilityCache(db, fresh.values())
    for (const [k, v] of fresh) availabilityCache.set(k, v)
  }
  log(`Phase 3: availability for ${emdDomains.length} EMDs (${toCheck.length} freshly checked).`)

  let scored = 0
  for (const w of work) {
    if (!w.serp) continue

    const ctx = buildMatchContext({
      localityName: locality.name,
      nicheEmdToken: w.emdToken,
      nicheDomainStems: w.domainStems,
    })
    const classified: ClassifiedResult[] = w.serp.items.map((item) =>
      classifyResult(item, ctx, authorities.get(normaliseDomain(item.domain)) ?? null),
    )

    const hasLocalPack = w.mapPack?.hasLocalPack ?? false
    const difficulty = scoreDifficulty({ results: classified, hasLocalPack })

    const demand = estimateDemand({
      population: locality.population,
      niche: { demandPerCapitaPer1k: w.demandPerCapitaPer1k, label: w.label },
    })
    const rent = modelRent({
      monthlySearches: demand?.monthlySearches ?? null,
      niche: {
        valuePerSearchMicros: w.valuePerSearchMicros,
        rentFloorMicros: w.rentFloorMicros,
        rentCeilingMicros: w.rentCeilingMicros,
        label: w.label,
      },
    })

    const domain = emdDomain(locality.name, w.emdToken)
    const availability: AvailabilityResult | undefined = availabilityCache.get(domain)

    const emd = assessEmd({
      domain,
      difficulty,
      // No population => no volume estimate => the volume gate cannot pass. 0 is
      // the honest input here because the gate needs a number, and the blocker
      // text says the figure is estimated.
      volume: demand?.monthlySearches ?? 0,
      domainAvailable: availability?.available ?? null,
      hasLocalPack,
      emdAlreadyRanks: classified.some((r) => r.item.domain === domain),
    })

    await db
      .insert(scanTargets)
      .values({
        scanRunId: runId,
        localityId: locality.id,
        nicheId: w.nicheId,
        keyword: w.keyword,
        difficulty: difficulty.difficulty,
        weightCovered: difficulty.weightCovered,
        components: difficulty.components,
        verdict: emd.verdict,
        blockers: emd.blockers,
        gates: emd.gates,
        volumeEst: demand?.monthlySearches ?? null,
        volumeEstimated: true,
        rentMicros: rent?.rentMicros ?? null,
        slotsOpen: difficulty.slotsOpen,
        platformHeldSlots: difficulty.platformHeldSlots,
        medianRefDomains: difficulty.medianNonPlatformRefDomains,
        linkDataMeasured: difficulty.linkDataMeasured,
        emdDomain: domain,
        emdAvailable: availability?.available ?? null,
        emdAvailabilityMethod: availability?.method ?? null,
        emdAvailabilityDetail: availability?.detail ?? null,
        results: classified,
        mapPack: w.mapPack,
      })
      .onConflictDoNothing({ target: [scanTargets.scanRunId, scanTargets.nicheId] })
    scored++
  }

  await markRunStatus(db, runId, 'done', { nicheCount: work.length })
  log(`Done. ${scored}/${work.length} niches scored. Spend: ${budget.describe()}.`)

  return {
    runId,
    localitySlug: locality.slug,
    nicheCount: work.length,
    scored,
    spendMicros: budget.spentMicros,
    usedFixtures: !providers.live,
    status: 'done',
  }
}

// ---------------------------------------------------------------------------

function estimateBacklinksCost(domainCount: number, live: boolean): Micros {
  if (!live) return 0n
  // Three requests, each charged per-request plus per-row.
  return 3n * (24_000n + 36n * BigInt(domainCount))
}

async function fetchSerpCached(
  db: Database,
  providers: Providers,
  budget: BudgetGuard,
  args: {
    keyword: string
    locationCode: number
    seType: 'organic'
    localityName: string
    stateCode: string
    nicheNoun: string
    nicheEmdToken: string
  },
): Promise<SerpSnapshot> {
  const cached = await readSerpCache(db, {
    keyword: args.keyword,
    locationCode: args.locationCode,
    seType: 'organic',
  })
  if (cached) {
    const snap = cached.payload as SerpSnapshot
    return { ...snap, source: 'cache' }
  }

  const estimate = providers.live ? 2_000n : 0n
  budget.assertCanSpend(estimate)
  const { snapshot, costMicros } = await providers.fetchOrganicSerp({
    keyword: args.keyword,
    locationCode: args.locationCode,
    localityName: args.localityName,
    stateCode: args.stateCode,
    nicheNoun: args.nicheNoun,
    nicheEmdToken: args.nicheEmdToken,
  })
  await budget.record({
    endpoint: 'serp/google/organic/live/advanced',
    costMicros,
    note: args.keyword,
  })
  await writeSerpCache(db, {
    keyword: args.keyword,
    locationCode: args.locationCode,
    seType: 'organic',
    payload: snapshot,
    costMicros,
    source: providers.live ? 'live' : 'fixture',
  })
  return snapshot
}

async function fetchMapPackCached(
  db: Database,
  providers: Providers,
  budget: BudgetGuard,
  args: {
    keyword: string
    locationCode: number
    localityName: string
    stateCode: string
    nicheNoun: string
    nicheEmdToken: string
  },
): Promise<MapPackSnapshot> {
  const cached = await readSerpCache(db, {
    keyword: args.keyword,
    locationCode: args.locationCode,
    seType: 'maps',
  })
  if (cached) {
    const snap = cached.payload as MapPackSnapshot
    return { ...snap, source: 'cache' }
  }

  const estimate = providers.live ? 2_000n : 0n
  budget.assertCanSpend(estimate)
  const { snapshot, costMicros } = await providers.fetchMapPack({
    keyword: args.keyword,
    locationCode: args.locationCode,
    localityName: args.localityName,
    stateCode: args.stateCode,
    nicheNoun: args.nicheNoun,
    nicheEmdToken: args.nicheEmdToken,
  })
  await budget.record({
    endpoint: 'serp/google/maps/live/advanced',
    costMicros,
    note: args.keyword,
  })
  await writeSerpCache(db, {
    keyword: args.keyword,
    locationCode: args.locationCode,
    seType: 'maps',
    payload: snapshot,
    costMicros,
    source: providers.live ? 'live' : 'fixture',
  })
  return snapshot
}

export { and }
