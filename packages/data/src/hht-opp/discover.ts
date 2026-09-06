import 'server-only'
import {
  clampDiscoveryLimit,
  creativeQueriesFromYield,
  HHT_OPP_DISCOVERY_DEFAULTS,
  HHT_OPP_DISCOVERY_STRATEGY_ORDER,
  planDiscoveryTargets,
  selectDiscoveryBatch,
  type HhtOppSearchStrategy,
  type SearchProvider,
} from '@rnr/core'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import {
  hhtOppDiscoveredDomains,
  hhtOppDiscoveryRuns,
  hhtOppDomains,
  hhtOppOpportunities,
  hhtOppSearchQueries,
} from '../schema.js'
import { researchHhtOppSeed, type ResearchSeedResult } from './research.js'
import { createHhtOppSearchProvider } from './search.js'

export interface HhtOppDiscoveryOptions {
  name?: string
  queryLimit?: number
  domainLimit?: number
  strategies?: HhtOppSearchStrategy[]
  searchProvider?: SearchProvider
  fetchImpl?: typeof fetch
  runId?: number
  useFixture?: boolean
}

export interface HhtOppDiscoveryResult {
  runId: number
  status: 'completed' | 'failed'
  provider: string
  live: boolean
  queries: number
  hits: number
  newDomains: number
  researched: number
  created: number
  updated: number
  pass: number
  error: string | null
}

interface RunNotes {
  queryLimit: number
  domainLimit: number
  strategies?: HhtOppSearchStrategy[]
  provider?: string
  live?: boolean
  useFixture?: boolean
  queries?: number
  hits?: number
  newDomains?: number
  researched?: number
  created?: number
  updated?: number
  pass?: number
  error?: string | null
}

export function parseDiscoveryRunNotes(raw: string | null | undefined): RunNotes {
  if (!raw?.trim()) {
    return {
      queryLimit: HHT_OPP_DISCOVERY_DEFAULTS.queryLimit,
      domainLimit: HHT_OPP_DISCOVERY_DEFAULTS.domainLimit,
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunNotes>
    return {
      queryLimit: clampDiscoveryLimit(
        parsed.queryLimit,
        HHT_OPP_DISCOVERY_DEFAULTS.queryLimit,
        HHT_OPP_DISCOVERY_DEFAULTS.maxQueryLimit,
      ),
      domainLimit: clampDiscoveryLimit(
        parsed.domainLimit,
        HHT_OPP_DISCOVERY_DEFAULTS.domainLimit,
        HHT_OPP_DISCOVERY_DEFAULTS.maxDomainLimit,
      ),
      strategies: Array.isArray(parsed.strategies)
        ? parsed.strategies.filter((value): value is HhtOppSearchStrategy =>
            HHT_OPP_DISCOVERY_STRATEGY_ORDER.includes(value),
          )
        : undefined,
      provider: parsed.provider,
      live: parsed.live,
      useFixture: parsed.useFixture,
      queries: parsed.queries,
      hits: parsed.hits,
      newDomains: parsed.newDomains,
      researched: parsed.researched,
      created: parsed.created,
      updated: parsed.updated,
      pass: parsed.pass,
      error: parsed.error ?? null,
    }
  } catch {
    return {
      queryLimit: HHT_OPP_DISCOVERY_DEFAULTS.queryLimit,
      domainLimit: HHT_OPP_DISCOVERY_DEFAULTS.domainLimit,
    }
  }
}

export async function createHhtOppDiscoveryRun(
  db: Database,
  options: HhtOppDiscoveryOptions = {},
): Promise<{ id: number }> {
  const queryLimit = clampDiscoveryLimit(
    options.queryLimit,
    HHT_OPP_DISCOVERY_DEFAULTS.queryLimit,
    HHT_OPP_DISCOVERY_DEFAULTS.maxQueryLimit,
  )
  const domainLimit = clampDiscoveryLimit(
    options.domainLimit,
    HHT_OPP_DISCOVERY_DEFAULTS.domainLimit,
    HHT_OPP_DISCOVERY_DEFAULTS.maxDomainLimit,
  )
  const notes: RunNotes = {
    queryLimit,
    domainLimit,
    strategies: options.strategies,
    useFixture: options.useFixture,
  }
  const inserted = await db
    .insert(hhtOppDiscoveryRuns)
    .values({
      name: options.name?.trim() || `Discovery ${new Date().toISOString().slice(0, 16)}`,
      status: 'queued',
      notes: JSON.stringify(notes),
      startedAt: new Date(),
    })
    .returning({ id: hhtOppDiscoveryRuns.id })
  return { id: inserted[0]!.id }
}

export async function failHhtOppDiscoveryRun(db: Database, runId: number, message: string): Promise<void> {
  const [row] = await db
    .select({ notes: hhtOppDiscoveryRuns.notes })
    .from(hhtOppDiscoveryRuns)
    .where(eq(hhtOppDiscoveryRuns.id, runId))
    .limit(1)
  const notes = parseDiscoveryRunNotes(row?.notes)
  await db
    .update(hhtOppDiscoveryRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      notes: JSON.stringify({ ...notes, error: message }),
    })
    .where(eq(hhtOppDiscoveryRuns.id, runId))
}

