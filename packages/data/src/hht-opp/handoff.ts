import 'server-only'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chunkLeadRows,
  excludeDiscoveryDomain,
  leadRowsToCsv,
  parseLeadCsv,
  registrableDomain,
  buildSerpLeads,
  sortLeadRows,
  type DomainLead,
  type LeadRow,
  type LeadType,
  type SerpHit,
} from '@rnr/core'
import { sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppLeadExports } from '../schema.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
export const HHT_OPP_HANDOFF_DIR = join(REPO_ROOT, 'exports/handoff')
export const HHT_OPP_EXCLUSIONS_DIR = join(HHT_OPP_HANDOFF_DIR, 'exclusions')
const PX_EXCLUSIONS = join(REPO_ROOT, 'hht-px-exclusions.csv')

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'msn.com',
])

export async function ensureLeadExportSchema(db: Database): Promise<void> {
  const ddl = readFileSync(fileURLToPath(new URL('../../drizzle/0048_hht_opp_lead_exports.sql', import.meta.url)), 'utf8')
  for (const statement of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement))
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[]
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  const first = rows[0]
  if (!first) return ''
  const keys = Object.keys(first)
  const cell = (value: unknown): string => {
    if (value == null) return ''
    const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return `${[keys.join(','), ...rows.map((row) => keys.map((key) => cell(row[key])).join(','))].join('\n')}\n`
}

