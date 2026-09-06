/**
 * Semrush adapter.
 *
 * Application code talks to this client, never to MCP or CSV column codes.
 * MCP report names are the method vocabulary; HTTP calls use the classic
 * Analytics API which is the same report set the Semrush MCP wraps.
 *
 * Unavailable on the connected Semrush plan (do not fabricate):
 *   - Traffic Analytics (visits, channels, audience) — traffic_overview MCP
 *     returns a plan-gated error. Use domain_rank organic_traffic as a labeled
 *     proxy, never as "visits".
 */

import { createHash } from 'node:crypto'
import { OM_CACHE_TTL_DAYS } from '@rnr/core'
import type { Database } from '../../db.js'
import {
  FILTER_OP_TO_API,
  FRIENDLY_TO_CODE,
  KEYWORD_METRIC_COLUMNS,
  MCP_SORT_TO_API,
  MCP_TO_API_TYPE,
  RELATED_COLUMNS,
} from './columns.js'
import { normalizeRows, numOrNull, parseIntent, type SemrushRow } from './normalize.js'
import { readOmCache, writeOmCache } from './cache.js'

export interface SemrushFilter {
  field: string
  operation: string
  sign?: '+' | '-'
  value: string | number
}

export interface ListOpts {
  database?: string
  limit?: number
  offset?: number
  sort?: string
  filters?: SemrushFilter[]
  date?: string
}

export interface KeywordOverview {
  keyword: string
  volume: number | null
  cpc: number | null
  competition: number | null
  keywordDifficulty: number | null
  intent: ReturnType<typeof parseIntent>
  results: number | null
  trend: string | null
}

export interface RelatedKeyword extends KeywordOverview {
  relevance: number | null
}

export interface SerpDomainRow {
  domain: string
  url: string | null
  position: number | null
  features: string | null
}

export interface AdsRow {
  domain: string
  url: string | null
  visibleUrl: string | null
}

export interface AdsHistoryRow extends AdsRow {
  date: string | null
  position: number | null
  adTitle: string | null
  adText: string | null
  paidTraffic: number | null
  paidKeywords: number | null
}

export interface DomainKeywordRow extends KeywordOverview {
  position: number | null
  url: string | null
  traffic: number | null
}

export interface DomainOverview {
  domain: string
  rank: number | null
  organicKeywords: number | null
  organicTraffic: number | null
  organicTrafficCost: number | null
  paidKeywords: number | null
  paidTraffic: number | null
  paidTrafficCost: number | null
}

export interface CompetitorRow {
  domain: string
  competitionLevel: number | null
  commonKeywords: number | null
  organicKeywords: number | null
  organicTraffic: number | null
  paidKeywords: number | null
}

export interface BacklinkOverview {
  authorityScore: number | null
  backlinks: number | null
  referringDomains: number | null
}

export interface SemrushClientOptions {
  apiKey: string
  db?: Database
  fetchImpl?: typeof fetch
  live?: boolean
}

export class SemrushUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SemrushUnavailable'
  }
}

export class SemrushClient {
  private readonly apiKey: string
  private readonly db: Database | undefined
  private readonly fetchImpl: typeof fetch
  private readonly live: boolean

  constructor(opts: SemrushClientOptions) {
    this.apiKey = opts.apiKey
    this.db = opts.db
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.live = opts.live !== false
  }

  async keywordOverview(phrase: string, database = 'us'): Promise<KeywordOverview | null> {
    const rows = await this.report('phrase_this', {
      phrase,
      database,
      export_columns: [...KEYWORD_METRIC_COLUMNS],
    }, OM_CACHE_TTL_DAYS.keywordMetrics)
    const row = rows[0]
    return row ? toOverview(row, phrase) : null
  }

