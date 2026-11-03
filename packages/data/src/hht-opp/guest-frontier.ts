import 'server-only'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  excludeDiscoveryDomain,
  guestKeywordFetchDecision,
  guestSerpNeighborhood,
  HHT_OPP_GUEST_SEED_KEYWORDS,
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
import { loadCredential, saveCredential } from '../hht-engine/jobs.js'
import { SemrushMcpClient, SemrushMcpError } from '../hht-engine/semrush-mcp.js'
import {
  hhtOppGuestKeywords,
  hhtOppGuestSerpResults,
} from '../schema.js'

export interface GuestFrontierResult {
  stop: 'semrush_credits' | 'semrush_auth' | 'semrush_rate_limit' | 'gads_error' | 'no_new_keywords' | 'max_keywords'
  keywordsFetched: number
  keywordsSkipped: number
  domainsEvaluated: number
  pursued: number
  units: number
  error: string | null
}

/** One Google Ads Keyword Ideas call. Stores new phrases for the next blog search. */
export async function expandGuestKeywordIdeas(
  db: Database,
  options: { ideaLimit?: number; log?: (message: string) => void } = {},
): Promise<{ added: number; seed: string | null; error: string | null }> {
  const log = options.log ?? (() => undefined)
  await ensureGuestFrontierSchema(db)
  await seedGuestKeywords(db)
  const expanded = await expandKeywords(db, options.ideaLimit ?? 20, log)
  return { added: expanded.added, seed: expanded.seed, error: expanded.error }
}

export async function runGuestPostFrontier(
  db: Database,
  options: {
    maxKeywords?: number | null
    ideaLimit?: number
    /** When false, stop at the end of the queue instead of adding Google Ads keyword ideas. */
    expand?: boolean
    log?: (message: string) => void
  } = {},
): Promise<GuestFrontierResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  const ideaLimit = options.ideaLimit ?? 20
  const maxKeywords = options.maxKeywords ?? null
  const expand = options.expand ?? true
  const result: GuestFrontierResult = {
    stop: 'no_new_keywords',
    keywordsFetched: 0,
    keywordsSkipped: 0,
    domainsEvaluated: 0,
    pursued: 0,
    units: 0,
    error: null,
  }

  await ensureGuestFrontierSchema(db)
  await seedGuestKeywords(db)
  const reset = await resetUnfetchedExhausted(db)
  if (reset > 0) log(`Reset ${reset} queries marked exhausted without a stored SERP fetch.`)

  const serp = await connectSemrush(log)
  try {
    while (maxKeywords == null || result.keywordsFetched < maxKeywords) {
      const chosen = await takeNextKeyword(db, result, log)
      if (!chosen) {
        if (!expand) {
          result.stop = 'no_new_keywords'
          return result
        }
        const expanded = await expandKeywords(db, ideaLimit, log)
        if (expanded.stop) {
          result.stop = expanded.stop
          result.error = expanded.error
          return result
        }
        if (!expanded.expanded) {
          result.stop = 'no_new_keywords'
          return result
        }
        continue
      }

      log(`SERP 1–100: ${chosen.keyword}`)
      const fetched = await serp.fetch(chosen.keyword)
      if (fetched.stop) {
        result.stop = fetched.stop
        result.error = fetched.error ?? null
        log(`Stopped: ${fetched.error ?? fetched.stop}`)
        return result
      }
      result.units += fetched.units ?? 0
      const recorded = await recordSerp(db, chosen.id, fetched.rows)
      result.domainsEvaluated += recorded.newDomains
      result.keywordsFetched += 1
      log(`  ${fetched.rows.length} results, overlap ${recorded.overlap.toFixed(2)}, ${recorded.neighborhood}, ${recorded.newDomains} new blogs`)
    }
    result.stop = 'max_keywords'
    return result
  } finally {
    await closeEngineDatabase()
  }
}