export async function runHhtOppDiscovery(
  db: Database,
  options: HhtOppDiscoveryOptions = {},
): Promise<HhtOppDiscoveryResult> {
  const runId = options.runId ?? (await createHhtOppDiscoveryRun(db, options)).id
  return executeHhtOppDiscoveryRun(db, runId, options)
}

export async function executeHhtOppDiscoveryRun(
  db: Database,
  runId: number,
  options: Omit<HhtOppDiscoveryOptions, 'runId'> = {},
): Promise<HhtOppDiscoveryResult> {
  const [run] = await db.select().from(hhtOppDiscoveryRuns).where(eq(hhtOppDiscoveryRuns.id, runId)).limit(1)
  if (!run) throw new Error(`Discovery run ${runId} was not found.`)

  const notes = parseDiscoveryRunNotes(run.notes)
  const queryLimit = options.queryLimit ?? notes.queryLimit
  const domainLimit = options.domainLimit ?? notes.domainLimit
  const strategies = options.strategies ?? notes.strategies
  const useFixture = options.useFixture ?? notes.useFixture ?? false
  const provider = options.searchProvider ?? createHhtOppSearchProvider(process.env, { fixture: useFixture })

  await db
    .update(hhtOppDiscoveryRuns)
    .set({
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
      notes: JSON.stringify({
        ...notes,
        queryLimit,
        domainLimit,
        strategies,
        useFixture,
        provider: provider.id,
        live: provider.live,
      }),
    })
    .where(eq(hhtOppDiscoveryRuns.id, runId))

  const result: HhtOppDiscoveryResult = {
    runId,
    status: 'completed',
    provider: provider.id,
    live: provider.live,
    queries: 0,
    hits: 0,
    newDomains: 0,
    researched: 0,
    created: 0,
    updated: 0,
    pass: 0,
    error: null,
  }

  try {
    const existingDomains = new Set(
      (await db.select({ rootDomain: hhtOppDomains.rootDomain }).from(hhtOppDomains)).map((row) => row.rootDomain),
    )
    const priorYield = await db
      .select({
        query: hhtOppSearchQueries.query,
        pass: hhtOppSearchQueries.passDomains,
      })
      .from(hhtOppSearchQueries)
    const creative = creativeQueriesFromYield(priorYield, queryLimit > 4 ? 1 : 0)
    const batch = [
      ...selectDiscoveryBatch({
        limit: queryLimit - creative.length,
        strategies,
        excludeQueries: [...priorYield.map((row) => row.query), ...creative.map((row) => row.query)],
      }),
      ...creative,
    ]

    let remaining = domainLimit
    for (const template of batch) {
      const hits = await provider.search(template.query, HHT_OPP_DISCOVERY_DEFAULTS.hitsPerQuery)
      const plan = planDiscoveryTargets(hits, existingDomains, remaining)
      result.queries += 1
      result.hits += plan.uniqueDomains
      result.newDomains += plan.newDomains

      const insertedQuery = await db
        .insert(hhtOppSearchQueries)
        .values({
          runId,
          query: template.query,
          strategy: template.strategy,
          family: template.family,
          resultsFound: plan.uniqueDomains,
          newDomains: plan.newDomains,
          qualifiedDomains: 0,
          passDomains: 0,
        })
        .returning({ id: hhtOppSearchQueries.id })
      const queryId = insertedQuery[0]!.id

      let qualified = 0
      let pass = 0
      for (const target of [...plan.skippedExisting, ...plan.toResearch]) {
        const domainId = await domainIdFor(db, target.domain, existingDomains)
        await linkDiscoveredDomain(db, queryId, domainId, target.seedUrl)
      }

      for (const target of plan.toResearch) {
        const researched = await researchHhtOppSeed(db, target.seedUrl, {
          strategy: template.strategy,
          fetchImpl: options.fetchImpl,
        })
        existingDomains.add(target.domain)
        remaining = Math.max(0, remaining - 1)
        applyResearchCounts(result, researched)
        const counts = await opportunityCountsForDomain(db, researched.domainId)
        if (counts.qualified > 0) qualified += 1
        if (counts.pass > 0) pass += 1
      }

      await db
        .update(hhtOppSearchQueries)
        .set({ qualifiedDomains: qualified, passDomains: pass })
        .where(eq(hhtOppSearchQueries.id, queryId))
    }

    await db
      .update(hhtOppDiscoveryRuns)
      .set({
        status: 'completed',
        finishedAt: new Date(),
        notes: JSON.stringify({
          queryLimit,
          domainLimit,
          strategies,
          provider: provider.id,
          live: provider.live,
          useFixture,
          queries: result.queries,
          hits: result.hits,
          newDomains: result.newDomains,
          researched: result.researched,
          created: result.created,
          updated: result.updated,
          pass: result.pass,
          error: null,
        } satisfies RunNotes),
      })
      .where(eq(hhtOppDiscoveryRuns.id, runId))
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Discovery failed.'
    result.status = 'failed'
    result.error = message
    await failHhtOppDiscoveryRun(db, runId, message)
    return result
  }
}