  async keywordBatchOverview(phrases: string[], database = 'us'): Promise<KeywordOverview[]> {
    const chunks: string[][] = []
    for (let i = 0; i < phrases.length; i += 100) chunks.push(phrases.slice(i, i + 100))
    const out: KeywordOverview[] = []
    for (const chunk of chunks) {
      const rows = await this.report('phrase_these', {
        phrase: chunk.join(';'),
        database,
        export_columns: [...KEYWORD_METRIC_COLUMNS],
      }, OM_CACHE_TTL_DAYS.keywordMetrics)
      out.push(...rows.map((r) => toOverview(r)))
    }
    return out
  }

  async keywordRelated(phrase: string, opts: ListOpts = {}): Promise<RelatedKeyword[]> {
    const rows = await this.report('phrase_related', {
      phrase,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 50,
      display_offset: opts.offset,
      display_sort: opts.sort ?? 'volume_desc',
      display_filter: opts.filters,
      export_columns: [...RELATED_COLUMNS],
    }, OM_CACHE_TTL_DAYS.keywordMetrics)
    return rows.map((r) => ({ ...toOverview(r), relevance: numOrNull(r['relevance']) }))
  }

  async keywordBroadMatch(phrase: string, opts: ListOpts = {}): Promise<KeywordOverview[]> {
    const rows = await this.report('phrase_fullsearch', {
      phrase,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 50,
      display_offset: opts.offset,
      display_sort: opts.sort ?? 'volume_desc',
      display_filter: opts.filters,
      export_columns: [...KEYWORD_METRIC_COLUMNS],
    }, OM_CACHE_TTL_DAYS.keywordMetrics)
    return rows.map((r) => toOverview(r))
  }

  async keywordQuestions(phrase: string, opts: ListOpts = {}): Promise<KeywordOverview[]> {
    const rows = await this.report('phrase_questions', {
      phrase,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 40,
      display_offset: opts.offset,
      display_sort: opts.sort ?? 'volume_desc',
      export_columns: [...KEYWORD_METRIC_COLUMNS],
    }, OM_CACHE_TTL_DAYS.keywordMetrics)
    return rows.map((r) => toOverview(r))
  }

  async keywordDifficulty(phrases: string[], database = 'us'): Promise<Map<string, number | null>> {
    const map = new Map<string, number | null>()
    for (let i = 0; i < phrases.length; i += 100) {
      const chunk = phrases.slice(i, i + 100)
      const rows = await this.report('phrase_kdi', {
        phrase: chunk.join(';'),
        database,
        export_columns: ['keyword', 'keyword_difficulty'],
      }, OM_CACHE_TTL_DAYS.keywordMetrics)
      for (const r of rows) {
        const kw = String(r['keyword'] ?? '')
        if (kw) map.set(kw.toLowerCase(), numOrNull(r['keyword_difficulty']))
      }
    }
    return map
  }

  async keywordSerp(phrase: string, opts: ListOpts = {}): Promise<SerpDomainRow[]> {
    const rows = await this.report('phrase_organic', {
      phrase,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 20,
      display_date: opts.date,
      export_columns: ['position', 'domain', 'url', 'triggered_serp_features'],
    }, OM_CACHE_TTL_DAYS.serp)
    return rows.map((r, i) => ({
      domain: String(r['domain'] ?? ''),
      url: r['url'] == null ? null : String(r['url']),
      position: numOrNull(r['position']) ?? i + 1,
      features: r['triggered_serp_features'] == null ? null : String(r['triggered_serp_features']),
    })).filter((r) => r.domain)
  }

  async keywordAds(phrase: string, opts: ListOpts = {}): Promise<AdsRow[]> {
    const rows = await this.report('phrase_adwords', {
      phrase,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 20,
      display_date: opts.date,
      export_columns: ['domain', 'url', 'visible_url'],
    }, OM_CACHE_TTL_DAYS.adsHistory)
    return rows.map((r) => ({
      domain: String(r['domain'] ?? ''),
      url: r['url'] == null ? null : String(r['url']),
      visibleUrl: r['visible_url'] == null ? null : String(r['visible_url']),
    })).filter((r) => r.domain)
  }

