import 'server-only'
import {
  excludeDiscoveryDomain,
  hitRootDomain,
  HHT_OPP_GUEST_SEED_KEYWORDS,
  HHT_OPP_GUEST_SERP_DEPTH,
  isExplicitContributionUrl,
  isGuestRoundupUrl,
  pickGuestPostIdeas,
  type GuestKeywordIdea,
  type SearchHit,
} from '@rnr/core'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppDiscoveryRuns, hhtOppDomains, hhtOppOpportunities, hhtOppSearchQueries } from '../schema.js'
import { generateIdeas } from '../hht-engine/gads-client.js'
import { createSemrushClient } from '../opportunity-miner/semrush/client.js'
import { crawlHhtOppPage, listOutboundLinks } from './crawl.js'
import { createHhtOppDiscoveryRun, failHhtOppDiscoveryRun } from './discover.js'
import { researchHhtOppSeed } from './research.js'

export interface GuestScaleOptions {
  serpDepth?: number
  domainLimit?: number
  ideaLimit?: number
  seeds?: string[]
  log?: (message: string) => void
}

export interface GuestScaleResult {
  runId: number
  keywords: number
  ideaKeywords: string[]
  serpHits: number
  explicitUrls: number
  roundupDomains: number
  researched: number
  created: number
  editorialCreated: number
  error: string | null
}

interface Candidate {
  domain: string
  url: string
  priority: number
  position: number
  query: string
}

const IDEA_SEEDS = ['travel write for us', 'travel guest post', 'travel blogs that accept guest posts']

export async function scaleGuestPostDiscovery(
  db: Database,
  options: GuestScaleOptions = {},
): Promise<GuestScaleResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  const serpDepth = clamp(options.serpDepth, HHT_OPP_GUEST_SERP_DEPTH, 100)
  const domainLimit = clamp(options.domainLimit, 50, 80)
  const ideaLimit = clamp(options.ideaLimit, 8, 12)
  const seeds = (options.seeds?.length ? options.seeds : [...HHT_OPP_GUEST_SEED_KEYWORDS]).map((keyword) => keyword.trim()).filter(Boolean)

  const run = await createHhtOppDiscoveryRun(db, {
    name: 'Travel guest-post scale',
    queryLimit: seeds.length + ideaLimit,
    domainLimit,
    strategies: ['direct_keyword_search'],
  })

  const result: GuestScaleResult = {
    runId: run.id,
    keywords: 0,
    ideaKeywords: [],
    serpHits: 0,
    explicitUrls: 0,
    roundupDomains: 0,
    researched: 0,
    created: 0,
    editorialCreated: 0,
    error: null,
  }

  try {
    const existing = new Set(
      (await db.select({ rootDomain: hhtOppDomains.rootDomain }).from(hhtOppDomains)).map((row) => row.rootDomain),
    )
    const client = createSemrushClient(db, process.env, true)
    const searched: string[] = []
    const candidates: Candidate[] = []
    const roundups: Array<{ url: string; query: string }> = []

    for (const keyword of seeds) {
      await collectSerp(db, run.id, client, keyword, serpDepth, searched, candidates, roundups, result, log)
    }

    const ideas = await travelGuestIdeas(seeds, ideaLimit, log)
    result.ideaKeywords = ideas
    for (const keyword of ideas) {
      await collectSerp(db, run.id, client, keyword, serpDepth, searched, candidates, roundups, result, log)
    }

    const roundupDomains = await domainsFromRoundups(roundups.slice(0, 24), existing, log)
    result.roundupDomains = roundupDomains.length
    for (const row of roundupDomains) {
      candidates.push({ ...row, priority: 1, position: 100, query: row.query })
    }

    const queue = dedupeCandidates(candidates).filter((row) => !existing.has(row.domain))
    result.explicitUrls = queue.filter((row) => row.priority === 0).length
    log(`Queue: ${queue.length} new domains (${result.explicitUrls} explicit guideline URLs). Researching ${Math.min(domainLimit, queue.length)}.`)

    for (const target of queue.slice(0, domainLimit)) {
      log(`Research ${target.domain} ← ${target.url}`)
      try {
        const before = await editorialCount(db, target.domain)
        const researched = await researchHhtOppSeed(db, target.url, { strategy: 'direct_keyword_search' })
        existing.add(target.domain)
        result.researched += 1
        result.created += researched.created
        const after = await editorialCount(db, target.domain)
        if (after > before) result.editorialCreated += after - before
      } catch (error) {
        log(`Skip ${target.domain}: ${error instanceof Error ? error.message : 'research failed'}`)
      }
    }

    if (result.serpHits === 0) {
      throw new Error('No SERP results. The Semrush API key was rejected or every phrase returned nothing.')
    }

    await db
      .update(hhtOppDiscoveryRuns)
      .set({
        status: 'completed',
        finishedAt: new Date(),
        notes: JSON.stringify({
          queryLimit: seeds.length + ideaLimit,
          domainLimit,
          strategies: ['direct_keyword_search'],
          provider: 'semrush',
          live: true,
          queries: result.keywords,
          hits: result.serpHits,
          newDomains: result.explicitUrls + result.roundupDomains,
          researched: result.researched,
          created: result.created,
          pass: result.editorialCreated,
          error: null,
        }),
      })
      .where(eq(hhtOppDiscoveryRuns.id, run.id))

    log(`Done. Researched ${result.researched}. New editorial guest rows: ${result.editorialCreated}.`)
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Guest-post scale failed.'
    await failHhtOppDiscoveryRun(db, run.id, result.error)
    return result
  }
}