/** Write every hht_opp_* table to exports/archive as JSONL (lossless) and CSV (readable). */
export async function archiveHhtOpp(db: Database, options: { dir?: string } = {}): Promise<{ dir: string; tables: Record<string, number> }> {
  const dir = options.dir ?? join(REPO_ROOT, `exports/archive/hht-opp-${today()}`)
  mkdirSync(dir, { recursive: true })
  const tables = rowsOf<{ table_name: string }>(await db.execute(sql`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_name like 'hht\\_opp\\_%'
    order by table_name`))
  const counts: Record<string, number> = {}
  for (const { table_name: table } of tables) {
    const rows = rowsOf<Record<string, unknown>>(await db.execute(sql.raw(`select * from "${table}" order by 1`)))
    writeFileSync(join(dir, `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
    writeFileSync(join(dir, `${table}.csv`), toCsv(rows))
    counts[table] = rows.length
  }
  return { dir, tables: counts }
}

function domainsFromValue(value: string): string[] {
  const out: string[] = []
  for (const part of value.split(/[\s|;,]+/)) {
    const text = part.trim().toLowerCase()
    if (!text) continue
    const host = text.includes('@') ? text.split('@').pop() ?? '' : text
    if (FREE_MAIL.has(host)) continue
    const root = registrableDomain(host)?.domain
    if (root) out.push(root)
  }
  return out
}

/**
 * Domains that must never be handed off again: any CSV dropped into
 * exports/handoff/exclusions (tracker main tab, tracker "Full Articles" tab,
 * outreach-tool exports) plus hht-px-exclusions.csv. Columns whose header
 * mentions domain, site, website, url or email are read.
 */
export function loadExclusionDomains(dir = HHT_OPP_EXCLUSIONS_DIR): { domains: Set<string>; sources: Record<string, number> } {
  const domains = new Set<string>()
  const sources: Record<string, number> = {}
  const files: string[] = []
  try {
    for (const name of readdirSync(dir)) if (name.toLowerCase().endsWith('.csv')) files.push(join(dir, name))
  } catch {
    // The folder is optional.
  }
  try {
    readFileSync(PX_EXCLUSIONS)
    files.push(PX_EXCLUSIONS)
  } catch {
    // Optional too.
  }
  for (const file of files) {
    const before = domains.size
    for (const row of parseLeadCsv(readFileSync(file, 'utf8'))) {
      for (const [key, value] of Object.entries(row)) {
        if (!value || !/domain|site|website|url|email/i.test(key)) continue
        for (const root of domainsFromValue(value)) domains.add(root)
      }
    }
    sources[basename(file)] = domains.size - before
  }
  return { domains, sources }
}

async function exportedDomains(db: Database, leadType: string): Promise<Set<string>> {
  const rows = rowsOf<{ root_domain: string }>(await db.execute(sql`
    select root_domain from hht_opp_lead_exports where lead_type = ${leadType}`))
  return new Set(rows.map((row) => row.root_domain))
}

/** Write rows as files of `fileSize`, then record them in the ledger. */
export async function writeLeadFiles(
  db: Database,
  rows: LeadRow[],
  options: { prefix: string; fileSize: number; dryRun?: boolean; keywordIds?: Map<string, number | null> },
): Promise<string[]> {
  mkdirSync(HHT_OPP_HANDOFF_DIR, { recursive: true })
  const files: string[] = []
  const chunks = chunkLeadRows(sortLeadRows(rows), options.fileSize)
  const existing = rowsOf<{ n: number }>(await db.execute(sql`
    select count(distinct batch_id)::int as n from hht_opp_lead_exports where batch_id like ${`${options.prefix}-%`}`))
  const offset = existing[0]?.n ?? 0
  for (const [index, chunk] of chunks.entries()) {
    const batchId = `${options.prefix}-${String(offset + index + 1).padStart(2, '0')}`
    const fileName = `${batchId}.csv`
    const stamped = chunk.map((row) => ({ ...row, batchId }))
    files.push(join(HHT_OPP_HANDOFF_DIR, fileName))
    if (options.dryRun) continue
    writeFileSync(join(HHT_OPP_HANDOFF_DIR, fileName), leadRowsToCsv(stamped))
    for (const row of stamped) {
      await db.insert(hhtOppLeadExports).values({
        rootDomain: row.domain,
        leadType: row.leadType,
        batchId,
        fileName,
        opportunityUrl: row.opportunityUrl,
        sourceQuery: row.sourceQuery,
        bucket: row.bucket,
        keywordId: options.keywordIds?.get(row.domain) ?? null,
        score: row.score,
      }).onConflictDoNothing()
    }
  }
  return files
}

export type LegacyTier = 'A' | 'B' | 'C'

export interface LegacyBacklogResult {
  candidates: Record<LegacyTier, number>
  excluded: { alreadyExported: number; exclusionList: number; junk: number }
  exported: number
  files: string[]
  exclusionSources: Record<string, number>
}

const GUEST_TYPES = ['editorial_guest']
const PAID_TYPES = ['paid_guest_post', 'sponsored_content']

/**
 * One-off handoff of domains the retired rule-based evaluator looked at but never pitched.
 *  A: old PURSUE, or NEEDS_REVIEW with an editorial guest-post page
 *  B: NEEDS_REVIEW with only paid/sponsored pages
 *  C: NEEDS_REVIEW with no invitation found (forums, 403s, plain blogs)
 * SKIP_* verdicts are never exported.
 */
export async function exportLegacyBacklog(
  db: Database,
  options: { tiers?: LegacyTier[]; fileSize?: number; dryRun?: boolean } = {},
): Promise<LegacyBacklogResult> {
  await ensureLeadExportSchema(db)
  const tiers = new Set(options.tiers?.length ? options.tiers : ['A'])
  const rows = rowsOf<{
    root_domain: string
    verdict: string
    pitch_url: string | null
    types: string[] | null
    guest_urls: string[] | null
    paid_urls: string[] | null
    overall: number | null
  }>(await db.execute(sql`
    select e.root_domain, e.verdict, e.pitch_url,
      array_remove(array_agg(distinct o.opportunity_type), null) as types,
      array_remove(array_agg(distinct o.opportunity_url) filter (where o.opportunity_type = 'editorial_guest'), null) as guest_urls,
      array_remove(array_agg(distinct o.opportunity_url) filter (where o.opportunity_type in ('paid_guest_post', 'sponsored_content')), null) as paid_urls,
      max(o.overall_score) as overall
    from hht_opp_guest_evaluations e
    left join hht_opp_domains d on d.root_domain = e.root_domain
    left join hht_opp_opportunities o on o.domain_id = d.id
    where e.verdict in ('PURSUE', 'NEEDS_REVIEW')
    group by e.root_domain, e.verdict, e.pitch_url`))

  const already = await exportedDomains(db, 'guest_post')
  const exclusions = loadExclusionDomains()
  const result: LegacyBacklogResult = {
    candidates: { A: 0, B: 0, C: 0 },
    excluded: { alreadyExported: 0, exclusionList: 0, junk: 0 },
    exported: 0,
    files: [],
    exclusionSources: exclusions.sources,
  }
  const leads: LeadRow[] = []
  for (const row of rows) {
    const types = row.types ?? []
    const guestUrls = row.guest_urls ?? []
    const tier: LegacyTier = row.verdict === 'PURSUE' || types.some((t) => GUEST_TYPES.includes(t))
      ? 'A'
      : types.some((t) => PAID_TYPES.includes(t)) ? 'B' : 'C'
    result.candidates[tier] += 1
    if (!tiers.has(tier)) continue
    const domain = row.root_domain
    if (already.has(domain)) {
      result.excluded.alreadyExported += 1
      continue
    }
    if (exclusions.domains.has(domain)) {
      result.excluded.exclusionList += 1
      continue
    }
    if (excludeDiscoveryDomain(domain).excluded) {
      result.excluded.junk += 1
      continue
    }
    const base = row.verdict === 'PURSUE' ? 100 : tier === 'A' ? 70 : tier === 'B' ? 40 : 10
    const opportunityUrl = row.verdict === 'PURSUE' ? row.pitch_url ?? guestUrls[0] ?? null : guestUrls[0] ?? row.pitch_url
    leads.push({
      domain,
      opportunityUrl,
      allUrls: [opportunityUrl, row.pitch_url, ...guestUrls, ...(row.paid_urls ?? [])].filter((u): u is string => !!u),
      sourceQuery: `legacy-eval:${row.verdict.toLowerCase()}`,
      bucket: `legacy_tier_${tier.toLowerCase()}`,
      leadType: 'guest_post',
      score: base + 0.4 * Math.max(0, Math.min(100, row.overall ?? 0)),
      bestPosition: null,
      queryHits: null,
      batchId: '',
    })
  }
  result.exported = leads.length
  result.files = await writeLeadFiles(db, leads, {
    prefix: `hht-guest-legacy-${today()}`,
    fileSize: options.fileSize ?? 50,
    dryRun: options.dryRun,
  })
  return result
}

export interface SerpExportResult {
  hits: number
  junk: number
  junkSample: Array<{ domain: string; reason: string }>
  excluded: { alreadyExported: number; exclusionList: number; priorSkip: number }
  available: Record<LeadType, number>
  exported: Record<LeadType, number>
  heldForNextRun: Record<LeadType, number>
  files: string[]
  exclusionSources: Record<string, number>
  perQuery: Array<{ query: string; bucket: string | null; resultsSeen: number; newDomains: number; leads: number }>
}

/**
 * Turn stored SERP results into the next handoff CSV. Only the top `limit`
 * guest-post domains are exported per run; the rest stay unexported and are
 * picked up next time. Link-insertion leads go to their own file.
 */
export async function exportSerpLeads(
  db: Database,
  options: { limit?: number; linkLimit?: number; fileSize?: number; dryRun?: boolean } = {},
): Promise<SerpExportResult> {
  await ensureLeadExportSchema(db)
  const limit = options.limit ?? 50
  const linkLimit = options.linkLimit ?? 50
  const hits = rowsOf<{
    url: string
    domain: string
    position: number
    keyword_id: number
    keyword: string
    bucket: string | null
    lead_type: string | null
  }>(await db.execute(sql`
    select r.url, r.domain, r.position, r.keyword_id, k.keyword, k.bucket, k.lead_type
    from hht_opp_guest_serp_results r
    join hht_opp_guest_keywords k on k.id = r.keyword_id`)).map((row): SerpHit => ({
    url: row.url,
    domain: row.domain,
    position: row.position,
    keywordId: row.keyword_id,
    keyword: row.keyword,
    bucket: row.bucket,
    leadType: row.lead_type === 'link_insertion' ? 'link_insertion' : 'guest_post',
  }))

  const built = buildSerpLeads(hits)
  const exclusions = loadExclusionDomains()
  const exported = {
    guest_post: await exportedDomains(db, 'guest_post'),
    link_insertion: await exportedDomains(db, 'link_insertion'),
  }
  const priorSkips = new Set(rowsOf<{ root_domain: string }>(await db.execute(sql`
    select root_domain from hht_opp_guest_evaluations where verdict like 'SKIP%'`)).map((row) => row.root_domain))

  const result: SerpExportResult = {
    hits: hits.length,
    junk: built.junk.length,
    junkSample: built.junk.slice(0, 25),
    excluded: { alreadyExported: 0, exclusionList: 0, priorSkip: 0 },
    available: { guest_post: 0, link_insertion: 0 },
    exported: { guest_post: 0, link_insertion: 0 },
    heldForNextRun: { guest_post: 0, link_insertion: 0 },
    files: [],
    exclusionSources: exclusions.sources,
    perQuery: [],
  }
  const fresh: Record<LeadType, DomainLead[]> = { guest_post: [], link_insertion: [] }
  for (const lead of built.leads) {
    if (exported[lead.leadType].has(lead.domain)) {
      result.excluded.alreadyExported += 1
      continue
    }
    if (exclusions.domains.has(lead.domain)) {
      result.excluded.exclusionList += 1
      continue
    }
    if (lead.leadType === 'guest_post' && priorSkips.has(lead.domain)) {
      result.excluded.priorSkip += 1
      continue
    }
    fresh[lead.leadType].push(lead)
  }

  const date = today()
  for (const [leadType, cap, prefix] of [
    ['guest_post', limit, `hht-guest-serp-${date}`],
    ['link_insertion', linkLimit, `hht-link-insertion-${date}`],
  ] as const) {
    const ranked = sortLeadRows(fresh[leadType])
    const picked = ranked.slice(0, cap)
    result.available[leadType] = ranked.length
    result.exported[leadType] = picked.length
    result.heldForNextRun[leadType] = ranked.length - picked.length
    if (picked.length === 0) continue
    result.files.push(...await writeLeadFiles(db, picked, {
      prefix,
      fileSize: options.fileSize ?? cap,
      dryRun: options.dryRun,
      keywordIds: new Map(picked.map((lead) => [lead.domain, lead.keywordId])),
    }))
  }

  const pickedByQuery = new Map<string, number>()
  for (const leadType of ['guest_post', 'link_insertion'] as const) {
    for (const lead of sortLeadRows(fresh[leadType]).slice(0, leadType === 'guest_post' ? limit : linkLimit)) {
      pickedByQuery.set(lead.sourceQuery, (pickedByQuery.get(lead.sourceQuery) ?? 0) + 1)
    }
  }
  const keywords = rowsOf<{ keyword: string; bucket: string | null; results_seen: number; new_domains: number }>(await db.execute(sql`
    select keyword, bucket, results_seen, new_domains from hht_opp_guest_keywords
    where fetched_at is not null order by last_run_at desc nulls last, id`))
  result.perQuery = keywords.map((row) => ({
    query: row.keyword,
    bucket: row.bucket,
    resultsSeen: row.results_seen,
    newDomains: row.new_domains,
    leads: pickedByQuery.get(row.keyword) ?? 0,
  }))
  return result
}