async function connectSemrush(log: (message: string) => void): Promise<{
  fetch(keyword: string): Promise<{
    rows: Array<{ url: string; domain: string; position: number }>
    units: number | null
    stop?: GuestFrontierResult['stop']
    error?: string
  }>
}> {
  const engine = getEngineDatabase()
  const credential = await loadCredential(engine)
  if (!credential) {
    throw new Error('Semrush is not connected. Sync the Semrush login, then run guest-frontier again.')
  }
  const client = new SemrushMcpClient(credential, fetch, (next) => saveCredential(engine, next))
  return {
    async fetch(keyword: string) {
      try {
        const report = await client.executeReport('phrase_organic', {
          phrase: keyword,
          database: 'us',
          display_offset: 0,
          display_limit: 100,
          positions_type: 'organic',
        })
        return {
          rows: parseOrganicSerp(report.data).map((row) => ({ url: row.url, domain: row.domain, position: row.position })),
          units: report.units,
        }
      } catch (error) {
        if (error instanceof SemrushMcpError && error.kind === 'empty') {
          return { rows: [], units: null }
        }
        if (error instanceof SemrushMcpError && error.kind === 'exhausted') {
          return { rows: [], units: null, stop: 'semrush_credits', error: error.message }
        }
        if (error instanceof SemrushMcpError && error.kind === 'auth') {
          return { rows: [], units: null, stop: 'semrush_auth', error: error.message }
        }
        if (error instanceof SemrushMcpError && error.kind === 'rate_limit') {
          log('Semrush rate limit. Waiting 5s and retrying once.')
          await wait(5000)
          try {
            const report = await client.executeReport('phrase_organic', {
              phrase: keyword,
              database: 'us',
              display_offset: 0,
              display_limit: 100,
              positions_type: 'organic',
            })
            return {
              rows: parseOrganicSerp(report.data).map((row) => ({ url: row.url, domain: row.domain, position: row.position })),
              units: report.units,
            }
          } catch (retryError) {
            const message = retryError instanceof Error ? retryError.message : 'Semrush rate limit'
            return { rows: [], units: null, stop: 'semrush_rate_limit', error: message }
          }
        }
        throw error
      }
    },
  }
}

async function takeNextKeyword(
  db: Database,
  result: GuestFrontierResult,
  log: (message: string) => void,
): Promise<{ id: number; keyword: string } | null> {
  const state = await loadFrontier(db)
  // Curated seed queries (with a priority) run first, lowest priority number first,
  // and always run: the similarity skip only applies to generated keyword ideas.
  const pending = state.keywords
    .filter((row) => row.status === 'NEW')
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
  for (const row of pending) {
    if (row.priority != null) return { id: row.id, keyword: row.keyword }
    const decision = guestKeywordFetchDecision(row.keyword, state.fetched)
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
): Promise<{ added: number; expanded: boolean; seed: string | null; stop?: GuestFrontierResult['stop']; error: string | null }> {
  const [seed] = await db.select().from(hhtOppGuestKeywords)
    .where(and(
      inArray(hhtOppGuestKeywords.status, ['FETCHED', 'SATURATED', 'NEW']),
      sql`${hhtOppGuestKeywords.ideasExpandedAt} is null`,
    ))
    .orderBy(
      sql`case when ${hhtOppGuestKeywords.neighborhood} = 'productive' then 0 else 1 end`,
      desc(hhtOppGuestKeywords.newDomains),
      asc(hhtOppGuestKeywords.id),
    )
    .limit(1)
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
  const picked = selectGuestFrontierIdeas({ ideas, alreadyKnown: known, limit: ideaLimit })
  let added = 0
  for (const keyword of picked) {
    const decision = guestKeywordFetchDecision(keyword, state.fetched)
    const inserted = await insertKeyword(db, {
      keyword,
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
    await insertKeyword(db, { keyword, sourceType: 'seed', status: 'NEW', skipReason: null })
  }
}

async function insertKeyword(
  db: Database,
  input: { keyword: string; sourceType: string; status: string; skipReason: string | null },
): Promise<boolean> {
  const normalized = normalizeFrontierKeyword(input.keyword)
  if (!normalized) return false
  const inserted = await db.insert(hhtOppGuestKeywords).values({
    keyword: input.keyword,
    normalizedKeyword: normalized,
    sourceType: input.sourceType,
    status: input.status,
    skipReason: input.skipReason,
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
