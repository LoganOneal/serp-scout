import 'server-only'
import {
  FixtureHhtOppSearchProvider,
  HHT_OPP_DISCOVERY_DEFAULTS,
  type SearchHit,
  type SearchProvider,
} from '@rnr/core'
import { DataForSeoClient } from '../providers/dataforseo/client.js'
import { fetchOrganicSerp } from '../providers/dataforseo/serp.js'
import { liveCallsEnabled, type EnvLike } from '../providers/index.js'
import { createSemrushClient, semrushApiKey, type SemrushClient } from '../opportunity-miner/semrush/client.js'

const US_LOCATION_CODE = 2840

/**
 * Opportunity search prefers Semrush phrase_organic (same reports as the
 * Semrush MCP). DataForSEO is an optional fallback only. Fixture mode is the
 * labeled HHT catalog — never generic local-service SERPs.
 */
export function createHhtOppSearchProvider(
  env: EnvLike = process.env,
  opts: { fixture?: boolean } = {},
): SearchProvider {
  if (opts.fixture) return new FixtureHhtOppSearchProvider()
  if (semrushApiKey(env as NodeJS.ProcessEnv)) {
    return new SemrushHhtOppSearchProvider(createSemrushClient(undefined, env as NodeJS.ProcessEnv, true))
  }
  if (liveCallsEnabled(env) && env['DATAFORSEO_LOGIN'] && env['DATAFORSEO_PASSWORD']) {
    const timeoutMs = process.env['VERCEL'] ? 45_000 : 120_000
    return new DataForSeoHhtOppSearchProvider(
      new DataForSeoClient({
        credentials: { login: env['DATAFORSEO_LOGIN'], password: env['DATAFORSEO_PASSWORD'] },
        timeoutMs,
      }),
    )
  }
  return new FixtureHhtOppSearchProvider()
}

/** Semrush keyword DB does not use Google operators. Keep the meaning, drop the syntax. */
export function semrushPhrase(query: string): string {
  return query
    .replaceAll('"', ' ')
    .replace(/\bsite:\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

class SemrushHhtOppSearchProvider implements SearchProvider {
  readonly id = 'semrush'
  readonly live = true

  constructor(private readonly client: SemrushClient) {}

  async search(query: string, limit: number = HHT_OPP_DISCOVERY_DEFAULTS.hitsPerQuery): Promise<SearchHit[]> {
    const phrase = semrushPhrase(query)
    if (!phrase) return []
    const rows = await this.client.keywordSerp(phrase, { database: 'us', limit })
    return rows
      .filter((row) => row.url)
      .slice(0, limit)
      .map((row) => ({
        url: row.url!,
        title: null,
        snippet: null,
        domain: row.domain || null,
      }))
  }

  async searchSite(domain: string, query: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`${query} ${domain}`, limit)
  }

  async searchMentions(term: string, limit?: number): Promise<SearchHit[]> {
    return this.search(term, limit)
  }

  async searchRelated(domain: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`${domain} travel blog`, limit)
  }
}

class DataForSeoHhtOppSearchProvider implements SearchProvider {
  readonly id = 'dataforseo'
  readonly live = true

  constructor(private readonly client: DataForSeoClient) {}

  async search(query: string, limit: number = HHT_OPP_DISCOVERY_DEFAULTS.hitsPerQuery): Promise<SearchHit[]> {
    const snapshot = await fetchOrganicSerp(this.client, {
      keyword: query,
      locationCode: US_LOCATION_CODE,
      depth: Math.max(10, limit),
    })
    return snapshot.items.slice(0, limit).map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.description,
      domain: item.domain,
    }))
  }

  async searchSite(domain: string, query: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`site:${domain} ${query}`, limit)
  }

  async searchMentions(term: string, limit?: number): Promise<SearchHit[]> {
    return this.search(term, limit)
  }

  async searchRelated(domain: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`related:${domain} travel publication`, limit)
  }
}
