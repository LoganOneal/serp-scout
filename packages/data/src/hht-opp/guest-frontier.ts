import 'server-only'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  excludeDiscoveryDomain,
  GUEST_SERP_REPORT,
  guestSerpRequest,
  parseGuestSerpHarvest,
  type GuestSerpRequest,
  guestKeywordFetchDecision,
  deferForPlanSpread,
  guestSerpNeighborhood,
  HHT_OPP_GUEST_SEED_KEYWORDS,
  isGuestBucketId,
  isLegacyGuestDiscoveryKeyword,
  maxSerpResultOverlap,
  normalizeFrontierKeyword,
  parseOrganicSerp,
  registrableDomain,
  selectGuestFrontierIdeas,
  serpResultKey,
  type GuestFrontierIdea,
  type Neighborhood,
} from '@rnr/core'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { closeEngineDatabase, getEngineDatabase } from '../hht-engine/db.js'
import { generateIdeas, GadsError } from '../hht-engine/gads-client.js'
import { recordSemrushUnits } from '../hht-engine/jobs.js'
import {
  hhtOppGuestKeywords,
  hhtOppGuestSerpResults,
} from '../schema.js'
import { retireGuestTemplateKeywords } from './guest-templates.js'

export type GuestFrontierStop = 'gads_error' | 'no_new_keywords' | 'max_keywords'

/**
 * `guest-frontier --plan`: pick the next keywords exactly as the old fetch loop did
 * (curated seeds, then D1 template-queued keywords and keyword ideas, with the
 * similarity skip) and return the Semrush MCP requests for them. No Semrush call.
 */
export interface GuestFrontierPlan {
  createdAt: string
  report: typeof GUEST_SERP_REPORT
  stop: GuestFrontierStop
  keywordsSkipped: number
  error: string | null
  requests: GuestSerpRequest[]
}

/** `guest-frontier --serp-from`: SERPs a Claude session pulled with the Semrush MCP. */
export interface GuestFrontierIngestResult {
  keywordsFetched: number
  domainsEvaluated: number
  units: number
  notQueued: string[]
  alreadyFetched: string[]
  failed: Array<{ keyword: string; error: string }>
  error: string | null
}

export const GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED =
  'guest-frontier no longer calls Semrush. Run `pnpm hht:opp guest-frontier --plan --max=N`, pull each request with the '
  + 'Semrush MCP execute_report tool in a Claude session, then run `pnpm hht:opp guest-frontier --serp-from=file.json`.'

/** One Google Ads Keyword Ideas call. Stores new phrases for the next blog search. */
export async function expandGuestKeywordIdeas(
  db: Database,
  options: { ideaLimit?: number; log?: (message: string) => void } = {},
): Promise<{ added: number; seed: string | null; error: string | null }> {
  const log = options.log ?? (() => undefined)
  await ensureGuestFrontierSchema(db)
  await retireLegacyGuestKeywords(db)
  await seedGuestKeywords(db)
  const expanded = await expandKeywords(db, options.ideaLimit ?? 20, log)
  return { added: expanded.added, seed: expanded.seed, error: expanded.error }
}

/** The old direct-Semrush loop. Kept only to fail loudly for any caller left over. */
export async function runGuestPostFrontier(): Promise<never> {
  throw new Error(GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED)
}

async function prepareFrontier(db: Database, log: (message: string) => void): Promise<void> {
  await ensureGuestFrontierSchema(db)
  const retired = await retireLegacyGuestKeywords(db)
  if (retired > 0) log(`Retired ${retired} pending legacy contribution-footprint queries.`)
  await seedGuestKeywords(db)
  const reset = await resetUnfetchedExhausted(db)
  if (reset > 0) log(`Reset ${reset} queries marked exhausted without a stored SERP fetch.`)
  const retiredTemplates = await retireGuestTemplateKeywords(db)
  if (retiredTemplates.rows > 0) {
    log(`Retired ${retiredTemplates.rows} queued keywords from templates below the yield floor (${retiredTemplates.templates.join(', ')}).`)
  }
}