  async keywordAdsHistory(phrase: string, opts: ListOpts = {}): Promise<AdsHistoryRow[]> {
    const rows = await this.report('phrase_adwords_historical', {
      phrase,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 40,
      export_columns: [
        'domain',
        'date',
        'position',
        'url',
        'ad_title',
        'ad_text',
        'visible_url',
        'paid_traffic',
        'paid_keywords',
      ],
    }, OM_CACHE_TTL_DAYS.adsHistory)
    return rows.map((r) => ({
      domain: String(r['domain'] ?? ''),
      url: r['url'] == null ? null : String(r['url']),
      visibleUrl: r['visible_url'] == null ? null : String(r['visible_url']),
      date: r['date'] == null ? null : String(r['date']),
      position: numOrNull(r['position']),
      adTitle: r['ad_title'] == null ? null : String(r['ad_title']),
      adText: r['ad_text'] == null ? null : String(r['ad_text']),
      paidTraffic: numOrNull(r['paid_traffic']),
      paidKeywords: numOrNull(r['paid_keywords']),
    })).filter((r) => r.domain)
  }

  async domainOrganicKeywords(domain: string, opts: ListOpts = {}): Promise<DomainKeywordRow[]> {
    const rows = await this.report('resource_organic', {
      target: domain,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 50,
      display_offset: opts.offset,
      display_sort: opts.sort ?? 'traffic_desc',
      display_filter: opts.filters,
      export_columns: [
        'keyword',
        'position',
        'volume',
        'cpc',
        'url',
        'traffic',
        'intent',
        'keyword_difficulty',
        'trend',
        'competitive_density',
      ],
    }, OM_CACHE_TTL_DAYS.keywordMetrics)
    return rows.map((r) => ({
      ...toOverview(r),
      position: numOrNull(r['position']),
      url: r['url'] == null ? null : String(r['url']),
      traffic: numOrNull(r['traffic']),
    }))
  }

  async domainPaidKeywords(domain: string, opts: ListOpts = {}): Promise<DomainKeywordRow[]> {
    const rows = await this.report('resource_adwords', {
      target: domain,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 50,
      display_sort: opts.sort ?? 'traffic_desc',
      export_columns: ['keyword', 'position', 'volume', 'cpc', 'url', 'traffic', 'ad_title', 'ad_text', 'trend'],
    }, OM_CACHE_TTL_DAYS.adsHistory)
    return rows.map((r) => ({
      ...toOverview(r),
      position: numOrNull(r['position']),
      url: r['url'] == null ? null : String(r['url']),
      traffic: numOrNull(r['traffic']),
    }))
  }

  async domainOverview(domain: string, database = 'us'): Promise<DomainOverview | null> {
    const rows = await this.report('domain_rank', {
      target: domain,
      database,
      export_columns: [
        'domain',
        'rank',
        'organic_keywords',
        'organic_traffic',
        'organic_traffic_cost',
        'paid_keywords',
        'paid_traffic',
        'paid_traffic_cost',
      ],
    }, OM_CACHE_TTL_DAYS.domainOverview)
    const r = rows[0]
    if (!r) return null
    return {
      domain: String(r['domain'] ?? domain),
      rank: numOrNull(r['rank']),
      organicKeywords: numOrNull(r['organic_keywords']),
      organicTraffic: numOrNull(r['organic_traffic']),
      organicTrafficCost: numOrNull(r['organic_traffic_cost']),
      paidKeywords: numOrNull(r['paid_keywords']),
      paidTraffic: numOrNull(r['paid_traffic']),
      paidTrafficCost: numOrNull(r['paid_traffic_cost']),
    }
  }

