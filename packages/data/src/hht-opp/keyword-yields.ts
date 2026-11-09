import 'server-only'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeFrontierKeyword, parseLeadCsv } from '@rnr/core'
import { asc } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppGuestKeywords } from '../schema.js'

/**
 * Rebuild exports/guest-post-outreach/keyword-yields-<date>.csv from the Guest Post
 * Master Tracker so guest-templates ranks and retires templates on current results.
 *
 * Attribution: a tracker row counts for its own source_query, else for the query of
 * the first handoff CSV that exported the domain. A keyword whose exported guest
 * leads are not yet mostly in the tracker gets evaluation_coverage "unknown", which
 * guest-templates reads as "estimate from new domains" rather than zero.
 */

export const KEYWORD_YIELD_COLUMNS = [
  'keyword_id', 'keyword', 'pitchable_opportunities', 'drafts_created', 'evaluated_domains',
  'needs_review', 'skipped', 'exported_guest_leads', 'serp_results', 'frontier_new_domains',
  'search_status', 'evaluation_coverage', 'bucket', 'fetched_at',
] as const

/** Share of a keyword's exported guest leads that must be in the tracker before its count is final. */
export const KEYWORD_YIELD_MIN_COVERAGE = 0.8

export type TrackerVerdictRow = { domain: string; verdict: string; sourceQuery: string; draftId: string }
export type HandoffLeadRow = { domain: string; sourceQuery: string; leadType: string }
export type KeywordRow = {
  id: number
  keyword: string
  normalizedKeyword: string
  status: string
  bucket: string | null
  resultsSeen: number | null
  newDomains: number | null
  fetchedAt: Date | null
}

export type KeywordYieldRow = Record<(typeof KEYWORD_YIELD_COLUMNS)[number], string | number>