export async function planGuestPostFrontier(
  db: Database,
  options: {
    maxKeywords: number
    ideaLimit?: number
    /** When false, stop at the end of the queue instead of adding Google Ads keyword ideas. */
    expand?: boolean
    log?: (message: string) => void
  },
): Promise<GuestFrontierPlan> {
  const log = options.log ?? ((message: string) => console.error(message))
  const ideaLimit = options.ideaLimit ?? 20
  const expand = options.expand ?? true
  const plan: GuestFrontierPlan = {
    createdAt: new Date().toISOString(),
    report: GUEST_SERP_REPORT,
    stop: 'max_keywords',
    keywordsSkipped: 0,
    error: null,
    requests: [],
  }
  await prepareFrontier(db, log)

  const planned = new Set<number>()
  while (plan.requests.length < options.maxKeywords) {
    // Planned keywords count as fetched for the similarity skip, as they did when
    // the loop fetched each one before choosing the next.
    const chosen = await takeNextKeyword(db, plan, log, {
      exclude: planned,
      plannedKeywords: plan.requests.map((request) => request.keyword),
    })
    if (!chosen) {
      if (!expand) {
        plan.stop = 'no_new_keywords'
        break
      }
      const expanded = await expandKeywords(db, ideaLimit, log)
      if (expanded.stop) {
        plan.stop = expanded.stop
        plan.error = expanded.error
        break
      }
      if (!expanded.expanded) {
        plan.stop = 'no_new_keywords'
        break
      }
      continue
    }
    planned.add(chosen.id)
    plan.requests.push(guestSerpRequest(chosen.id, chosen.keyword))
    log(`Planned SERP 1–100: ${chosen.keyword}`)
  }
  return plan
}

export async function ingestGuestFrontierSerps(
  db: Database,
  harvest: unknown,
  options: { log?: (message: string) => void; recordUnits?: (units: number | null) => Promise<void> } = {},
): Promise<GuestFrontierIngestResult> {
  const log = options.log ?? ((message: string) => console.error(message))
  const entries = parseGuestSerpHarvest(harvest)
  const result: GuestFrontierIngestResult = {
    keywordsFetched: 0,
    domainsEvaluated: 0,
    units: 0,
    notQueued: [],
    alreadyFetched: [],
    failed: [],
    error: null,
  }
  await ensureGuestFrontierSchema(db)
  const recordUnits = options.recordUnits ?? recordEngineUnits
  try {
    for (const { keyword, normalized, entry } of entries) {
      const [row] = await db.select().from(hhtOppGuestKeywords).where(eq(hhtOppGuestKeywords.normalizedKeyword, normalized))
      if (!row) {
        result.notQueued.push(keyword)
        log(`Not in the guest keyword queue, ignored: ${keyword}`)
        continue
      }
      // Units were spent when the session pulled the report, so record them even
      // for a pull that failed or a keyword already stored.
      if (entry.units != null) {
        result.units += entry.units
        await recordUnits(entry.units)
      }
      if (row.status !== 'NEW') {
        result.alreadyFetched.push(keyword)
        log(`Already ${row.status}, not re-recorded: ${keyword}`)
        continue
      }
      if (!('data' in entry)) {
        // Semrush has no SERP for this phrase: retire it so later plans do not pick it again.
        if (/^no_data\b/i.test(entry.error ?? '')) {
          await db.update(hhtOppGuestKeywords).set({ status: 'SKIPPED', skipReason: 'no_serp_data' })
            .where(eq(hhtOppGuestKeywords.id, row.id))
          result.failed.push({ keyword, error: 'no_data (keyword retired)' })
          continue
        }
        // A failed pull (credits, rate limit) leaves the keyword queued.
        result.failed.push({ keyword, error: entry.error ?? 'no data' })
        continue
      }
      const rows = parseOrganicSerp(entry.data).map((serpRow) => ({ url: serpRow.url, domain: serpRow.domain, position: serpRow.position }))
      const recorded = await recordSerp(db, row.id, rows)
      result.domainsEvaluated += recorded.newDomains
      result.keywordsFetched += 1
      log(`${keyword}: ${rows.length} results, overlap ${recorded.overlap.toFixed(2)}, ${recorded.neighborhood}, ${recorded.newDomains} new blogs`)
    }
    return result
  } finally {
    if (!options.recordUnits) await closeEngineDatabase()
  }
}