  async domainOrganicCompetitors(domain: string, opts: ListOpts = {}): Promise<CompetitorRow[]> {
    const rows = await this.report('domain_organic_organic', {
      domain,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 20,
    }, OM_CACHE_TTL_DAYS.domainOverview)
    return rows.map((r) => ({
      domain: String(r['domain'] ?? ''),
      competitionLevel: numOrNull(r['competition_level']),
      commonKeywords: numOrNull(r['common_keywords']),
      organicKeywords: numOrNull(r['organic_keywords']),
      organicTraffic: numOrNull(r['organic_traffic']),
      paidKeywords: numOrNull(r['paid_keywords']),
    })).filter((r) => r.domain)
  }

  async domainPaidCompetitors(domain: string, opts: ListOpts = {}): Promise<CompetitorRow[]> {
    const rows = await this.report('domain_adwords_adwords', {
      domain,
      database: opts.database ?? 'us',
      display_limit: opts.limit ?? 20,
    }, OM_CACHE_TTL_DAYS.adsHistory)
    return rows.map((r) => ({
      domain: String(r['domain'] ?? ''),
      competitionLevel: numOrNull(r['competition_level']),
      commonKeywords: numOrNull(r['common_keywords']),
      organicKeywords: numOrNull(r['organic_keywords']),
      organicTraffic: numOrNull(r['organic_traffic']),
      paidKeywords: numOrNull(r['paid_keywords']),
    })).filter((r) => r.domain)
  }

  async referringDomains(
    domain: string,
    limit = 40,
  ): Promise<Array<{ domain: string; authorityScore: number | null; backlinks: number | null }>> {
    const rows = await this.report(
      'backlinks_refdomains',
      {
        target: domain,
        target_type: 'root_domain',
        export_columns: ['domain', 'domain_ascore', 'backlinks_num'],
        display_limit: limit,
      },
      OM_CACHE_TTL_DAYS.backlinks,
    )
    return rows
      .map((r) => ({
        domain: String(r['domain'] ?? '').toLowerCase(),
        authorityScore: numOrNull(r['domain_ascore'] ?? r['authority_score'] ?? r['ascore']),
        backlinks: numOrNull(r['backlinks_num'] ?? r['backlinks']),
      }))
      .filter((row) => row.domain)
  }

  async domainBacklinks(domain: string): Promise<BacklinkOverview | null> {
    const rows = await this.report('backlinks_overview', {
      target: domain,
      target_type: 'root_domain',
      export_columns: ['authority_score', 'total', 'domains_num'],
    }, OM_CACHE_TTL_DAYS.backlinks)
    const r = rows[0]
    if (!r) return null
    return {
      authorityScore: numOrNull(r['authority_score'] ?? r['ascore'] ?? r['score']),
      backlinks: numOrNull(r['total']),
      referringDomains: numOrNull(r['domains_num'] ?? r['referring_domains']),
    }
  }

  /**
   * Ingest a harvested MCP / CSV payload without hitting the network.
   * Used when the agent ran execute_report and we persist the evidence.
   */
  async ingestHarvest(report: string, params: Record<string, unknown>, payload: unknown): Promise<SemrushRow[]> {
    const rows = normalizeRows(payload)
    if (this.db) {
      await writeOmCache(this.db, {
        cacheKey: cacheKey(report, params),
        report,
        payload: rows,
        ttlDays: ttlForReport(report),
      })
    }
    return rows
  }

  private async report(
    mcpReport: string,
    params: Record<string, unknown>,
    ttlDays: number,
  ): Promise<SemrushRow[]> {
    const key = cacheKey(mcpReport, params)
    if (this.db) {
      const hit = await readOmCache(this.db, key)
      if (hit) return normalizeRows(hit)
    }
    if (!this.live) {
      throw new SemrushUnavailable(`Semrush live calls disabled; cache miss for ${mcpReport}`)
    }
    const rows = await this.fetchReport(mcpReport, params)
    if (this.db) {
      await writeOmCache(this.db, { cacheKey: key, report: mcpReport, payload: rows, ttlDays })
    }
    return rows
  }