export function buildKeywordYields(input: {
  keywords: readonly KeywordRow[]
  tracker: readonly TrackerVerdictRow[]
  handoff: readonly HandoffLeadRow[]
  /** Previous yields file rows by keyword_id, carried forward where nothing newer is attributable. */
  previous?: ReadonlyMap<number, Record<string, string>>
}): KeywordYieldRow[] {
  const firstExport = new Map<string, string>()
  const exported = new Map<string, Set<string>>()
  for (const row of input.handoff) {
    if (row.leadType === 'link_insertion') continue
    const query = normalizeFrontierKeyword(row.sourceQuery)
    const domain = row.domain.trim().toLowerCase()
    if (!query || !domain) continue
    if (!firstExport.has(domain)) firstExport.set(domain, query)
    if (!exported.has(query)) exported.set(query, new Set())
    exported.get(query)!.add(domain)
  }

  type Tally = { pitchable: number; drafts: number; evaluated: Set<string>; review: number; skipped: number }
  const tallies = new Map<string, Tally>()
  const tracked = new Set<string>()
  for (const row of input.tracker) {
    const domain = row.domain.trim().toLowerCase()
    if (!domain) continue
    tracked.add(domain)
    const query = normalizeFrontierKeyword(row.sourceQuery) || firstExport.get(domain)
    if (!query) continue
    const tally = tallies.get(query) ?? { pitchable: 0, drafts: 0, evaluated: new Set<string>(), review: 0, skipped: 0 }
    tallies.set(query, tally)
    if (tally.evaluated.has(domain)) continue
    tally.evaluated.add(domain)
    const verdict = row.verdict.trim().toUpperCase()
    if (verdict === 'PURSUE') tally.pitchable += 1
    else if (verdict === 'NEEDS_REVIEW') tally.review += 1
    else if (verdict.startsWith('SKIP') || verdict === 'PAID_ONLY') tally.skipped += 1
    if (verdict === 'PURSUE' && row.draftId.trim()) tally.drafts += 1
  }

  const out: KeywordYieldRow[] = []
  for (const keyword of input.keywords) {
    const query = normalizeFrontierKeyword(keyword.keyword) || keyword.normalizedKeyword
    const tally = tallies.get(query)
    const leads = exported.get(query)
    const fetched = keyword.fetchedAt != null
    if (!tally && !leads && !fetched) continue
    const leadCount = leads?.size ?? 0
    const covered = leads ? [...leads].filter((domain) => tracked.has(domain)).length : 0
    const prior = input.previous?.get(keyword.id)
    let coverage: string
    let pitchable = tally?.pitchable ?? 0
    if (leadCount > 0 && covered / leadCount < KEYWORD_YIELD_MIN_COVERAGE) {
      coverage = `unknown: ${covered} of ${leadCount} exported guest leads evaluated`
    } else if (leadCount === 0 && !tally && (keyword.status === 'NO_DATA' || keyword.status === 'EXHAUSTED')) {
      // A fetch that returned no SERP or no new blogs: a real zero for the template.
      coverage = 'final: fetch found no new domains'
    } else if (leadCount === 0 && !tally && prior && !/unknown/i.test(prior['evaluation_coverage'] ?? '')
      && Number.isFinite(Number(prior['pitchable_opportunities']))) {
      pitchable = Number(prior['pitchable_opportunities'])
      coverage = 'final: carried forward from the previous yields file'
    } else if (leadCount === 0 && !tally) {
      // Fetched but nothing exported or attributed yet: export may still be pending.
      coverage = 'unknown: no exported or attributed leads yet'
    } else {
      coverage = 'final: tracker verdicts, first-source attribution'
    }
    out.push({
      keyword_id: keyword.id,
      keyword: keyword.keyword,
      pitchable_opportunities: pitchable,
      drafts_created: tally?.drafts ?? 0,
      evaluated_domains: tally?.evaluated.size ?? 0,
      needs_review: tally?.review ?? 0,
      skipped: tally?.skipped ?? 0,
      exported_guest_leads: leadCount,
      serp_results: keyword.resultsSeen ?? '',
      frontier_new_domains: keyword.newDomains ?? '',
      search_status: keyword.status,
      evaluation_coverage: coverage,
      bucket: keyword.bucket ?? '',
      fetched_at: keyword.fetchedAt?.toISOString() ?? '',
    })
  }
  return out.sort((a, b) => Number(b.pitchable_opportunities) - Number(a.pitchable_opportunities)
    || Number(a.keyword_id) - Number(b.keyword_id))
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export async function writeKeywordYields(db: Database, options: {
  repoRoot: string
  trackerCsv?: string
  out?: string
  dryRun?: boolean
}): Promise<{ file: string | null; keywords: number; final: number; unknown: number; pitchable: number; trackerRows: number; handoffRows: number }> {
  const trackerCsv = resolve(options.trackerCsv ?? join(options.repoRoot, 'exports/handoff/exclusions/tracker-verdicts.csv'))
  if (!existsSync(trackerCsv)) {
    throw new Error(`${trackerCsv} not found. Run: python3 .agents/skills/guest-post-pitches/scripts/run_tools.py exclusions`)
  }
  const tracker = parseLeadCsv(readFileSync(trackerCsv, 'utf8')).map((row) => ({
    domain: row['domain'] ?? '',
    verdict: row['verdict'] ?? '',
    sourceQuery: row['source_query'] ?? '',
    draftId: row['outreach_email_id'] ?? '',
  }))
  const handoffDir = join(options.repoRoot, 'exports/handoff')
  const handoff: HandoffLeadRow[] = []
  for (const name of readdirSync(handoffDir).filter((file) => /^hht-guest-serp-.*\.csv$/.test(file)).sort()) {
    for (const row of parseLeadCsv(readFileSync(join(handoffDir, name), 'utf8'))) {
      handoff.push({ domain: row['domain'] ?? '', sourceQuery: row['source_query'] ?? '', leadType: row['lead_type'] ?? 'guest_post' })
    }
  }
  const keywords = await db.select({
    id: hhtOppGuestKeywords.id,
    keyword: hhtOppGuestKeywords.keyword,
    normalizedKeyword: hhtOppGuestKeywords.normalizedKeyword,
    status: hhtOppGuestKeywords.status,
    bucket: hhtOppGuestKeywords.bucket,
    resultsSeen: hhtOppGuestKeywords.resultsSeen,
    newDomains: hhtOppGuestKeywords.newDomains,
    fetchedAt: hhtOppGuestKeywords.fetchedAt,
  }).from(hhtOppGuestKeywords).orderBy(asc(hhtOppGuestKeywords.id))

  const yieldsDir = join(options.repoRoot, 'exports/guest-post-outreach')
  const latest = existsSync(yieldsDir)
    ? readdirSync(yieldsDir).filter((name) => /^keyword-yields-.*\.csv$/.test(name)).sort().at(-1)
    : undefined
  const previous = new Map<number, Record<string, string>>()
  if (latest) {
    for (const row of parseLeadCsv(readFileSync(join(yieldsDir, latest), 'utf8'))) {
      const id = Number(row['keyword_id'])
      if (Number.isInteger(id)) previous.set(id, row)
    }
  }
  const rows = buildKeywordYields({ keywords, tracker, handoff, previous })
  const unknown = rows.filter((row) => String(row.evaluation_coverage).startsWith('unknown')).length
  const summary = {
    keywords: rows.length,
    final: rows.length - unknown,
    unknown,
    pitchable: rows.reduce((sum, row) => sum + Number(row.pitchable_opportunities), 0),
    trackerRows: tracker.length,
    handoffRows: handoff.length,
  }
  if (options.dryRun) return { file: null, ...summary }
  const date = new Date().toISOString().slice(0, 10)
  const file = resolve(options.out ?? join(options.repoRoot, `exports/guest-post-outreach/keyword-yields-${date}.csv`))
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, [KEYWORD_YIELD_COLUMNS.join(','), ...rows.map((row) => KEYWORD_YIELD_COLUMNS.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n')
  return { file, ...summary }
}