async function recordEngineUnits(units: number | null): Promise<void> {
  await recordSemrushUnits(getEngineDatabase(), GUEST_SERP_REPORT, units, null)
}

async function takeNextKeyword(
  db: Database,
  result: { keywordsSkipped: number },
  log: (message: string) => void,
  planning: { exclude: ReadonlySet<number>; plannedKeywords: readonly string[] },
): Promise<{ id: number; keyword: string } | null> {
  const state = await loadFrontier(db)
  const fetched = [...state.fetched, ...planning.plannedKeywords.map((keyword) => ({ keyword, neighborhood: null }))]
  // Curated seed queries (with a priority) run first, lowest priority number first,
  // and always run: the similarity skip only applies to generated keyword ideas.
  const pending = state.keywords
    .filter((row) => row.status === 'NEW' && !planning.exclude.has(row.id) && !isLegacyGuestDiscoveryKeyword(row.keyword))
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
  for (const row of pending) {
    if (row.priority != null) return { id: row.id, keyword: row.keyword }
    // Spread one plan across topics; the deferred keyword stays NEW for the next plan.
    if (deferForPlanSpread(row.keyword, planning.plannedKeywords)) continue
    const decision = guestKeywordFetchDecision(row.keyword, fetched)
    if (decision.fetch) return { id: row.id, keyword: row.keyword }
    await db.update(hhtOppGuestKeywords).set({
      status: 'SKIPPED',
      skipReason: decision.reason,
    }).where(eq(hhtOppGuestKeywords.id, row.id))
    result.keywordsSkipped += 1
    log(`Skip “${row.keyword}” (${decision.reason}, like “${decision.matched}”, ${decision.similarity.toFixed(2)})`)
  }
  return null
}

async function expandKeywords(
  db: Database,
  ideaLimit: number,
  log: (message: string) => void,
): Promise<{ added: number; expanded: boolean; seed: string | null; stop?: GuestFrontierStop; error: string | null }> {
  const candidates = await db.select().from(hhtOppGuestKeywords)
    .where(and(
      inArray(hhtOppGuestKeywords.status, ['FETCHED', 'SATURATED', 'NEW']),
      sql`${hhtOppGuestKeywords.ideasExpandedAt} is null`,
    ))
    .orderBy(
      sql`case when ${hhtOppGuestKeywords.neighborhood} = 'productive' then 0 else 1 end`,
      desc(hhtOppGuestKeywords.newDomains),
      asc(hhtOppGuestKeywords.id),
    )
  const seed = candidates.find((row) => !isLegacyGuestDiscoveryKeyword(row.keyword))
  if (!seed) return { added: 0, expanded: false, seed: null, error: null }

  log(`Google Ads keyword ideas from “${seed.keyword}”`)
  let ideas: GuestFrontierIdea[] = []
  try {
    ideas = await generateIdeas({ seedType: 'keyword', seed: seed.keyword })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google Ads keyword ideas failed'
    if (error instanceof GadsError && error.kind === 'auth') {
      return { added: 0, expanded: true, seed: seed.keyword, stop: 'gads_error', error: message }
    }
    await db.update(hhtOppGuestKeywords).set({ ideasExpandedAt: new Date() }).where(eq(hhtOppGuestKeywords.id, seed.id))
    log(`Keyword ideas failed for “${seed.keyword}”: ${message}`)
    return { added: 0, expanded: true, seed: seed.keyword, error: message }
  }
  await db.update(hhtOppGuestKeywords).set({ ideasExpandedAt: new Date() }).where(eq(hhtOppGuestKeywords.id, seed.id))
  await wait(1100)

  const known = (await db.select({ keyword: hhtOppGuestKeywords.normalizedKeyword }).from(hhtOppGuestKeywords)).map((row) => row.keyword)
  const state = await loadFrontier(db)
  const bucket = isGuestBucketId(seed.bucket) ? seed.bucket : null
  const picked = selectGuestFrontierIdeas({ ideas, alreadyKnown: known, limit: ideaLimit, bucket })
  let added = 0
  for (const keyword of picked) {
    const decision = guestKeywordFetchDecision(keyword, state.fetched)
    const inserted = await insertKeyword(db, {
      keyword,
      bucket,
      sourceType: 'google_keyword_idea',
      status: decision.fetch ? 'NEW' : 'SKIPPED',
      skipReason: decision.fetch ? null : decision.reason,
    })
    if (inserted && decision.fetch) added += 1
  }
  log(`Queued ${added} new keywords from “${seed.keyword}”.`)
  return { added, expanded: true, seed: seed.keyword, error: null }
}