function applyResearchCounts(result: HhtOppDiscoveryResult, researched: ResearchSeedResult): void {
  result.researched += 1
  result.created += researched.created
  result.updated += researched.updated
}

async function domainIdFor(db: Database, rootDomain: string, existing: Set<string>): Promise<number> {
  const [row] = await db
    .select({ id: hhtOppDomains.id })
    .from(hhtOppDomains)
    .where(eq(hhtOppDomains.rootDomain, rootDomain))
    .limit(1)
  if (row) {
    existing.add(rootDomain)
    return row.id
  }
  const inserted = await db
    .insert(hhtOppDomains)
    .values({
      rootDomain,
      canonicalUrl: `https://${rootDomain}`,
      lastCheckedAt: new Date(),
    })
    .returning({ id: hhtOppDomains.id })
  existing.add(rootDomain)
  return inserted[0]!.id
}

async function linkDiscoveredDomain(
  db: Database,
  queryId: number,
  domainId: number,
  seedUrl: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: hhtOppDiscoveredDomains.id })
    .from(hhtOppDiscoveredDomains)
    .where(and(eq(hhtOppDiscoveredDomains.queryId, queryId), eq(hhtOppDiscoveredDomains.domainId, domainId)))
    .limit(1)
  if (existing) return
  await db.insert(hhtOppDiscoveredDomains).values({ queryId, domainId, seedUrl })
}

async function opportunityCountsForDomain(
  db: Database,
  domainId: number,
): Promise<{ qualified: number; pass: number }> {
  if (!domainId) return { qualified: 0, pass: 0 }
  const [row] = await db
    .select({
      qualified: sql<number>`count(*) filter (where ${hhtOppOpportunities.eligibility} in ('PASS', 'REVIEW'))::int`,
      pass: sql<number>`count(*) filter (where ${hhtOppOpportunities.eligibility} = 'PASS')::int`,
    })
    .from(hhtOppOpportunities)
    .where(eq(hhtOppOpportunities.domainId, domainId))
  return { qualified: row?.qualified ?? 0, pass: row?.pass ?? 0 }
}

export function isHhtOppSearchStrategy(value: string): value is HhtOppSearchStrategy {
  return (HHT_OPP_DISCOVERY_STRATEGY_ORDER as readonly string[]).includes(value)
}