async function collectSerp(
  db: Database,
  runId: number,
  client: ReturnType<typeof createSemrushClient>,
  keyword: string,
  serpDepth: number,
  searched: string[],
  candidates: Candidate[],
  roundups: Array<{ url: string; query: string }>,
  result: GuestScaleResult,
  log: (message: string) => void,
): Promise<void> {
  log(`SERP 1–${serpDepth}: ${keyword}`)
  let hits: SearchHit[] = []
  try {
    const rows = await client.keywordSerp(keyword, { database: 'us', limit: serpDepth })
    hits = rows
      .filter((row) => row.url)
      .map((row) => ({
        url: row.url!,
        title: null,
        snippet: null,
        domain: row.domain || null,
      }))
  } catch (error) {
    log(`SERP failed for “${keyword}”: ${error instanceof Error ? error.message : 'unknown error'}`)
    return
  }
  searched.push(keyword)
  result.keywords += 1
  result.serpHits += hits.length
  let fresh = 0
  const domains = new Set<string>()
  for (const hit of hits) {
    const root = hitRootDomain(hit)
    if (!root || excludeDiscoveryDomain(root).excluded) continue
    fresh += 1
    domains.add(root)
    if (isExplicitContributionUrl(hit.url)) {
      candidates.push({ domain: root, url: hit.url, priority: 0, position: fresh, query: keyword })
    } else if (isGuestRoundupUrl(hit.url)) {
      roundups.push({ url: hit.url, query: keyword })
    } else {
      candidates.push({ domain: root, url: hit.url, priority: 2, position: fresh, query: keyword })
    }
  }
  await db.insert(hhtOppSearchQueries).values({
    runId,
    query: keyword,
    strategy: 'direct_keyword_search',
    family: 'guest_post_scale',
    resultsFound: hits.length,
    newDomains: domains.size,
  })
  log(`  ${hits.length} results, ${domains.size} usable domains`)
}