async function recordSerp(
  db: Database,
  keywordId: number,
  rows: Array<{ url: string; domain: string; position: number }>,
): Promise<{ overlap: number; neighborhood: Neighborhood; newDomains: number }> {
  const keys: string[] = []
  for (const row of rows) {
    if (!row.url) continue
    const key = serpResultKey(row.url)
    keys.push(key)
    await db.insert(hhtOppGuestSerpResults).values({
      keywordId,
      position: row.position,
      url: row.url,
      domain: row.domain || key,
    }).onConflictDoNothing({ target: [hhtOppGuestSerpResults.keywordId, hhtOppGuestSerpResults.url] })
  }
  const state = await loadFrontier(db)
  const overlap = state.overlaps.get(keywordId) ?? 0
  const domains = uniqueDomains(rows)
  const newDomains = domains.filter((domain) => state.firstKeyword.get(domain.root) === keywordId).length
  const neighborhood = guestSerpNeighborhood(overlap, newDomains)
  // EXHAUSTED only after a fetch that returned results but no new blogs.
  // NO_DATA means Semrush has no stored SERP for the phrase (usually zero volume).
  // A failed fetch never reaches this function, so it cannot mark a query exhausted.
  const status = rows.length === 0
    ? 'NO_DATA'
    : newDomains === 0
      ? 'EXHAUSTED'
      : neighborhood === 'saturated' ? 'SATURATED' : 'FETCHED'
  const now = new Date()
  await db.update(hhtOppGuestKeywords).set({
    status,
    neighborhood,
    serpOverlap: overlap,
    newDomains,
    resultsSeen: rows.length,
    fetchedAt: now,
    lastRunAt: now,
  }).where(eq(hhtOppGuestKeywords.id, keywordId))
  return { overlap, neighborhood, newDomains }
}

async function loadFrontier(db: Database): Promise<{
  keywords: Array<{ id: number; keyword: string; status: string; neighborhood: Neighborhood | null; priority: number | null }>
  fetched: Array<{ keyword: string; neighborhood: Neighborhood | null }>
  overlaps: Map<number, number>
  firstKeyword: Map<string, number>
}> {
  const keywords = await db.select().from(hhtOppGuestKeywords).orderBy(asc(hhtOppGuestKeywords.id))
  const results = await db.select().from(hhtOppGuestSerpResults).orderBy(asc(hhtOppGuestSerpResults.id))
  const byKeyword = new Map<number, string[]>()
  const firstKeyword = new Map<string, number>()
  for (const row of results) {
    const list = byKeyword.get(row.keywordId) ?? []
    list.push(serpResultKey(row.url))
    byKeyword.set(row.keywordId, list)
    const root = registrableDomain(row.domain || row.url)?.domain
    if (root && !firstKeyword.has(root)) firstKeyword.set(root, row.keywordId)
  }
  const fetched = keywords
    .filter((row) => row.status === 'FETCHED' || row.status === 'SATURATED' || row.status === 'EXHAUSTED')
    .map((row) => ({ keyword: row.keyword, neighborhood: asNeighborhood(row.neighborhood) }))
  const overlaps = new Map<number, number>()
  for (const [id, keys] of byKeyword) {
    const others = [...byKeyword.entries()].filter(([otherId]) => otherId !== id).map(([, otherKeys]) => otherKeys)
    overlaps.set(id, maxSerpResultOverlap(keys, others))
  }
  return {
    keywords: keywords.map((row) => ({
      id: row.id,
      keyword: row.keyword,
      status: row.status,
      neighborhood: asNeighborhood(row.neighborhood),
      priority: row.priority,
    })),
    fetched,
    overlaps,
    firstKeyword,
  }
}

