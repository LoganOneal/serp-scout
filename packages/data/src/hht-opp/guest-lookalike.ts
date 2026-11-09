import 'server-only'
/**
 * Lookalike expansion (plan section 3.2): PURSUE sites in the Guest Post Master
 * Tracker → organic competitors, guest-author bio links and blogroll links →
 * new candidate domains in the export-leads flow.
 *
 * Storage needs no migration. Each (signal, seed) gets one hht_opp_guest_keywords
 * row (source_type = bucket = 'lookalike', status 'LOOKALIKE' so the SERP frontier
 * never fetches it), and each candidate one hht_opp_guest_serp_results row with a
 * synthetic position. `pnpm hht:opp export-leads --keyword-ids=…` exports them;
 * the lead CSV and hht_opp_lead_exports carry bucket = 'lookalike', which is
 * what the yield report compares against the SERP baseline.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, type CheerioAPI } from 'cheerio'
import {
  BLOGROLL_WIDGET_HEADING,
  classifySemrushFailure,
  type SemrushCallClass,
  blogrollPageCandidates,
  capLookalikeCandidates,
  guestPageCandidates,
  isAuthorArchiveUrl,
  LOOKALIKE_BUCKET,
  LOOKALIKE_DEFAULTS,
  LOOKALIKE_KEYWORD_STATUS,
  LOOKALIKE_SOURCE_TYPE,
  lookalikeKeyword,
  lookalikeKeywordKey,
  mergeLookalikeHits,
  parseLookalikeKeyword,
  parseOrganicCompetitors,
  parseWpUsers,
  registrableDomain,
  selectOrganicCompetitors,
  SERP_BASELINE_PITCHABLE_RATE,
  trackerSeeds,
  type LookalikeHit,
  type LookalikeSignal,
  type MergeLookalikeResult,
} from '@rnr/core'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { closeEngineDatabase, getEngineDatabase } from '../hht-engine/db.js'
import { loadCredential, recordSemrushUnits, saveCredential } from '../hht-engine/jobs.js'
import { SemrushMcpClient, SemrushMcpError } from '../hht-engine/semrush-mcp.js'
import { createSemrushClient, semrushApiKey } from '../opportunity-miner/semrush/client.js'
import { parseHotelBlRobots } from '../hotel-bl/crawl.js'
import { hhtOppGuestKeywords, hhtOppGuestSerpResults } from '../schema.js'
import { crawlHhtOppPage, type HhtOppCrawlResult } from './crawl.js'
import { ensureLeadExportSchema, loadExclusionDomains } from './handoff.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
export const LOOKALIKE_TRACKER_PATH = join(REPO_ROOT, 'exports/guest-post-outreach/Guest Post Master Tracker.xlsx')
export const LOOKALIKE_REPORT_DIR = join(REPO_ROOT, 'exports/handoff/lookalike')

/** domain_organic_organic billing per row returned: measured 1,800 units for 15 rows over MCP (2026-11-08). */
export const ORGANIC_COMPETITOR_UNITS_PER_ROW = 120

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const READ_XLSX = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], read_only=True, data_only=True)
out = []
for ws in wb.worksheets:
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    if not header:
        continue
    names = [str(h).strip().lower() if h is not None else "" for h in header]
    for row in rows:
        rec = {"_sheet": ws.title}
        for name, value in zip(names, row):
            if name and value is not None:
                rec[name] = str(value)
        out.append(rec)