async function travelGuestIdeas(seeds: string[], ideaLimit: number, log: (message: string) => void): Promise<string[]> {
  const collected: GuestKeywordIdea[] = []
  for (const seed of IDEA_SEEDS) {
    log(`Google Ads keyword ideas from “${seed}”`)
    try {
      const ideas = await generateIdeas({ seedType: 'keyword', seed })
      collected.push(...ideas)
    } catch (error) {
      log(`Keyword ideas failed for “${seed}”: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    await wait(1100)
  }
  const picked = pickGuestPostIdeas({ ideas: collected, alreadySearched: seeds, limit: ideaLimit })
  log(`New guest-post keywords: ${picked.length ? picked.join(' | ') : 'none'}`)
  return picked
}

async function domainsFromRoundups(
  roundups: Array<{ url: string; query: string }>,
  existing: Set<string>,
  log: (message: string) => void,
): Promise<Array<{ domain: string; url: string; query: string }>> {
  const out: Array<{ domain: string; url: string; query: string }> = []
  const seen = new Set<string>()
  for (const roundup of roundups) {
    const page = await crawlHhtOppPage(roundup.url)
    if (!page.rawHtml) continue
    for (const link of listOutboundLinks(page.rawHtml, page.finalUrl ?? roundup.url, 40)) {
      if (seen.has(link.domain) || existing.has(link.domain) || excludeDiscoveryDomain(link.domain).excluded) continue
      seen.add(link.domain)
      out.push({ domain: link.domain, url: `https://${link.domain}`, query: roundup.query })
    }
  }
  log(`Roundups produced ${out.length} outbound domains`)
  return out
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>()
  for (const row of candidates) {
    const prev = best.get(row.domain)
    if (!prev || row.priority < prev.priority || (row.priority === prev.priority && row.position < prev.position)) {
      best.set(row.domain, row)
    }
  }
  return [...best.values()].sort((a, b) => a.priority - b.priority || a.position - b.position || a.domain.localeCompare(b.domain))
}

async function editorialCount(db: Database, domain: string): Promise<number> {
  const [domainRow] = await db
    .select({ id: hhtOppDomains.id })
    .from(hhtOppDomains)
    .where(eq(hhtOppDomains.rootDomain, domain))
    .limit(1)
  if (!domainRow) return 0
  const rows = await db
    .select({ id: hhtOppOpportunities.id })
    .from(hhtOppOpportunities)
    .where(and(eq(hhtOppOpportunities.domainId, domainRow.id), eq(hhtOppOpportunities.opportunityType, 'editorial_guest')))
  return rows.length
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Research guideline URLs already collected from a SERP. Skips domains already stored. */
export async function researchGuestPostUrls(
  db: Database,
  urls: string[],
  options: { domainLimit?: number; log?: (message: string) => void } = {},
): Promise<{ researched: number; created: number; editorialCreated: number; skippedExisting: number }> {
  const log = options.log ?? ((message: string) => console.log(message))
  const domainLimit = clamp(options.domainLimit, 40, 80)
  const existing = new Set(
    (await db.select({ rootDomain: hhtOppDomains.rootDomain }).from(hhtOppDomains)).map((row) => row.rootDomain),
  )
  const seen = new Set<string>()
  let researched = 0
  let created = 0
  let editorialCreated = 0
  let skippedExisting = 0

  for (const raw of urls) {
    if (researched >= domainLimit) break
    const url = raw.trim()
    if (!url || !isExplicitContributionUrl(url)) continue
    const root = hitRootDomain({ url, title: null, snippet: null, domain: null })
    if (!root || seen.has(root) || excludeDiscoveryDomain(root).excluded) continue
    seen.add(root)
    if (existing.has(root)) {
      skippedExisting += 1
      continue
    }
    log(`Research ${root} ← ${url}`)
    try {
      const before = await editorialCount(db, root)
      const row = await researchHhtOppSeed(db, url, { strategy: 'direct_keyword_search' })
      existing.add(root)
      researched += 1
      created += row.created
      const after = await editorialCount(db, root)
      if (after > before) editorialCreated += after - before
    } catch (error) {
      log(`Skip ${root}: ${error instanceof Error ? error.message : 'research failed'}`)
    }
  }

  log(`Researched ${researched}. Already stored ${skippedExisting}. New editorial guest rows: ${editorialCreated}.`)
  return { researched, created, editorialCreated, skippedExisting }
}