/**
 * Queries were once marked lowercase "exhausted" without any SERP being stored
 * (fetched_at null, results_seen 0). Put them back in the queue.
 */
export async function resetUnfetchedExhausted(db: Database): Promise<number> {
  const rows = await db.update(hhtOppGuestKeywords).set({
    status: 'NEW',
    newDomains: 0,
    resultsSeen: 0,
    lastRunAt: null,
  }).where(and(
    sql`lower(${hhtOppGuestKeywords.status}) = 'exhausted'`,
    sql`${hhtOppGuestKeywords.fetchedAt} is null`,
  )).returning({ id: hhtOppGuestKeywords.id })
  return rows.length
}

async function seedGuestKeywords(db: Database): Promise<void> {
  for (const keyword of HHT_OPP_GUEST_SEED_KEYWORDS) {
    await db.insert(hhtOppGuestKeywords).values({
      keyword,
      normalizedKeyword: normalizeFrontierKeyword(keyword),
      sourceType: 'topical_seed',
      status: 'NEW',
      priority: 1,
      leadType: 'guest_post',
      bucket: keyword.startsWith('packing list') ? 'packing' : 'staycation',
    }).onConflictDoUpdate({
      target: hhtOppGuestKeywords.normalizedKeyword,
      set: { status: 'NEW', priority: 1, skipReason: null },
      setWhere: eq(hhtOppGuestKeywords.status, 'proposed'),
    })
  }
}

export async function retireLegacyGuestKeywords(db: Database): Promise<number> {
  const pending = await db.select({
    id: hhtOppGuestKeywords.id,
    keyword: hhtOppGuestKeywords.keyword,
    sourceType: hhtOppGuestKeywords.sourceType,
  }).from(hhtOppGuestKeywords).where(
    and(
      inArray(hhtOppGuestKeywords.status, ['NEW', 'proposed', 'EXHAUSTED', 'exhausted']),
      sql`${hhtOppGuestKeywords.fetchedAt} is null`,
    ),
  )
  const ids = pending.filter((row) =>
    isLegacyGuestDiscoveryKeyword(row.keyword)
    || ['seed', 'blog_discovery_seed', 'batch_followup_proposal', 'batch09_followup'].includes(row.sourceType),
  ).map((row) => row.id)
  if (ids.length === 0) return 0
  await db.update(hhtOppGuestKeywords).set({
    status: 'RETIRED',
    skipReason: 'legacy_contribution_footprint',
  }).where(inArray(hhtOppGuestKeywords.id, ids))
  return ids.length
}

async function insertKeyword(
  db: Database,
  input: { keyword: string; sourceType: string; status: string; skipReason: string | null; bucket?: string | null },
): Promise<boolean> {
  const normalized = normalizeFrontierKeyword(input.keyword)
  if (!normalized) return false
  const inserted = await db.insert(hhtOppGuestKeywords).values({
    keyword: input.keyword,
    normalizedKeyword: normalized,
    sourceType: input.sourceType,
    status: input.status,
    skipReason: input.skipReason,
    bucket: input.bucket ?? null,
  }).onConflictDoNothing({ target: hhtOppGuestKeywords.normalizedKeyword }).returning({ id: hhtOppGuestKeywords.id })
  return inserted.length > 0
}

function uniqueDomains(rows: Array<{ url: string; domain: string }>): Array<{ root: string; url: string }> {
  const seen = new Set<string>()
  const out: Array<{ root: string; url: string }> = []
  for (const row of rows) {
    const root = registrableDomain(row.domain || row.url)?.domain
    if (!root || seen.has(root) || excludeDiscoveryDomain(root).excluded) continue
    seen.add(root)
    out.push({ root, url: row.url })
  }
  return out
}

function asNeighborhood(value: string | null): Neighborhood | null {
  if (value === 'saturated' || value === 'productive' || value === 'neutral') return value
  return null
}

async function ensureGuestFrontierSchema(db: Database): Promise<void> {
  const sqlPath = fileURLToPath(new URL('../../drizzle/0045_hht_opp_guest_frontier.sql', import.meta.url))
  const statements = readFileSync(sqlPath, 'utf8')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
  for (const statement of statements) {
    await db.execute(sql.raw(statement))
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