  private async fetchReport(mcpReport: string, params: Record<string, unknown>): Promise<SemrushRow[]> {
    const apiType = MCP_TO_API_TYPE[mcpReport]
    if (!apiType) throw new SemrushUnavailable(`Unmapped Semrush report: ${mcpReport}`)

    const url = new URL(
      apiType === 'backlinks_overview' || apiType === 'backlinks_refdomains'
        ? 'https://api.semrush.com/analytics/v1/'
        : 'https://api.semrush.com/',
    )
    url.searchParams.set('key', this.apiKey)
    url.searchParams.set('type', apiType)
    url.searchParams.set('export_escape', '1')

    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      if (k === 'export_columns' && Array.isArray(v)) {
        url.searchParams.set('export_columns', v.map((name) => FRIENDLY_TO_CODE[String(name)] ?? String(name)).join(','))
        continue
      }
      if (k === 'display_sort' && typeof v === 'string') {
        url.searchParams.set('display_sort', MCP_SORT_TO_API[v] ?? v)
        continue
      }
      if (k === 'display_filter' && Array.isArray(v)) {
        const encoded = (v as SemrushFilter[])
          .map((f) => {
            const field = FRIENDLY_TO_CODE[f.field] ?? f.field
            const op = FILTER_OP_TO_API[f.operation] ?? f.operation
            return `${f.sign ?? '+'}|${field}|${op}|${f.value}`
          })
          .join('|')
        if (encoded) url.searchParams.set('display_filter', encoded)
        continue
      }
      url.searchParams.set(k, String(v))
    }

    const res = await this.fetchImpl(url.toString(), { headers: { Accept: 'text/plain' } })
    const text = await res.text()
    if (!res.ok) {
      throw new SemrushUnavailable(`Semrush HTTP ${res.status} for ${mcpReport}: ${text.slice(0, 200)}`)
    }
    if (/ERROR\s+\d+/i.test(text) || text.startsWith('ERROR')) {
      throw new SemrushUnavailable(`Semrush ${mcpReport}: ${text.slice(0, 240)}`)
    }
    return normalizeRows(text)
  }
}

export function semrushApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env['SEMRUSH_API_KEY']?.trim() || null
}

export function createSemrushClient(db: Database | undefined, env: NodeJS.ProcessEnv = process.env, live = true): SemrushClient {
  const key = semrushApiKey(env)
  if (!key) throw new SemrushUnavailable('SEMRUSH_API_KEY is not set')
  return new SemrushClient({ apiKey: key, ...(db ? { db } : {}), live })
}

function toOverview(row: SemrushRow, fallbackKeyword?: string): KeywordOverview {
  return {
    keyword: String(row['keyword'] ?? fallbackKeyword ?? ''),
    volume: numOrNull(row['volume']),
    cpc: numOrNull(row['cpc']),
    competition: numOrNull(row['competitive_density'] ?? row['competition']),
    keywordDifficulty: numOrNull(row['keyword_difficulty']),
    intent: parseIntent(row['intent']),
    results: numOrNull(row['results']),
    trend: row['trend'] == null ? null : String(row['trend']),
  }
}

function cacheKey(report: string, params: Record<string, unknown>): string {
  const stable = JSON.stringify({ report, params }, Object.keys({ report, params }).sort())
  return createHash('sha256').update(JSON.stringify({ report, params: sortKeys(params) })).update(stable.length.toString()).digest('hex')
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
}

function ttlForReport(report: string): number {
  if (report.includes('organic') && report.startsWith('phrase')) return OM_CACHE_TTL_DAYS.serp
  if (report.includes('adwords')) return OM_CACHE_TTL_DAYS.adsHistory
  if (report.includes('backlink')) return OM_CACHE_TTL_DAYS.backlinks
  if (report.includes('rank') || report.includes('domain')) return OM_CACHE_TTL_DAYS.domainOverview
  return OM_CACHE_TTL_DAYS.keywordMetrics
}