json.dump(out, sys.stdout)
`

/** Every row of every tab of the tracker, header-keyed (lowercase). Reads the .xlsx with openpyxl. */
export function readTrackerRows(path = LOOKALIKE_TRACKER_PATH): Array<Record<string, string>> {
  const python = process.env['HHT_PYTHON'] ?? 'python3'
  const run = spawnSync(python, ['-I', '-c', READ_XLSX, path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (run.status !== 0) {
    throw new Error(`Could not read the tracker at ${path} (needs python3 with openpyxl): ${run.stderr.slice(0, 400)}`)
  }
  return JSON.parse(run.stdout) as Array<Record<string, string>>
}

export interface LookalikeSeedState {
  seeds: string[]
  pitchUrls: Map<string, string>
  tracked: Set<string>
  /** Seeds already run, per signal. */
  done: Record<LookalikeSignal, Set<string>>
}

export async function loadLookalikeSeeds(db: Database, trackerPath?: string): Promise<LookalikeSeedState> {
  const rows = readTrackerRows(trackerPath)
  const { seeds, tracked } = trackerSeeds(rows)
  const pitchUrls = new Map<string, string>()
  for (const row of rows) {
    if ((row['verdict'] ?? '').toUpperCase() !== 'PURSUE' || !row['pitch_url']) continue
    const root = registrableDomain(row['site'])?.domain
    if (root && !pitchUrls.has(root) && registrableDomain(row['pitch_url'])?.domain === root) pitchUrls.set(root, row['pitch_url'])
  }
  const done: LookalikeSeedState['done'] = { organic_competitor: new Set(), author_bio: new Set(), blogroll: new Set() }
  const existing = await db
    .select({ keyword: hhtOppGuestKeywords.keyword })
    .from(hhtOppGuestKeywords)
    .where(eq(hhtOppGuestKeywords.sourceType, LOOKALIKE_SOURCE_TYPE))
  for (const row of existing) {
    const parsed = parseLookalikeKeyword(row.keyword)
    if (parsed) done[parsed.signal].add(parsed.seed)
  }
  return { seeds, pitchUrls, tracked, done }
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[]
}

/**
 * Domains a lookalike must not re-surface: the whole tracker, every guest
 * evaluation, every exported lead, every stored SERP hit, and the exclusion CSVs
 * (`run_tools.py exclusions` refreshes the tracker one).
 */
export async function knownGuestDomains(db: Database, tracked: Iterable<string>): Promise<Set<string>> {
  await ensureLeadExportSchema(db)
  const known = new Set<string>(tracked)
  for (const domain of loadExclusionDomains().domains) known.add(domain)
  const add = (value: string | null | undefined) => {
    const root = registrableDomain(value ?? '')?.domain
    if (root) known.add(root)
  }
  for (const row of rowsOf<{ d: string }>(await db.execute(sql`select root_domain as d from hht_opp_guest_evaluations`))) add(row.d)
  for (const row of rowsOf<{ d: string }>(await db.execute(sql`select root_domain as d from hht_opp_lead_exports`))) add(row.d)
  for (const row of rowsOf<{ d: string }>(await db.execute(sql`select distinct domain as d from hht_opp_guest_serp_results`))) add(row.d)
  return known
}

// ---------------------------------------------------------------------------
// Polite fetching: robots.txt + per-host spacing on top of crawlHhtOppPage
// ---------------------------------------------------------------------------

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class PoliteFetcher {
  private readonly nextSlot = new Map<string, number>()
  private readonly robots = new Map<string, Promise<string | null>>()
  pages = 0

  constructor(
    private readonly options: { spacingMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private async gate(host: string): Promise<void> {
    const spacing = this.options.spacingMs ?? LOOKALIKE_DEFAULTS.hostSpacingMs
    const now = Date.now()
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0)
    this.nextSlot.set(host, slot + spacing)
    if (slot > now) await (this.options.sleep ?? wait)(slot - now)
  }

  private async raw(url: string): Promise<HhtOppCrawlResult> {
    await this.gate(new URL(url).host)
    this.pages += 1
    return crawlHhtOppPage(url, { fetchImpl: this.options.fetchImpl, maxAttempts: 2, timeoutMs: 15_000, sleep: this.options.sleep })
  }

  async allowed(url: string): Promise<boolean> {
    const origin = new URL(url).origin
    let body = this.robots.get(origin)
    if (!body) {
      body = this.raw(`${origin}/robots.txt`).then((res) => (res.httpStatus === 200 ? res.rawHtml : null))
      this.robots.set(origin, body)
    }
    const text = await body
    return !text || parseHotelBlRobots(text, new URL(url).pathname)
  }

  /** Fetch a page if robots.txt allows it. Bot walls and errors come back as `error`; nothing is retried around them. */
  async page(url: string): Promise<HhtOppCrawlResult | { blocked: 'robots'; url: string }> {
    if (!(await this.allowed(url))) return { blocked: 'robots', url }
    return this.raw(url)
  }
}

// ---------------------------------------------------------------------------
// HTML extraction (cheerio)
// ---------------------------------------------------------------------------

export interface PageLink {
  url: string
  anchor: string
}

function absolute(href: string | undefined, base: string): string | null {
  if (!href || /^(mailto|tel|javascript|#)/i.test(href)) return null
  try {
    const url = new URL(href, base)
    return /^https?:$/.test(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function linksIn($: CheerioAPI, scope: ReturnType<CheerioAPI>, base: string, limit = 400): PageLink[] {
  const out: PageLink[] = []
  const seen = new Set<string>()
  scope.find('a[href]').each((_, el) => {
    if (out.length >= limit) return
    const url = absolute($(el).attr('href'), base)
    if (!url || seen.has(url)) return
    seen.add(url)
    out.push({ url, anchor: $(el).text().replace(/\s+/g, ' ').trim() })
  })
  return out
}

export function extractPageLinks(html: string, pageUrl: string): PageLink[] {
  const $ = load(html)
  return linksIn($, $.root(), pageUrl)
}

const BIO_SELECTOR = [
  '.author-bio', '.author-box', '.author-info', '.author-description', '.author-details', '.about-author',
  '.saboxplugin-wrap', '.saboxplugin-desc', '.sab-author', '.ts-author-box', '.entry-author', '.post-author-bio',
  '.td-author-description', '.molongui-author-box', '.wp-block-post-author', '.archive-description',
  '.author-archive', '.author-header', '[class*="author-bio"]', '[class*="about-author"]', '[class*="author-box"]',
  '[id*="author-bio"]', '[id*="about-author"]', '[id*="author-box"]',
].join(', ')

/** External links inside guest-author bio boxes (post footers and author archive headers). */
export function extractAuthorBioLinks(html: string, pageUrl: string): PageLink[] {
  const $ = load(html)
  const seed = registrableDomain(pageUrl)?.domain
  const out = new Map<string, PageLink>()
  $(BIO_SELECTOR).each((_, el) => {
    const box = $(el)
    // A bio is short. A container that holds the article is a layout wrapper, not a bio.
    if (box.text().replace(/\s+/g, ' ').trim().length > 1_500) return
    for (const link of linksIn($, box, pageUrl, 20)) {
      if (registrableDomain(link.url)?.domain === seed) continue
      out.set(link.url, link)
    }
  })
  // Plain-text bios: a short paragraph opening "About the author" or "<Name> is a … writer/blogger".
  $('p').each((_, el) => {
    const p = $(el)
    const text = p.text().replace(/\s+/g, ' ').trim()
    if (text.length > 600 || !/^(?:about the author\b|[A-Z][a-z]+(?: [A-Z][a-z]+){0,2} is an? [^.]{0,80}\b(?:writer|blogger|journalist|editor|founder|creator)\b)/i.test(text)) return
    for (const link of linksIn($, p, pageUrl, 10)) {
      if (registrableDomain(link.url)?.domain === seed) continue
      out.set(link.url, link)
    }
  })
  return [...out.values()]
}

/** Same-site post links on a guest listing page. */
export function extractListingPostLinks(html: string, pageUrl: string, limit = 6): string[] {
  const $ = load(html)
  const seed = registrableDomain(pageUrl)?.domain
  const out: string[] = []
  const scope = $('article, .entry-title, h2, h3')
  for (const link of linksIn($, scope.length ? scope : $.root(), pageUrl)) {
    if (out.length >= limit) break
    if (registrableDomain(link.url)?.domain !== seed) continue
    const path = new URL(link.url).pathname
    if (path.split('/').filter(Boolean).length === 0 || /\/(?:category|tag|page|author)\//.test(path)) continue
    if (!out.includes(link.url) && link.url !== pageUrl) out.push(link.url)
  }
  return out
}

/** External links in the main content of a resources / blogroll page. */
export function extractBlogrollLinks(html: string, pageUrl: string, limit: number = LOOKALIKE_DEFAULTS.maxLinksPerBlogrollPage): PageLink[] {
  const $ = load(html)
  $('nav, header, footer, script, style, noscript, .menu, .site-footer, .site-header, #comments, .comments').remove()
  const seed = registrableDomain(pageUrl)?.domain
  const main = $('main, article, .entry-content, .post-content, .page-content, #content').first()
  const scope = main.length ? main : $('body')
  return linksIn($, scope, pageUrl).filter((link) => registrableDomain(link.url)?.domain !== seed).slice(0, limit)
}

/** External links in sidebar widgets headed "Blogroll", "Blogs we love", … */
export function extractBlogrollWidgetLinks(html: string, pageUrl: string): PageLink[] {
  const $ = load(html)
  const seed = registrableDomain(pageUrl)?.domain
  const out: PageLink[] = []
  $('.widget_links, .widget, .wp-block-group, aside section').each((_, el) => {
    const box = $(el)
    const heading = box.find('h2, h3, h4, .widget-title, .widgettitle').first().text()
    if (!box.hasClass('widget_links') && !BLOGROLL_WIDGET_HEADING.test(heading)) return
    for (const link of linksIn($, box, pageUrl, 40)) {
      if (registrableDomain(link.url)?.domain !== seed) out.push(link)
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// Per-seed signals
// ---------------------------------------------------------------------------

export interface SeedScrape {
  seed: string
  hits: LookalikeHit[]
  pages: string[]
  error: string | null
}

function okPage(result: Awaited<ReturnType<PoliteFetcher['page']>>): HhtOppCrawlResult | null {
  if ('blocked' in result) return null
  return result.rawHtml && !result.error ? result : null
}

/** Signals 2 and 3 for one seed, within a page budget, robots.txt and host spacing respected. */
export async function scrapeLookalikeSeed(
  fetcher: PoliteFetcher,
  seed: string,
  options: { pitchUrl?: string | null; signals: LookalikeSignal[]; maxPages?: number },
): Promise<SeedScrape> {
  const out: SeedScrape = { seed, hits: [], pages: [], error: null }
  const budget = options.maxPages ?? LOOKALIKE_DEFAULTS.maxPagesPerSeed
  const wantBio = options.signals.includes('author_bio')
  const wantRoll = options.signals.includes('blogroll')
  const fetchPage = async (url: string): Promise<HhtOppCrawlResult | null> => {
    if (out.pages.length >= budget || out.pages.includes(url)) return null
    out.pages.push(url)
    const result = await fetcher.page(url)
    if ('blocked' in result) {
      out.error ??= `robots.txt disallows ${new URL(url).pathname}`
      return null
    }
    if (!okPage(result)) out.error ??= `${result.error ?? 'empty page'} at ${url}`
    return okPage(result)
  }

  const home = await fetchPage(`https://${seed}/`)
  if (!home) return out
  const base = home.finalUrl ?? `https://${seed}/`
  const links = extractPageLinks(home.rawHtml!, base)
  const pitch = options.pitchUrl ? await fetchPage(options.pitchUrl) : null
  if (pitch) links.push(...extractPageLinks(pitch.rawHtml!, pitch.finalUrl ?? options.pitchUrl!))

  if (wantRoll) {
    for (const link of extractBlogrollWidgetLinks(home.rawHtml!, base)) out.hits.push({ seed, signal: 'blogroll', url: link.url })
    for (const url of blogrollPageCandidates(links, seed)) {
      const page = await fetchPage(url)
      if (!page) continue
      for (const link of extractBlogrollLinks(page.rawHtml!, page.finalUrl ?? url)) out.hits.push({ seed, signal: 'blogroll', url: link.url })
    }
  }

  if (wantBio) {
    const { authors, listings } = guestPageCandidates(links, seed)
    const queue = [...authors]
    const users = await fetchPage(`${new URL(base).origin}/wp-json/wp/v2/users?per_page=100`)
    if (users) {
      const wp = parseWpUsers(users.rawHtml, seed)
      for (const url of wp.bioUrls) out.hits.push({ seed, signal: 'author_bio', url })
      queue.push(...wp.archiveUrls)
    }
    for (const url of listings.slice(0, 1)) {
      const listing = await fetchPage(url)
      if (!listing) continue
      const listingLinks = extractPageLinks(listing.rawHtml!, listing.finalUrl ?? url)
      queue.push(...listingLinks.filter((link) => isAuthorArchiveUrl(link.url) && registrableDomain(link.url)?.domain === seed).map((link) => link.url))
      queue.push(...extractListingPostLinks(listing.rawHtml!, listing.finalUrl ?? url))
    }
    // Bio boxes on pages already fetched count too (the pitch page often shows past contributors).
    for (const page of [home, pitch]) {
      if (!page) continue
      for (const link of extractAuthorBioLinks(page.rawHtml!, page.finalUrl ?? base)) out.hits.push({ seed, signal: 'author_bio', url: link.url })
    }
    for (const url of [...new Set(queue)].slice(0, LOOKALIKE_DEFAULTS.maxGuestPages)) {
      const page = await fetchPage(url)
      if (!page) continue
      for (const link of extractAuthorBioLinks(page.rawHtml!, page.finalUrl ?? url)) out.hits.push({ seed, signal: 'author_bio', url: link.url })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Semrush: domain_organic_organic through the HHT engine's MCP connection
// ---------------------------------------------------------------------------

export interface CompetitorFetch {
  hits: LookalikeHit[]
  rows: number
  dropped: number
  units: number | null
  stop?: 'semrush_credits' | 'semrush_auth' | 'semrush_rate_limit' | 'semrush_error'
  error?: string
}

export type LookalikeSemrushBackend = 'mcp' | 'api' | 'harvest'

export interface RawCompetitorReport {
  data: unknown
  units: number | null
}

const COMPETITOR_COLUMNS = ['domain', 'competition_level', 'common_keywords', 'organic_keywords', 'organic_traffic']

/**
 * domain_organic_organic per seed.
 *  - mcp (default): the HHT engine's Semrush MCP login, the same client, vault
 *    credential and hht_engine.semrush_usage ledger the BL pipeline and the
 *    guest frontier use. Units come from the MCP response metadata.
 *  - api: the SEMRUSH_API_KEY Analytics API client (opportunity-miner). Units
 *    are measured as the change in the key's unit balance around each call.
 * Calls are serialised so concurrent seeds never race an OAuth token refresh.
 */
export async function connectLookalikeSemrush(
  backend: LookalikeSemrushBackend = 'mcp',
  harvest?: Record<string, RawCompetitorReport>,
): Promise<{
  backend: LookalikeSemrushBackend
  competitors(seed: string, rows: number): Promise<CompetitorFetch>
  close(): Promise<void>
}> {
  let call: (seed: string, rows: number) => Promise<RawCompetitorReport>
  let close: () => Promise<void> = async () => undefined
  if (backend === 'harvest') {
    // Reports an agent already pulled with the Semrush MCP execute_report tool (already billed).
    call = async (seed) => {
      const report = harvest?.[seed]
      if (!report) throw new Error(`no harvested domain_organic_organic report for ${seed}`)
      return report
    }
  } else if (backend === 'mcp') {
    const engine = getEngineDatabase()
    const credential = await loadCredential(engine)
    if (!credential) throw new Error('Semrush is not connected. Sync the Semrush login (pnpm hht:engine:sync-semrush), pass --semrush=api, or pass --no-semrush.')
    const client = new SemrushMcpClient(credential, fetch, (next) => saveCredential(engine, next))
    call = async (seed, rows) => {
      const report = await client.executeReport('domain_organic_organic', {
        domain: seed,
        database: 'us',
        display_limit: rows,
        export_columns: COMPETITOR_COLUMNS,
      })
      await recordSemrushUnits(engine, 'domain_organic_organic', report.units, null)
      return report
    }
    close = closeEngineDatabase
  } else {
    const key = semrushApiKey(process.env)
    if (!key) throw new Error('SEMRUSH_API_KEY is not set; use --semrush=mcp or --no-semrush.')
    const client = createSemrushClient(undefined, process.env, true)
    call = async (seed, rows) => {
      const before = await semrushApiBalance(key)
      const data = await client.domainOrganicCompetitors(seed, { limit: rows })
      const after = await semrushApiBalance(key)
      return { data, units: before != null && after != null ? Math.max(0, before - after) : null }
    }
  }

  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }
  const fail = (stop: NonNullable<CompetitorFetch['stop']>, error: unknown): CompetitorFetch => ({
    hits: [], rows: 0, dropped: 0, units: null, stop, error: error instanceof Error ? error.message : String(error),
  })
  const classify = (error: unknown): SemrushCallClass => {
    const message = error instanceof Error ? error.message : String(error)
    if (/token refresh/i.test(message)) return 'auth'
    return error instanceof SemrushMcpError ? error.kind : classifySemrushFailure(message)
  }

  return {
    backend,
    competitors: (seed, rows) => serial(async () => {
      let report: RawCompetitorReport
      try {
        report = await call(seed, rows)
      } catch (error) {
        const kind = classify(error)
        if (kind === 'empty') return { hits: [], rows: 0, dropped: 0, units: 0 }
        if (kind === 'exhausted') return fail('semrush_credits', error)
        if (kind === 'auth') return fail('semrush_auth', error)
        if (kind !== 'rate_limit') return fail('semrush_error', error)
        await wait(5_000)
        try {
          report = await call(seed, rows)
        } catch (retry) {
          return fail('semrush_rate_limit', retry)
        }
      }
      const parsed = selectOrganicCompetitors(parseOrganicCompetitors(report.data))
      const kept = parsed.filter((row) => !row.dropped)
      return {
        hits: kept.map((row) => ({ seed, signal: 'organic_competitor' as const, url: row.domain, rank: row.rank })),
        rows: parsed.length,
        dropped: parsed.length - kept.length,
        units: report.units,
      }
    }),
    close,
  }
}

/** Remaining Analytics API units for a key (free call). */
async function semrushApiBalance(key: string): Promise<number | null> {
  try {
    const res = await fetch(`https://www.semrush.com/users/countapiunits.html?key=${encodeURIComponent(key)}`)
    const value = Number((await res.text()).trim())
    return res.ok && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Persisting into the export-leads flow
// ---------------------------------------------------------------------------

class DryRunRollback extends Error {}

export interface PersistSummary {
  keywordIds: number[]
  rowsWritten: number
  rolledBack: boolean
}

/**
 * One keyword row per processed (signal, seed), including ones that found
 * nothing (so the seed is not re-run), and one SERP-result row per candidate hit.
 * With `dryRun` every statement runs inside a transaction that is rolled back.
 */
export async function persistLookalike(
  db: Database,
  merged: MergeLookalikeResult,
  processed: Array<{ seed: string; signal: LookalikeSignal; resultsSeen: number; units: number | null; error: string | null }>,
  options: { dryRun?: boolean } = {},
): Promise<PersistSummary> {
  const summary: PersistSummary = { keywordIds: [], rowsWritten: 0, rolledBack: false }
  try {
    await db.transaction(async (tx) => {
      const now = new Date()
      const ids = new Map<string, number>()
      for (const pair of processed) {
        const key = `${pair.signal}|${pair.seed}`
        const candidates = merged.rows.filter((row) => row.seed === pair.seed && row.signal === pair.signal).length
        const values = {
          keyword: lookalikeKeyword(pair.signal, pair.seed),
          normalizedKeyword: lookalikeKeywordKey(pair.signal, pair.seed),
          sourceType: LOOKALIKE_SOURCE_TYPE,
          status: LOOKALIKE_KEYWORD_STATUS,
          skipReason: pair.error?.slice(0, 300) ?? null,
          bucket: LOOKALIKE_BUCKET,
          leadType: 'guest_post',
          resultsSeen: pair.resultsSeen,
          newDomains: candidates,
          unitsSpent: pair.units,
          fetchedAt: now,
          lastRunAt: now,
        }
        const [row] = await tx
          .insert(hhtOppGuestKeywords)
          .values(values)
          .onConflictDoUpdate({ target: hhtOppGuestKeywords.normalizedKeyword, set: values })
          .returning({ id: hhtOppGuestKeywords.id })
        if (row) ids.set(key, row.id)
      }
      for (const row of merged.rows) {
        const keywordId = ids.get(`${row.signal}|${row.seed}`)
        if (!keywordId) continue
        const inserted = await tx
          .insert(hhtOppGuestSerpResults)
          .values({ keywordId, position: row.position, url: row.url, domain: row.domain })
          .onConflictDoNothing({ target: [hhtOppGuestSerpResults.keywordId, hhtOppGuestSerpResults.url] })
          .returning({ id: hhtOppGuestSerpResults.id })
        summary.rowsWritten += inserted.length
      }
      summary.keywordIds = [...new Set(ids.values())].filter((id) =>
        merged.rows.some((row) => ids.get(`${row.signal}|${row.seed}`) === id),
      )
      if (options.dryRun) throw new DryRunRollback()
    })
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error
    summary.rolledBack = true
  }
  return summary
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface LookalikeRunOptions {
  seeds?: number
  /** Stop starting new seeds once this many new candidates are found. */
  limit?: number | null
  signals?: LookalikeSignal[]
  competitorRows?: number
  /** Explicit seed domains instead of the next ones in tracker order. */
  only?: string[]
  concurrency?: number
  semrushBackend?: LookalikeSemrushBackend
  /** seed → { data, units } from Semrush MCP execute_report runs done outside this process. */
  organicHarvest?: Record<string, RawCompetitorReport>
  dryRun?: boolean
  trackerPath?: string
  log?: (message: string) => void
}

export interface LookalikeRunResult {
  seedsAvailable: number
  seedsRun: string[]
  signals: LookalikeSignal[]
  pagesFetched: number
  semrush: { backend: string | null; calls: number; rows: number; droppedBrands: number; units: number; stop: string | null; error: string | null }
  hits: Record<LookalikeSignal, number>
  candidates: number
  candidatesBySignal: Record<LookalikeSignal, number>
  multiSeed: number
  known: number
  junk: number
  junkSample: Array<{ domain: string; reason: string }>
  top: Array<{ domain: string; seeds: string[]; signals: LookalikeSignal[] }>
  scrapeErrors: Array<{ seed: string; error: string }>
  persisted: PersistSummary
  report: string
  next: string
}

export async function runGuestLookalike(db: Database, options: LookalikeRunOptions = {}): Promise<LookalikeRunResult> {
  const log = options.log ?? ((message: string) => console.error(message))
  const signals = options.signals?.length ? options.signals : (['organic_competitor', 'author_bio', 'blogroll'] as LookalikeSignal[])
  const state = await loadLookalikeSeeds(db, options.trackerPath)
  const pending = (options.only?.length ? options.only : state.seeds).filter((seed) => signals.some((signal) => !state.done[signal].has(seed)))
  const picked = pending.slice(0, Math.max(0, options.seeds ?? 3))
  const known = await knownGuestDomains(db, state.tracked)
  for (const seed of state.seeds) known.add(seed)

  const fetcher = new PoliteFetcher()
  const semrush = signals.includes('organic_competitor') ? await connectLookalikeSemrush(options.organicHarvest ? 'harvest' : options.semrushBackend, options.organicHarvest) : null
  const result: LookalikeRunResult = {
    seedsAvailable: pending.length,
    seedsRun: [],
    signals,
    pagesFetched: 0,
    semrush: { backend: semrush?.backend ?? null, calls: 0, rows: 0, droppedBrands: 0, units: 0, stop: null, error: null },
    hits: { organic_competitor: 0, author_bio: 0, blogroll: 0 },
    candidates: 0,
    candidatesBySignal: { organic_competitor: 0, author_bio: 0, blogroll: 0 },
    multiSeed: 0,
    known: 0,
    junk: 0,
    junkSample: [],
    top: [],
    scrapeErrors: [],
    persisted: { keywordIds: [], rowsWritten: 0, rolledBack: false },
    report: '',
    next: '',
  }
  const hits: LookalikeHit[] = []
  const processed: Parameters<typeof persistLookalike>[2] = []
  const newCandidates = () => mergeLookalikeHits(hits, known).candidates.length

  const runSeed = async (seed: string) => {
    const todo = signals.filter((signal) => !state.done[signal].has(seed))
    result.seedsRun.push(seed)
    if (todo.includes('organic_competitor') && semrush && !result.semrush.stop) {
      const fetched = await semrush.competitors(seed, options.competitorRows ?? LOOKALIKE_DEFAULTS.competitorRows)
      if (fetched.stop) {
        result.semrush.stop = fetched.stop
        result.semrush.error = fetched.error ?? null
        log(`Semrush stopped: ${fetched.error ?? fetched.stop}`)
      } else {
        result.semrush.calls += 1
        result.semrush.rows += fetched.rows
        result.semrush.droppedBrands += fetched.dropped
        result.semrush.units += fetched.units ?? 0
        hits.push(...fetched.hits)
        processed.push({ seed, signal: 'organic_competitor', resultsSeen: fetched.rows, units: fetched.units, error: null })
        log(`${seed}: ${fetched.rows} organic competitors (${fetched.dropped} dropped), ${fetched.units ?? '?'} units`)
      }
    }
    const scrapeSignals = todo.filter((signal) => signal !== 'organic_competitor')
    if (scrapeSignals.length) {
      const scraped = await scrapeLookalikeSeed(fetcher, seed, { pitchUrl: state.pitchUrls.get(seed), signals: scrapeSignals })
      hits.push(...scraped.hits)
      if (scraped.error) result.scrapeErrors.push({ seed, error: scraped.error })
      for (const signal of scrapeSignals) {
        processed.push({ seed, signal, resultsSeen: scraped.hits.filter((hit) => hit.signal === signal).length, units: null, error: scraped.error })
      }
      log(`${seed}: ${scraped.pages.length} pages, ${scraped.hits.filter((h) => h.signal === 'author_bio').length} bio links, ${scraped.hits.filter((h) => h.signal === 'blogroll').length} blogroll links${scraped.error ? ` (${scraped.error})` : ''}`)
    }
  }

  try {
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 6))
    for (let i = 0; i < picked.length; i += concurrency) {
      if (options.limit != null && newCandidates() >= options.limit) {
        log(`Reached --limit ${options.limit} new candidates; stopping before ${picked.length - i} more seeds.`)
        break
      }
      await Promise.all(picked.slice(i, i + concurrency).map(runSeed))
    }
  } finally {
    await semrush?.close()
  }

  const merged = mergeLookalikeHits(hits, known)
  result.pagesFetched = fetcher.pages
  for (const hit of hits) result.hits[hit.signal] += 1
  result.candidates = merged.candidates.length
  for (const candidate of merged.candidates) for (const signal of candidate.signals) result.candidatesBySignal[signal] += 1
  result.multiSeed = merged.candidates.filter((candidate) => candidate.seeds.length > 1).length
  result.known = merged.known
  result.junk = merged.junk.length
  result.junkSample = merged.junk.slice(0, 15)
  result.top = capLookalikeCandidates(merged, 25).candidates.map(({ domain, seeds, signals: s }) => ({ domain, seeds, signals: s }))
  result.persisted = await persistLookalike(db, merged, processed, { dryRun: options.dryRun })

  mkdirSync(LOOKALIKE_REPORT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  result.report = join(LOOKALIKE_REPORT_DIR, `lookalike-${stamp}${options.dryRun ? '-dry-run' : ''}.json`)
  writeFileSync(result.report, JSON.stringify({ ...result, candidates: merged.candidates, junk: merged.junk, processed }, null, 2))
  result.next = result.persisted.rolledBack || result.persisted.keywordIds.length === 0
    ? 'Dry run: nothing written. Re-run without --dry-run to store candidates.'
    : `pnpm hht:opp export-leads --keyword-ids=${result.persisted.keywordIds.join(',')} --link-limit=0`
  return result
}

export interface LookalikePreview {
  tracker: string
  pursueSeeds: number
  trackedDomains: number
  done: Record<LookalikeSignal, number>
  pending: number
  next: string[]
  estimatedUnits: { perSeed: number; next: number; allPending: number }
}

export async function previewGuestLookalike(db: Database, options: { seeds?: number; competitorRows?: number; trackerPath?: string } = {}): Promise<LookalikePreview> {
  const state = await loadLookalikeSeeds(db, options.trackerPath)
  const pending = state.seeds.filter((seed) => !state.done.organic_competitor.has(seed) || !state.done.author_bio.has(seed) || !state.done.blogroll.has(seed))
  const next = pending.slice(0, options.seeds ?? 10)
  const perSeed = (options.competitorRows ?? LOOKALIKE_DEFAULTS.competitorRows) * ORGANIC_COMPETITOR_UNITS_PER_ROW
  const needsSemrush = (list: string[]) => list.filter((seed) => !state.done.organic_competitor.has(seed)).length
  return {
    tracker: options.trackerPath ?? LOOKALIKE_TRACKER_PATH,
    pursueSeeds: state.seeds.length,
    trackedDomains: state.tracked.size,
    done: {
      organic_competitor: state.done.organic_competitor.size,
      author_bio: state.done.author_bio.size,
      blogroll: state.done.blogroll.size,
    },
    pending: pending.length,
    next,
    estimatedUnits: { perSeed, next: perSeed * needsSemrush(next), allPending: perSeed * needsSemrush(pending) },
  }
}

export interface LookalikeYield {
  source: string
  exported: number
  evaluated: number
  pursue: number
  pitchablePerNewDomain: number | null
}

/**
 * Pitchable per exported domain, lookalike vs SERP. The plan's bar: make
 * lookalike a standing source if it beats 2x the SERP baseline (~3.6%).
 */
export async function lookalikeYieldReport(db: Database, options: { trackerPath?: string } = {}): Promise<{ baseline: number; rows: LookalikeYield[] }> {
  await ensureLeadExportSchema(db)
  // Verdicts: the tracker is the source of truth; hht_opp_guest_evaluations fills gaps.
  const verdicts = new Map<string, string>()
  for (const row of rowsOf<{ d: string; v: string }>(await db.execute(sql`select root_domain as d, verdict as v from hht_opp_guest_evaluations`))) {
    verdicts.set(row.d, row.v.toUpperCase())
  }
  for (const row of readTrackerRows(options.trackerPath)) {
    const root = registrableDomain(row['site'] ?? '')?.domain
    if (root && row['verdict']) verdicts.set(root, row['verdict'].trim().toUpperCase())
  }
  const exports = rowsOf<{ d: string; bucket: string | null }>(await db.execute(sql`
    select root_domain as d, bucket from hht_opp_lead_exports where lead_type = 'guest_post'`))
  const bySource = new Map<string, LookalikeYield>()
  for (const row of exports) {
    const source = row.bucket === LOOKALIKE_BUCKET ? 'lookalike' : row.bucket?.startsWith('legacy_tier_') ? 'legacy' : 'serp'
    const entry = bySource.get(source) ?? { source, exported: 0, evaluated: 0, pursue: 0, pitchablePerNewDomain: null }
    entry.exported += 1
    const verdict = verdicts.get(row.d)
    if (verdict) entry.evaluated += 1
    if (verdict === 'PURSUE') entry.pursue += 1
    bySource.set(source, entry)
  }
  const rows = [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source))
  for (const row of rows) row.pitchablePerNewDomain = row.evaluated > 0 ? Number((row.pursue / row.evaluated).toFixed(4)) : null
  return { baseline: SERP_BASELINE_PITCHABLE_RATE, rows }
}
